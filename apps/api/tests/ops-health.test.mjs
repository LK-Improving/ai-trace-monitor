import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { GUARDS_METADATA } = require('@nestjs/common/constants');
const { AdminTokenGuard } = require('../dist/admin/admin-token.guard.js');
const { ClickHouseService } = require('../dist/overview/clickhouse.service.js');
const { QueryLatencyWindow } = require('../dist/overview/query-latency-window.js');
const {
  OpsHealthService,
  buildKafkaOffsetSnapshot,
  calculatePartitionLags,
} = require('../dist/ops/ops-health.service.js');
const { OpsHealthController } = require('../dist/ops/ops-health.controller.js');
const { DatabaseService, HEALTH_PROBE_POOL_OPTIONS } = require('../dist/database/database.service.js');
const { Kafka } = require('kafkajs');

function configuration(overrides = {}) {
  const values = {
    KAFKA_TOPIC: 'ai-spans',
    KAFKA_GROUP_ID: 'trace-ops-collector',
    KAFKA_BROKERS: '127.0.0.1:9092',
    ...overrides,
  };
  return { get: (name) => values[name] };
}

function queueMetrics() {
  return {
    producerState: 'idle', topic: 'ai-spans', queueDepth: 2, queueBytes: 64,
    maxQueueSpans: 5000, maxQueueBytes: 10000, acceptedSpans: 11,
    publishedSpans: 8, droppedSpans: 3, publishErrorCount: 2,
    retryCount: 1, rejectedBatchCount: 1,
  };
}

function collectorPayload(overrides = {}) {
  return {
    status: 'running', topic: 'ai-spans', consumerGroup: 'trace-ops-collector',
    uptimeSeconds: 125, processedMessages: 110, insertedSpans: 108,
    invalidMessages: 1, failedBatches: 2, clickhouseWriteFailures: 1,
    committedBatches: 20, lastCommitAt: '2026-10-03T02:00:00.000Z',
    lastClickHouseWriteAt: '2026-10-03T02:00:01.000Z',
    ...overrides,
  };
}

function makeService(getQueueMetrics = queueMetrics) {
  const database = { ping: async () => undefined };
  const queue = { metrics: getQueueMetrics };
  const clickhouse = {
    ping: async () => true,
    queryLatencySnapshot: () => ({
      windowSeconds: 300, sampleCount: 0, errorCount: 0,
      p50Ms: null, p95Ms: null, p99Ms: null,
    }),
  };
  return new OpsHealthService(configuration(), database, queue, clickhouse);
}

function stubHealthyDependencies(service, except) {
  if (except !== 'postgres') {
    service.probePostgres = async () => ({ status: 'healthy', latencyMs: 1 });
  }
  if (except !== 'kafka') {
    service.probeKafka = async () => ({
      status: 'healthy', topic: 'ai-spans', consumerGroup: 'trace-ops-collector',
      totalLag: 0, partitions: [],
    });
  }
  if (except !== 'collector') {
    service.probeCollector = async () => ({ status: 'running' });
  }
  if (except !== 'clickhouse') {
    service.probeClickHouse = async () => ({
      status: 'healthy', pingLatencyMs: 1,
      queryLatency: { windowSeconds: 300, sampleCount: 0, errorCount: 0, p50Ms: null, p95Ms: null, p99Ms: null },
    });
  }
}

test('ops health is admin-protected and returns only the exact operational projection', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.method, 'GET');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify(collectorPayload()), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };

  const controller = new OpsHealthController({ check: async () => ({ status: 'healthy' }) });
  assert.ok(Reflect.getMetadata(GUARDS_METADATA, OpsHealthController).includes(AdminTokenGuard));
  assert.equal(await controller.check().then(({ status }) => status), 'healthy');

  const service = makeService();
  service.probeKafka = async () => ({
    status: 'healthy', topic: 'ai-spans', consumerGroup: 'trace-ops-collector',
    totalLag: 10, partitions: [{ partition: 0, lag: 10 }],
  });
  const snapshot = await service.check();
  assert.deepEqual(Object.keys(snapshot), [
    'status', 'checkedAt', 'processUptimeSeconds', 'postgres', 'kafka', 'collector', 'clickhouse', 'spanQueue',
  ]);
  assert.equal(snapshot.status, 'healthy');
  assert.ok(Number.isFinite(Date.parse(snapshot.checkedAt)));
  assert.ok(Number.isFinite(snapshot.processUptimeSeconds));
  assert.deepEqual(Object.keys(snapshot.postgres), ['status', 'latencyMs']);
  assert.deepEqual(snapshot.postgres.status, 'healthy');
  assert.deepEqual(Object.keys(snapshot.kafka), ['status', 'topic', 'consumerGroup', 'totalLag', 'partitions']);
  assert.equal(snapshot.kafka.totalLag, 10, 'positive lag is visible but does not mark a reachable broker degraded');
  assert.deepEqual(Object.keys(snapshot.collector), [
    'status', 'topic', 'consumerGroup', 'uptimeSeconds', 'processedMessages', 'insertedSpans',
    'invalidMessages', 'failedBatches', 'clickhouseWriteFailures', 'committedBatches',
    'lastCommitAt', 'lastClickHouseWriteAt',
  ]);
  assert.deepEqual(Object.keys(snapshot.clickhouse), ['status', 'pingLatencyMs', 'queryLatency']);
  assert.deepEqual(Object.keys(snapshot.clickhouse.queryLatency), [
    'windowSeconds', 'sampleCount', 'errorCount', 'p50Ms', 'p95Ms', 'p99Ms',
  ]);
  assert.equal(snapshot.clickhouse.queryLatency.windowSeconds, 300);
  assert.deepEqual(Object.keys(snapshot.spanQueue), [
    'producerState', 'depth', 'capacity', 'queueBytes', 'maxQueueBytes',
    'accepted', 'published', 'dropped', 'publishErrors', 'retries',
  ]);
  assert.equal(snapshot.spanQueue.queueBytes, 64);
  assert.equal(snapshot.spanQueue.maxQueueBytes, 10000);
  assert.equal(snapshot.spanQueue.capacity, 5000);
  assert.doesNotMatch(JSON.stringify(snapshot), /password|authorization|token|secret|sql|queryText|payload|rawError/i);
  await service.onModuleDestroy();
});

test('span queue byte occupancy is exposed independently of span-count capacity', async () => {
  const metrics = {
    ...queueMetrics(),
    queueDepth: 2,
    maxQueueSpans: 5000,
    queueBytes: 9999,
    maxQueueBytes: 10000,
  };
  const service = makeService(() => metrics);
  service.probePostgres = async () => ({ status: 'healthy' });
  service.probeKafka = async () => ({ status: 'healthy' });
  service.probeCollector = async () => ({ status: 'running' });
  service.probeClickHouse = async () => ({ status: 'healthy' });

  let snapshot = await service.check();
  assert.equal(snapshot.spanQueue.queueBytes, 9999, 'near-cap byte occupancy is reported exactly');
  assert.equal(snapshot.spanQueue.maxQueueBytes, 10000);
  assert.equal(snapshot.spanQueue.depth, 2);
  assert.equal(snapshot.spanQueue.capacity, 5000);
  assert.ok(snapshot.spanQueue.depth < snapshot.spanQueue.capacity);

  metrics.queueBytes = metrics.maxQueueBytes;
  snapshot = await service.check();
  assert.equal(snapshot.spanQueue.queueBytes, 10000, 'byte occupancy may reach the configured cap');
  assert.equal(snapshot.spanQueue.maxQueueBytes, 10000);
  assert.equal(snapshot.spanQueue.depth, 2);
  assert.equal(snapshot.spanQueue.capacity, 5000);
  assert.ok(snapshot.spanQueue.depth < snapshot.spanQueue.capacity);
  await service.onModuleDestroy();
});

test('snapshot isolates rejected and timed-out Postgres probes and recovers', async () => {
  const service = makeService();
  stubHealthyDependencies(service, 'postgres');
  let mode = 'reject';
  service.database.ping = () => {
    if (mode === 'reject') return Promise.reject(new Error('POSTGRES_CANARY'));
    if (mode === 'timeout') return new Promise(() => {});
    return Promise.resolve();
  };

  for (const failureMode of ['reject', 'timeout']) {
    mode = failureMode;
    const snapshot = await service.check();
    assert.equal(snapshot.postgres.status, 'unavailable');
    assert.equal(snapshot.postgres.latencyMs, null);
    assert.notEqual(snapshot.status, 'healthy');
    assert.doesNotMatch(JSON.stringify(snapshot), /POSTGRES_CANARY/);

    mode = 'healthy';
    const recovered = await service.check();
    assert.equal(recovered.postgres.status, 'healthy');
    assert.equal(recovered.status, 'healthy');
  }
  await service.onModuleDestroy();
});

test('snapshot isolates Kafka connect/admin failures and recovers after snapshot cache expiry', async (t) => {
  const originalAdmin = Kafka.prototype.admin;
  t.after(() => { Kafka.prototype.admin = originalAdmin; });
  let mode = 'connect-error';
  Kafka.prototype.admin = () => ({
    connect: async () => {
      if (mode === 'connect-error') throw new Error('KAFKA_CONNECT_CANARY');
    },
    fetchTopicOffsets: async () => {
      if (mode === 'admin-error') throw new Error('KAFKA_ADMIN_CANARY');
      return [{ partition: 0, high: '100', low: '0' }];
    },
    fetchOffsets: async () => [{
      topic: 'ai-spans', partitions: [{ partition: 0, offset: '100', metadata: null }],
    }],
    disconnect: async () => undefined,
  });

  const service = makeService();
  stubHealthyDependencies(service, 'kafka');
  for (const [failureMode, canary] of [
    ['connect-error', 'KAFKA_CONNECT_CANARY'],
    ['admin-error', 'KAFKA_ADMIN_CANARY'],
  ]) {
    mode = failureMode;
    const snapshot = await service.check();
    assert.ok(['unavailable', 'degraded'].includes(snapshot.kafka.status));
    assert.notEqual(snapshot.status, 'healthy');
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(canary));
    await new Promise((resolve) => setTimeout(resolve, 1010));
  }

  mode = 'healthy';
  const recovered = await service.check();
  assert.equal(recovered.kafka.status, 'healthy');
  assert.equal(recovered.status, 'healthy');
  await service.onModuleDestroy();
});

test('snapshot isolates false and timed-out ClickHouse pings and recovers', async () => {
  const service = makeService();
  stubHealthyDependencies(service, 'clickhouse');
  let mode = 'false';
  service.clickhouse.ping = async () => {
    if (mode === 'false') return false;
    if (mode === 'reject') throw new Error('CLICKHOUSE_CANARY');
    if (mode === 'timeout') return new Promise(() => {});
    return true;
  };

  for (const failureMode of ['false', 'reject', 'timeout']) {
    mode = failureMode;
    const snapshot = await service.check();
    assert.equal(snapshot.clickhouse.status, 'unavailable');
    assert.equal(snapshot.clickhouse.pingLatencyMs, null);
    assert.notEqual(snapshot.status, 'healthy');
    assert.doesNotMatch(JSON.stringify(snapshot), /CLICKHOUSE_CANARY/);

    mode = 'healthy';
    const recovered = await service.check();
    assert.equal(recovered.clickhouse.status, 'healthy');
    assert.equal(recovered.status, 'healthy');
  }
  await service.onModuleDestroy();
});

test('collector payload is exact-schema validated and an unavailable source produces null counters', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const service = makeService();
  globalThis.fetch = async () => new Response(JSON.stringify(collectorPayload({ unexpected: 'private' })), { status: 200 });
  const invalid = await service.probeCollector();
  assert.equal(invalid.status, 'unavailable');
  assert.equal(invalid.processedMessages, null);
  assert.equal(invalid.insertedSpans, null);
  assert.equal(invalid.lastCommitAt, null);

  globalThis.fetch = async () => { throw new Error('private collector failure'); };
  const unavailable = await service.probeCollector();
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.topic, 'ai-spans');
  assert.equal(unavailable.consumerGroup, 'trace-ops-collector');
  assert.equal(unavailable.failedBatches, null);
  await service.onModuleDestroy();
});

test('collector request timeout aborts and maps unavailable measurements to null', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const service = makeService();
  const result = await service.probeCollector();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.uptimeSeconds, null);
  assert.equal(result.committedBatches, null);
  await service.onModuleDestroy();
});

test('Kafka lag preserves unknown and inverted offsets; positive lag remains healthy', () => {
  assert.deepEqual(calculatePartitionLags(
    [
      { partition: 1, high: '30' }, { partition: 0, high: '12' },
      { partition: 2, high: '40' }, { partition: 3, high: '7' },
    ],
    [
      { partition: 0, offset: '10' }, { partition: 1, offset: '-1' },
      { partition: 2, offset: '50' }, { partition: 3, offset: '-2' },
    ],
  ), [
    { partition: 0, lag: 2 },
    { partition: 1, lag: 30 },
    { partition: 2, lag: null },
    { partition: 3, lag: null },
  ]);
  assert.deepEqual(calculatePartitionLags([
    { partition: 0, high: '50' }, { partition: 1, high: '30' },
  ], []), [
    { partition: 0, lag: 50 }, { partition: 1, lag: 30 },
  ], 'a successful offsets lookup with no committed entries uses the start-of-log baseline');
  assert.deepEqual(calculatePartitionLags([{ partition: 0, high: '50' }], [], false), [
    { partition: 0, lag: null },
  ], 'an unavailable committed-offset lookup must not be treated as a new group');
  assert.deepEqual(buildKafkaOffsetSnapshot('ai-spans', 'trace-ops-collector', [
    { partition: 0, high: '50' }, { partition: 1, high: '30' },
  ], [
    { partition: 0, offset: '40' }, { partition: 1, offset: '20' },
  ]), {
    status: 'healthy', topic: 'ai-spans', consumerGroup: 'trace-ops-collector',
    totalLag: 20, partitions: [{ partition: 0, lag: 10 }, { partition: 1, lag: 10 }],
  });
  const newGroupSnapshot = buildKafkaOffsetSnapshot('ai-spans', 'trace-ops-collector', [
    { partition: 0, high: '50' },
  ], []);
  assert.deepEqual(newGroupSnapshot, {
    status: 'healthy', topic: 'ai-spans', consumerGroup: 'trace-ops-collector',
    totalLag: 50, partitions: [{ partition: 0, lag: 50 }],
  });
  assert.deepEqual(buildKafkaOffsetSnapshot('ai-spans', 'trace-ops-collector', [], []), {
    status: 'degraded', topic: 'ai-spans', consumerGroup: 'trace-ops-collector',
    totalLag: null, partitions: [],
  });
});

test('Kafka committed-offset probe failure leaves partition lag unknown', async (t) => {
  const originalAdmin = Kafka.prototype.admin;
  t.after(() => { Kafka.prototype.admin = originalAdmin; });
  Kafka.prototype.admin = () => ({
    connect: async () => undefined,
    fetchTopicOffsets: async () => [{ partition: 0, high: '50', low: '0' }],
    fetchOffsets: async () => { throw new Error('private kafka error'); },
    disconnect: async () => undefined,
  });
  const service = makeService();
  const result = await service.probeKafka();
  assert.equal(result.status, 'degraded');
  assert.equal(result.totalLag, null);
  assert.deepEqual(result.partitions, [{ partition: 0, lag: null }]);
  await service.onModuleDestroy();
});

test('Kafka admin is a singleton and overlapping health checks share a bounded cached snapshot', async (t) => {
  let adminInstances = 0;
  let connects = 0;
  let topicFetches = 0;
  let groupFetches = 0;
  let activeFetches = 0;
  let maximumActiveFetches = 0;
  let disconnects = 0;
  const originalAdmin = Kafka.prototype.admin;
  t.after(() => { Kafka.prototype.admin = originalAdmin; });
  Kafka.prototype.admin = function () {
    adminInstances += 1;
    return {
      connect: async () => { connects += 1; },
      fetchTopicOffsets: async (topic) => {
        assert.equal(topic, 'ai-spans');
        topicFetches += 1;
        activeFetches += 1;
        maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
        await new Promise((resolve) => setTimeout(resolve, 15));
        activeFetches -= 1;
        return [{ partition: 0, high: '50', low: '0' }];
      },
      fetchOffsets: async (input) => {
        assert.deepEqual(input, { groupId: 'trace-ops-collector', topics: ['ai-spans'], resolveOffsets: false });
        groupFetches += 1;
        activeFetches += 1;
        maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
        await new Promise((resolve) => setTimeout(resolve, 15));
        activeFetches -= 1;
        return [{ topic: 'ai-spans', partitions: [{ partition: 0, offset: '40', metadata: null }] }];
      },
      disconnect: async () => { disconnects += 1; },
    };
  };

  const service = makeService();
  const [first, coalesced] = await Promise.all([service.probeKafka(), service.probeKafka()]);
  assert.deepEqual(first, coalesced);
  assert.equal(first.status, 'healthy');
  assert.equal(first.totalLag, 10);
  assert.equal(adminInstances, 1);
  assert.equal(connects, 1);
  assert.equal(topicFetches, 1);
  assert.equal(groupFetches, 1);
  assert.equal(maximumActiveFetches, 2, 'end and committed offsets are fetched in parallel');
  assert.deepEqual(await service.probeKafka(), first, 'short cache avoids duplicate Kafka calls');
  assert.equal(topicFetches, 1);
  await service.onModuleDestroy();
  assert.equal(disconnects, 1);
});

test('ClickHouse query latency is rolling, bounded, includes failures, and excludes ping', async () => {
  let now = 0;
  const window = new QueryLatencyWindow(() => now, 3);
  window.record(10, false);
  window.record(20, true);
  window.record(30, false);
  window.record(40, true);
  assert.deepEqual(window.snapshot(), {
    windowSeconds: 300, sampleCount: 3, errorCount: 2,
    p50Ms: 30, p95Ms: 40, p99Ms: 40,
  });
  now = 300_001;
  assert.deepEqual(window.snapshot(), {
    windowSeconds: 300, sampleCount: 0, errorCount: 0,
    p50Ms: null, p95Ms: null, p99Ms: null,
  });

  const service = new ClickHouseService({ get: () => undefined });
  service.client = {
    query: async ({ query }) => {
      if (query === 'FAIL') throw new Error('secret query payload');
      return { json: async () => [{ ok: 1 }] };
    },
    ping: async ({ select, abort_signal }) => {
      assert.equal(select, true);
      assert.ok(abort_signal instanceof AbortSignal);
      return { success: true };
    },
    close: async () => undefined,
  };
  await service.query('SELECT 1', {});
  await assert.rejects(service.query('FAIL', {}), /Analytics query failed/);
  assert.equal(await service.ping(20), true);
  const snapshot = service.queryLatencySnapshot();
  assert.equal(snapshot.sampleCount, 2);
  assert.equal(snapshot.errorCount, 1);
  await service.onModuleDestroy();
});

test('ClickHouse ping has an abort deadline and is not exposed as a query error', async () => {
  const service = new ClickHouseService({ get: () => undefined });
  service.client = {
    ping: ({ abort_signal }) => new Promise((resolve) => {
      abort_signal.addEventListener('abort', () => resolve({ success: false }), { once: true });
    }),
    close: async () => undefined,
  };
  assert.equal(await service.ping(5), false);
  assert.deepEqual(service.queryLatencySnapshot(), {
    windowSeconds: 300, sampleCount: 0, errorCount: 0,
    p50Ms: null, p95Ms: null, p99Ms: null,
  });
  await service.onModuleDestroy();
});

test('DatabaseService isolates bounded health ping from the business pool', async () => {
  const service = new DatabaseService({ get: () => undefined });
  const businessPool = service.pool;
  let query = '';
  let businessQueries = 0;
  let endedPools = 0;
  service.pool = {
    query: async () => { businessQueries += 1; throw new Error('business pool must not be used for health'); },
    end: async () => { endedPools += 1; },
  };
  service.healthPool = {
    query: async (value) => { query = value; },
    end: async () => { endedPools += 1; },
  };
  assert.notEqual(service.healthPool, businessPool);
  assert.deepEqual(HEALTH_PROBE_POOL_OPTIONS, {
    max: 1, connectionTimeoutMillis: 1200, query_timeout: 1200,
    statement_timeout: 1200, application_name: 'trace-ops-health-probe',
  });
  await service.ping();
  assert.equal(query, 'SELECT 1');
  assert.equal(businessQueries, 0);
  await service.onModuleDestroy();
  assert.equal(endedPools, 2);
});

test('DatabaseService consumes idle pool errors without retaining or exposing the raw Error', async () => {
  const service = new DatabaseService({ get: () => undefined });
  const canary = new Error('DATABASE_POOL_CANARY');
  for (const pool of [service.pool, service.healthPool]) {
    assert.ok(pool.listenerCount('error') > 0, 'each pool has an idle-client error listener');
    let received = false;
    pool.on('error', () => { received = true; });
    assert.doesNotThrow(() => {
      assert.equal(pool.emit('error', canary), true);
    });
    assert.equal(received, true, 'the pool error event is delivered to its listeners');
  }

  service.ping = async () => undefined;
  const health = new OpsHealthService(
    configuration(),
    service,
    { metrics: queueMetrics },
    {
      ping: async () => true,
      queryLatencySnapshot: () => ({
        windowSeconds: 300, sampleCount: 0, errorCount: 0,
        p50Ms: null, p95Ms: null, p99Ms: null,
      }),
    },
  );
  stubHealthyDependencies(health, 'postgres');
  const snapshot = await health.check();
  assert.doesNotMatch(JSON.stringify(snapshot), /DATABASE_POOL_CANARY/);
  await health.onModuleDestroy();
  await service.onModuleDestroy();
});
