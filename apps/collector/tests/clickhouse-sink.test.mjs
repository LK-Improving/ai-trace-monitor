import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { KafkaJSError } = require('kafkajs');
const { processSpanBatch } = require('../dist/batch-processor.js');
const { insertWithHeartbeat, runWithHeartbeat } = require('../dist/clickhouse-sink.js');
const processBatch = (messages, options) => processSpanBatch(messages, {
  source: { topic: 'clickhouse-sink-test', partition: 0 },
  ...options,
});

const projectId = 'b35a64bb-8a12-4806-9e77-8831870a5dd0';

function makeSpan() {
  return {
    schemaVersion: 1,
    projectId,
    environment: 'dev',
    traceId: 'trace_v1_01234567-89ab-cdef-0123-456789abcdef',
    spanId: 'sink-test-span',
    service: 'api',
    operation: 'http.server',
    startTime: 1_790_280_000_000,
    endTime: 1_790_280_000_025,
    status: 'ok',
    attributes: {},
  };
}

function makeMessage() {
  return { offset: '41', value: Buffer.from(JSON.stringify(makeSpan())) };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(2);
  return predicate();
}

test('slow ClickHouse insert continues heartbeating until the write resolves, then clears the timer', async () => {
  let resolveInsert;
  const insertGate = new Promise((resolve) => { resolveInsert = resolve; });
  let heartbeatCalls = 0;
  let writing = true;

  const operation = insertWithHeartbeat([{ trace_id: 'trace-1' }], {
    async insert() {
      await insertGate;
      writing = false;
    },
    async heartbeat() {
      assert.equal(writing, true, 'Heartbeats must occur while ClickHouse is still writing');
      heartbeatCalls += 1;
    },
    canContinue: () => true,
    heartbeatPeriodMs: 5,
  });

  try {
    const repeatedHeartbeatsObserved = await waitFor(() => heartbeatCalls >= 3, 500);
    assert.equal(repeatedHeartbeatsObserved, true, `Expected repeated heartbeats during the slow write, got ${heartbeatCalls}`);
  } finally {
    resolveInsert();
  }

  await operation;
  const callsAfterWrite = heartbeatCalls;
  await delay(25);
  assert.equal(heartbeatCalls, callsAfterWrite, 'No timer-driven heartbeat may remain after insert completion');
});

test('ClickHouse failure becomes a safe retriable Kafka error and does not reach offset commit', async () => {
  const rawErrorText = 'ClickHouse response included sensitive query payload';
  let commitCalls = 0;
  let caughtError;

  try {
    await processBatch([makeMessage()], {
      insert: (rows) => insertWithHeartbeat(rows, {
        async insert() { throw new Error(rawErrorText); },
        async heartbeat() {},
        canContinue: () => true,
        heartbeatPeriodMs: 5,
      }),
      async commit() { commitCalls += 1; },
    });
  } catch (error) {
    caughtError = error;
  }

  assert.equal(commitCalls, 0, 'Batch processing must stop before offset commit');
  assert.ok(caughtError instanceof KafkaJSError);
  assert.equal(caughtError.retriable, true);
  assert.equal(caughtError.cause, undefined, 'The raw ClickHouse error must not be attached as cause');
  assert.equal(caughtError.message.includes(rawErrorText), false, 'The raw ClickHouse error body must not be exposed');
});

test('heartbeat failure becomes a safe retriable Kafka error and prevents offset commit', async () => {
  const rawErrorText = 'Kafka heartbeat response details';
  let commitCalls = 0;
  let caughtError;

  try {
    await processBatch([makeMessage()], {
      insert: (rows) => insertWithHeartbeat(rows, {
        async insert() { await delay(24); },
        async heartbeat() { throw new Error(rawErrorText); },
        canContinue: () => true,
        heartbeatPeriodMs: 5,
      }),
      async commit() { commitCalls += 1; },
    });
  } catch (error) {
    caughtError = error;
  }

  assert.equal(commitCalls, 0, 'A heartbeat failure must stop processing before commit');
  assert.ok(caughtError instanceof KafkaJSError);
  assert.equal(caughtError.retriable, true);
  assert.equal(caughtError.cause, undefined, 'The original heartbeat error must not be attached as cause');
  assert.equal(caughtError.message.includes(rawErrorText), false, 'The original heartbeat error body must not be exposed');
});

test('alert persistence heartbeat failure is retriable, redacted, and blocks offset commit', async () => {
  const privateDatabaseDetail = 'synthetic PostgreSQL statement detail';
  let commitCalls = 0;
  let caughtError;

  try {
    await processBatch([makeMessage()], {
      async insert() {},
      processAlerts: () => runWithHeartbeat(async () => {
        await delay(20);
        throw new Error(privateDatabaseDetail);
      }, {
        async heartbeat() {},
        canContinue: () => true,
        operationName: 'Alert persistence',
        heartbeatPeriodMs: 5,
      }),
      async commit() { commitCalls += 1; },
    });
  } catch (error) {
    caughtError = error;
  }

  assert.equal(commitCalls, 0);
  assert.ok(caughtError instanceof KafkaJSError);
  assert.equal(caughtError.retriable, true);
  assert.equal(caughtError.cause, undefined);
  assert.equal(caughtError.message.includes(privateDatabaseDetail), false);
});

test('partition becoming stale during a write stops heartbeats and leaves offsets uncommitted', async () => {
  let resolveInsert;
  const insertGate = new Promise((resolve) => { resolveInsert = resolve; });
  let active = true;
  let heartbeatCalls = 0;
  let commitCalls = 0;

  const operation = processBatch([makeMessage()], {
    insert: (rows) => insertWithHeartbeat(rows, {
      async insert() { await insertGate; },
      async heartbeat() { heartbeatCalls += 1; },
      canContinue: () => active,
      heartbeatPeriodMs: 5,
    }),
    async commit() {
      if (active) commitCalls += 1;
    },
  });

  await delay(18);
  active = false;
  const heartbeatCallsAtStale = heartbeatCalls;
  resolveInsert();
  await operation;
  await delay(20);

  assert.equal(commitCalls, 0, 'Stale partition ownership must not advance its Kafka offset');
  assert.equal(heartbeatCalls, heartbeatCallsAtStale, 'Heartbeat loop must stop after the partition goes stale');
});
