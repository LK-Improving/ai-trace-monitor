import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { processSpanBatch } = require('../dist/batch-processor.js');

const projectId = 'b35a64bb-8a12-4806-9e77-8831870a5dd0';

function makeSpan(overrides = {}) {
  return {
    schemaVersion: 1,
    projectId,
    environment: 'dev',
    traceId: 'trace_v1_01234567-89ab-cdef-0123-456789abcdef',
    spanId: 'span-1',
    service: 'api',
    operation: 'http.server',
    startTime: 1_790_280_000_000,
    endTime: 1_790_280_000_025,
    status: 'ok',
    attributes: {},
    ...overrides,
  };
}

function message(offset, value) {
  return { offset, value: Buffer.isBuffer(value) || value === null ? value : Buffer.from(value) };
}

test('正常批量写入脱敏后的 ClickHouse 行，写入先于提交且 offset 按 BigInt 加一', async () => {
  const privateCanary = 'W5_PRIVATE_PROMPT_CANARY_DO_NOT_PERSIST';
  const inserted = [];
  const calls = [];

  await processSpanBatch([
    message('9007199254740991', JSON.stringify(makeSpan({
      attributes: { model: 'model-x', prompt: privateCanary },
    }))),
    message('9007199254740992', JSON.stringify(makeSpan({ spanId: 'span-2' }))),
  ], {
    async insert(rows) {
      calls.push('insert');
      inserted.push(...rows);
    },
    async commit(lastProcessedOffset, nextOffset) {
      calls.push('commit');
      assert.equal(lastProcessedOffset, '9007199254740992');
      assert.equal(nextOffset, '9007199254740993');
    },
  });

  assert.equal(inserted.length, 2, 'Both valid Spans should be written in one batch');
  assert.equal(inserted[0].trace_id, 'trace_v1_01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(inserted[0].span_id, 'span-1');
  assert.equal(inserted[0].model, 'model-x');
  assert.equal(inserted[0].attributes.includes(privateCanary), false, 'Sensitive attributes must not reach ClickHouse');
  assert.deepEqual(calls, ['insert', 'commit'], 'Persistence must complete before offsets are committed');
});

test('ClickHouse insert 失败时保留 Kafka offset，供失败重试或重新投递', async () => {
  let commitCalls = 0;
  let insertCalls = 0;

  await assert.rejects(processSpanBatch([
    message('27', JSON.stringify(makeSpan())),
  ], {
    async insert() {
      insertCalls += 1;
      throw new Error('synthetic ClickHouse insert failure');
    },
    async commit() { commitCalls += 1; },
  }));

  assert.equal(insertCalls, 1);
  assert.equal(commitCalls, 0, 'An unsuccessful persistence attempt must never advance the offset');
});

test('无效 payload 只产生固定安全原因码，不向日志或回调泄露原文', async () => {
  const canary = 'W5_INVALID_SPAN_SECRET_CANARY';
  const invalidJson = `{"prompt":"${canary}"`;
  const invalidSchema = JSON.stringify({
    spanId: 'invalid-schema-span',
    attributes: { prompt: canary },
  });
  const invalidEvents = [];
  const callbackArgumentCounts = [];
  const capturedLogs = [];
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const capture = (...args) => {
    capturedLogs.push(args.map((value) => {
      if (Buffer.isBuffer(value)) return value.toString('utf8');
      if (typeof value === 'string') return value;
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      try { return JSON.stringify(value); } catch { return ''; }
    }).join(' '));
  };
  for (const method of Object.keys(originalConsole)) console[method] = capture;

  let rejected = false;
  try {
    await processSpanBatch([
      message('31', null),
      message('32', invalidJson),
      message('33', invalidSchema),
    ], {
      async insert() {},
      async commit() {},
      onInvalid(reason, offset, ...extra) {
        invalidEvents.push([reason, offset]);
        callbackArgumentCounts.push(extra.length + 2);
      },
    });
  } catch {
    // Deliberately do not expose the caught exception in test output.
    rejected = true;
  } finally {
    for (const [method, original] of Object.entries(originalConsole)) console[method] = original;
  }

  assert.equal(rejected, false, 'Malformed messages should be safely classified rather than aborting the batch');
  const classificationIsSafe = invalidEvents.length === 3
    && invalidEvents[0]?.[0] === 'empty_payload' && invalidEvents[0]?.[1] === '31'
    && invalidEvents[1]?.[0] === 'invalid_json' && invalidEvents[1]?.[1] === '32'
    && invalidEvents[2]?.[0] === 'invalid_schema' && invalidEvents[2]?.[1] === '33'
    && callbackArgumentCounts.every((count) => count === 2);
  assert.equal(classificationIsSafe, true, 'Invalid callbacks may contain only a fixed reason code and offset');
  assert.equal(capturedLogs.some((line) => line.includes(canary)), false, 'Logs must not include sensitive canary data');
  assert.equal(capturedLogs.some((line) => line.includes(invalidJson)), false, 'Logs must not include raw invalid messages');
  assert.equal(capturedLogs.some((line) => line.includes(invalidSchema)), false, 'Logs must not include invalid Span bodies');
});

test('纯无效批次不写入 ClickHouse，丢弃 poison messages 后提交到批次末尾', async () => {
  let insertCalls = 0;
  const commits = [];
  const invalidReasons = [];

  await processSpanBatch([
    message('70', null),
    message('71', '{not-json'),
  ], {
    async insert() { insertCalls += 1; },
    async commit(lastProcessedOffset, nextOffset) { commits.push([lastProcessedOffset, nextOffset]); },
    onInvalid(reason, offset) { invalidReasons.push([reason === 'empty_payload' || reason === 'invalid_json', offset]); },
  });

  assert.equal(insertCalls, 0, 'A batch containing no valid rows should skip ClickHouse insert');
  assert.equal(invalidReasons.length, 2);
  assert.equal(invalidReasons.every(([isSafeReason]) => isSafeReason), true);
  assert.deepEqual(commits, [['71', '72']], 'Dropped invalid messages are acknowledged so they cannot block the partition');
});

test('空批次不执行写入或提交', async () => {
  let insertCalls = 0;
  let commitCalls = 0;

  await processSpanBatch([], {
    async insert() { insertCalls += 1; },
    async commit() { commitCalls += 1; },
  });

  assert.equal(insertCalls, 0);
  assert.equal(commitCalls, 0);
});

test('混合批次的 offset 推进覆盖已持久化消息与已分类丢弃消息', async () => {
  const commits = [];
  await processSpanBatch([
    message('104', JSON.stringify(makeSpan())),
    message('105', null),
  ], {
    async insert(rows) { assert.equal(rows.length, 1); },
    async commit(lastProcessedOffset, nextOffset) { commits.push([lastProcessedOffset, nextOffset]); },
  });

  assert.deepEqual(commits, [['105', '106']]);
});
