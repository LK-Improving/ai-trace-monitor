const assert = require('node:assert/strict');

const portValue = process.env.API_PORT ?? '3001';
assert.match(portValue, /^\d{1,5}$/);
const port = Number(portValue);
assert.ok(port > 0 && port <= 65535, 'API_PORT must be a valid local port');
const adminToken = process.env.PLATFORM_ADMIN_TOKEN;
assert.ok(typeof adminToken === 'string' && adminToken.length > 0, 'PLATFORM_ADMIN_TOKEN must be configured');
const requestCount = Number(process.env.OPS_HEALTH_PROBE_COUNT ?? 40);
const concurrency = Number(process.env.OPS_HEALTH_PROBE_CONCURRENCY ?? 4);
assert.ok(Number.isSafeInteger(requestCount) && requestCount >= 1 && requestCount <= 200, 'OPS_HEALTH_PROBE_COUNT must be 1-200');
assert.ok(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 20, 'OPS_HEALTH_PROBE_CONCURRENCY must be 1-20');
assert.ok(concurrency <= requestCount, 'probe concurrency cannot exceed request count');

const origin = `http://127.0.0.1:${port}`;
const endpoint = `${origin}/api/v1/ops/health`;
function isStatus(value, allowed) {
  return typeof value === 'string' && allowed.includes(value);
}

function isNullableNumber(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function validateSnapshot(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.ok(isStatus(value.status, ['healthy', 'degraded', 'unavailable']));
  assert.ok(typeof value.checkedAt === 'string' && Number.isFinite(Date.parse(value.checkedAt)));
  assert.ok(Number.isFinite(value.processUptimeSeconds) && value.processUptimeSeconds >= 0);

  assert.ok(value.postgres && typeof value.postgres === 'object');
  assert.ok(isStatus(value.postgres.status, ['healthy', 'unavailable']));
  assert.ok(isNullableNumber(value.postgres.latencyMs));

  assert.ok(value.kafka && typeof value.kafka === 'object');
  assert.ok(isStatus(value.kafka.status, ['healthy', 'degraded', 'unavailable']));
  assert.ok(typeof value.kafka.topic === 'string' && value.kafka.topic.length > 0);
  assert.ok(typeof value.kafka.consumerGroup === 'string' && value.kafka.consumerGroup.length > 0);
  assert.ok(isNullableNumber(value.kafka.totalLag));
  assert.ok(Array.isArray(value.kafka.partitions));
  for (const partition of value.kafka.partitions) {
    assert.ok(Number.isSafeInteger(partition.partition) && partition.partition >= 0);
    assert.ok(isNullableNumber(partition.lag));
  }

  assert.ok(value.collector && typeof value.collector === 'object');
  assert.ok(isStatus(value.collector.status, ['running', 'degraded', 'unavailable']));
  assert.ok(typeof value.collector.topic === 'string' && value.collector.topic.length > 0);
  assert.ok(typeof value.collector.consumerGroup === 'string' && value.collector.consumerGroup.length > 0);
  assert.ok(isNullableNumber(value.collector.uptimeSeconds));
  for (const key of ['processedMessages', 'insertedSpans', 'invalidMessages', 'failedBatches', 'clickhouseWriteFailures', 'committedBatches']) {
    assert.ok(isNullableNumber(value.collector[key]), `collector.${key} must be non-negative or null`);
  }
  for (const key of ['lastCommitAt', 'lastClickHouseWriteAt']) {
    assert.ok(value.collector[key] === null || (typeof value.collector[key] === 'string' && Number.isFinite(Date.parse(value.collector[key]))));
  }

  assert.ok(value.clickhouse && typeof value.clickhouse === 'object');
  assert.ok(isStatus(value.clickhouse.status, ['healthy', 'unavailable']));
  assert.ok(isNullableNumber(value.clickhouse.pingLatencyMs));
  const queryLatency = value.clickhouse.queryLatency;
  assert.ok(queryLatency && typeof queryLatency === 'object');
  assert.equal(queryLatency.windowSeconds, 300);
  assert.ok(Number.isSafeInteger(queryLatency.sampleCount) && queryLatency.sampleCount >= 0);
  assert.ok(Number.isSafeInteger(queryLatency.errorCount) && queryLatency.errorCount >= 0);
  for (const key of ['p50Ms', 'p95Ms', 'p99Ms']) assert.ok(isNullableNumber(queryLatency[key]));

  assert.ok(value.spanQueue && typeof value.spanQueue === 'object');
  assert.ok(isStatus(value.spanQueue.producerState, ['idle', 'connecting', 'ready', 'unavailable', 'closing', 'closed']));
  for (const key of ['depth', 'capacity', 'queueBytes', 'maxQueueBytes', 'accepted', 'published', 'dropped', 'publishErrors', 'retries']) {
    assert.ok(Number.isSafeInteger(value.spanQueue[key]) && value.spanQueue[key] >= 0, `spanQueue.${key} must be a non-negative integer`);
  }
  assert.ok(value.spanQueue.depth <= value.spanQueue.capacity);
  assert.ok(value.spanQueue.queueBytes <= value.spanQueue.maxQueueBytes);

  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /password|authorization|token|secret|sql|queryText|payload|rawError/i, 'health response must not disclose credentials or raw dependency details');
  return value;
}

async function readHealth(withCredential) {
  return fetch(endpoint, {
    headers: withCredential ? { authorization: `Bearer ${adminToken}` } : {},
    cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
  });
}

async function main() {
  const unauthenticated = await readHealth(false);
  assert.equal(unauthenticated.status, 401, 'operations health must require the platform admin credential');

  const samples = new Array(requestCount);
  const snapshots = new Array(requestCount);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= requestCount) return;
      const startedAt = performance.now();
      const response = await readHealth(true);
      assert.equal(response.status, 200, `operations health request ${index + 1} should succeed`);
      snapshots[index] = validateSnapshot(await response.json());
      samples[index] = performance.now() - startedAt;
    }
  }));

  samples.sort((a, b) => a - b);
  const nearestRank = (percentile) => samples[Math.max(0, Math.ceil(percentile * samples.length) - 1)];
  const lastSnapshot = snapshots[snapshots.length - 1];
  console.log(JSON.stringify({
    status: 'passed',
    unauthorizedStatus: unauthenticated.status,
    authenticatedRequests: samples.length,
    concurrency,
    endpointLatencyMs: {
      p50: Number(nearestRank(0.50).toFixed(1)),
      p95: Number(nearestRank(0.95).toFixed(1)),
      max: Number(samples.at(-1).toFixed(1)),
    },
    components: {
      overall: lastSnapshot.status,
      postgres: lastSnapshot.postgres.status,
      kafka: lastSnapshot.kafka.status,
      collector: lastSnapshot.collector.status,
      clickhouse: lastSnapshot.clickhouse.status,
      kafkaLag: lastSnapshot.kafka.totalLag,
      clickhouseQuerySamples5m: lastSnapshot.clickhouse.queryLatency.sampleCount,
    },
  }));
}

main().catch((error) => {
  console.error(error instanceof assert.AssertionError ? error.message : 'Operations health acceptance failed; credentials withheld');
  process.exitCode = 1;
});
