import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  CollectorTelemetry,
  observeBatchAttempt,
  observeClickHouseWrite,
} = require('../dist/collector-telemetry.js');
const {
  OPS_HEALTH_BIND_HOST,
  OPS_HEALTH_PATH,
  OPS_HEALTH_PORT,
  createOpsHealthServer,
  listenOpsHealthServer,
} = require('../dist/ops-health.js');

function createClock() {
  let monotonic = 10_000;
  let wall = new Date('2026-10-03T01:00:00.000Z');
  return {
    clock: {
      monotonicNow: () => monotonic,
      wallClockNow: () => wall,
    },
    advance(milliseconds) {
      monotonic += milliseconds;
      wall = new Date(wall.getTime() + milliseconds);
    },
  };
}

test('health metrics start with known zero counters, transition safely, and remain cumulative', () => {
  const time = createClock();
  const telemetry = new CollectorTelemetry('unit-topic', 'unit-group', time.clock);
  const initial = telemetry.snapshot();
  assert.deepEqual(initial, {
    status: 'degraded',
    topic: 'unit-topic',
    consumerGroup: 'unit-group',
    uptimeSeconds: 0,
    processedMessages: 0,
    insertedSpans: 0,
    invalidMessages: 0,
    failedBatches: 0,
    clickhouseWriteFailures: 0,
    committedBatches: 0,
    lastCommitAt: null,
    lastClickHouseWriteAt: null,
  });

  telemetry.markRunning();
  const live = telemetry.snapshot();
  assert.equal(live.processedMessages, 0);
  assert.equal(live.insertedSpans, 0);
  assert.equal(live.invalidMessages, 0);
  assert.equal(live.failedBatches, 0);
  assert.equal(live.clickhouseWriteFailures, 0);
  assert.equal(live.committedBatches, 0);
  telemetry.recordProcessedMessages(4);
  telemetry.recordInvalidMessage();
  telemetry.recordBatchFailure();
  assert.equal(telemetry.snapshot().status, 'degraded');
  assert.equal(telemetry.snapshot().insertedSpans, 0);
  assert.equal(telemetry.snapshot().committedBatches, 0);

  time.advance(2_500);
  telemetry.recordClickHouseWriteSuccess(3);
  telemetry.recordCommitSuccess();
  const recovered = telemetry.snapshot();
  assert.equal(recovered.status, 'running');
  assert.equal(recovered.uptimeSeconds, 2);
  assert.equal(recovered.processedMessages, 4);
  assert.equal(recovered.insertedSpans, 3);
  assert.equal(recovered.invalidMessages, 1);
  assert.equal(recovered.failedBatches, 1);
  assert.equal(recovered.committedBatches, 1);
  assert.equal(recovered.lastClickHouseWriteAt, '2026-10-03T01:00:02.500Z');
  assert.equal(recovered.lastCommitAt, '2026-10-03T01:00:02.500Z');

  time.advance(1_000);
  telemetry.recordProcessedMessages(2);
  telemetry.recordClickHouseWriteSuccess(1);
  telemetry.recordCommitSuccess();
  const later = telemetry.snapshot();
  assert.equal(later.processedMessages, 6);
  assert.equal(later.insertedSpans, 4);
  assert.equal(later.committedBatches, 2);
  assert.equal(later.uptimeSeconds, 3);
  telemetry.markUnavailable();
  assert.equal(telemetry.snapshot().status, 'unavailable');
  telemetry.markRunning();
  assert.equal(telemetry.snapshot().status, 'unavailable', 'shutdown/unrecoverable state must not be revived');
});

test('repeated Kafka batch deliveries count attempts and invalid classifications each time', async () => {
  const telemetry = new CollectorTelemetry('retry-topic', 'retry-group');
  telemetry.markRunning();
  const attempt = () => observeBatchAttempt(telemetry, 2, async () => {
    telemetry.recordInvalidMessage();
  });
  await attempt();
  await attempt();

  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.processedMessages, 4);
  assert.equal(snapshot.invalidMessages, 2);
  assert.equal(snapshot.failedBatches, 0);
  assert.equal(snapshot.insertedSpans, 0);
  assert.equal(snapshot.clickhouseWriteFailures, 0);
  assert.equal(snapshot.committedBatches, 0);
});

test('batch and ClickHouse instrumentation count only observed events and never retain provider errors', async () => {
  const time = createClock();
  const telemetry = new CollectorTelemetry('unit-topic', 'unit-group', time.clock);
  const privateError = new Error('private ClickHouse response and payload canary');

  await assert.rejects(observeBatchAttempt(telemetry, 3, () => observeClickHouseWrite(
    telemetry,
    2,
    async () => { throw privateError; },
  )), (error) => error === privateError);

  let snapshot = telemetry.snapshot();
  assert.equal(snapshot.processedMessages, 3);
  assert.equal(snapshot.failedBatches, 1);
  assert.equal(snapshot.clickhouseWriteFailures, 1);
  assert.equal(snapshot.insertedSpans, 0);
  assert.equal(snapshot.committedBatches, 0);
  assert.equal(snapshot.status, 'degraded');
  assert.doesNotMatch(JSON.stringify(snapshot), /private ClickHouse|payload canary/);

  await observeBatchAttempt(telemetry, 2, async () => {
    await observeClickHouseWrite(telemetry, 2, async () => ({ accepted: true }));
    telemetry.recordInvalidMessage();
    telemetry.recordCommitSuccess();
  });
  snapshot = telemetry.snapshot();
  assert.equal(snapshot.processedMessages, 5);
  assert.equal(snapshot.insertedSpans, 2);
  assert.equal(snapshot.invalidMessages, 1);
  assert.equal(snapshot.clickhouseWriteFailures, 1);
  assert.equal(snapshot.failedBatches, 1);
  assert.equal(snapshot.committedBatches, 1);
  assert.equal(snapshot.status, 'running');
});

test('health HTTP exposes only GET on the fixed path and returns a safe snapshot', async (t) => {
  assert.equal(OPS_HEALTH_BIND_HOST, '127.0.0.1');
  assert.equal(OPS_HEALTH_PORT, 3011);
  assert.equal(OPS_HEALTH_PATH, '/internal/ops/health');
  const telemetry = new CollectorTelemetry('health-topic', 'health-group');
  const server = createOpsHealthServer(telemetry);
  t.after(async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  assert.equal(address.address, '127.0.0.1');
  const url = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${url}${OPS_HEALTH_PATH}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload), [
    'status', 'topic', 'consumerGroup', 'uptimeSeconds', 'processedMessages', 'insertedSpans',
    'invalidMessages', 'failedBatches', 'clickhouseWriteFailures', 'committedBatches',
    'lastCommitAt', 'lastClickHouseWriteAt',
  ]);
  assert.equal(payload.status, 'degraded');
  assert.equal(payload.processedMessages, 0);
  assert.equal(payload.topic, 'health-topic');

  const methodResponse = await fetch(`${url}${OPS_HEALTH_PATH}`, { method: 'POST', body: 'not logged' });
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get('allow'), 'GET');
  assert.deepEqual(await methodResponse.json(), { error: 'method_not_allowed' });

  const pathResponse = await fetch(`${url}/internal/ops/health?debug=private`);
  assert.equal(pathResponse.status, 404);
  assert.deepEqual(await pathResponse.json(), { error: 'not_found' });
});

test('production health listener can only bind the fixed loopback address and port', () => {
  const calls = [];
  listenOpsHealthServer({ listen: (...args) => calls.push(args) });
  assert.deepEqual(calls, [[3011, '127.0.0.1']]);
});
