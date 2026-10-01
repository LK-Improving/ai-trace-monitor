import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TraceRecorder } = require('../dist/observability/trace-recorder.js');

const binding = {
  projectId: 'b35a64bb-8a12-4806-9e77-8831870a5dd0',
  service: 'api',
  environment: 'dev',
};
const traceId = 'trace_v1_01234567-89ab-cdef-0123-456789abcdef';

test('end 只发布一次、重复调用返回独立快照并记录耗时', () => {
  const published = [];
  const recorder = new TraceRecorder(binding, (event) => published.push(event));
  const span = recorder.start('llm.generate', traceId);
  const first = span.end();
  const second = span.end(new Error('must not alter completed status'));

  assert.equal(published.length, 1);
  assert.equal(first.status, 'ok');
  assert.equal(first.schemaVersion, 1);
  assert.ok(first.endTime >= first.startTime);
  assert.equal(first.attributes.durationMs, first.endTime - first.startTime);
  assert.notEqual(first, second);
  assert.notEqual(first.attributes, second.attributes);
  assert.deepEqual(recorder.metrics(), { accepted: 1, dropped: 0, errors: 0 });
  assert.throws(() => { span.id = 'span_replaced'; }, TypeError);
  assert.throws(() => { span.traceId = 'trace_replaced'; }, TypeError);
  assert.throws(() => span.set('after.end', true), /ended/);
  assert.throws(() => span.setUsage(1, 2), /ended/);
});

test('显式 parentSpanId 和只读 traceId 保持在事件上', () => {
  const published = [];
  const span = new TraceRecorder(binding, (event) => published.push(event))
    .start('http.client', traceId, 'span_parent-1');

  assert.equal(span.traceId, traceId);
  assert.throws(() => { span.traceId = 'trace_replaced'; }, TypeError);
  const event = span.end();
  assert.equal(event.parentSpanId, 'span_parent-1');
  assert.equal(published[0].traceId, traceId);
});

test('token usage 仅接受非负安全整数且总数不得溢出', () => {
  const published = [];
  const span = new TraceRecorder(binding, (event) => published.push(event)).start('llm.generate', traceId);
  assert.equal(span.setUsage(12, 30), span);
  for (const [input, output] of [[-1, 2], [1.5, 2], [Number.MAX_SAFE_INTEGER, 1], ['1', 2]]) {
    assert.throws(() => span.setUsage(input, output), TypeError);
  }
  assert.deepEqual(span.end().tokenUsage, { input: 12, output: 30, total: 42 });
});

test('属性脱敏且错误只写固定分类，不保存 message、stack、name 或 code', () => {
  const published = [];
  const secret = 'private prompt payload';
  const span = new TraceRecorder(binding, (event) => published.push(event)).start('llm.generate', traceId);
  span
    .set('prompt', secret)
    .set('metadata', { authorization: 'Bearer private', safe: 'visible' })
    .end(Object.assign(new Error(secret), { name: secret, code: secret }));

  const wire = JSON.stringify(published[0]);
  assert.equal(wire.includes(secret), false);
  assert.equal(wire.includes('Bearer private'), false);
  assert.equal(wire.includes('stack'), false);
  assert.equal(published[0].status, 'error');
  assert.equal(published[0].attributes['error.type'], 'exception');
  assert.deepEqual(published[0].attributes.metadata, { safe: 'visible' });
  assert.equal('error' in published[0], false);

  const unknownEvent = new TraceRecorder(binding, (event) => published.push(event))
    .start('llm.generate', traceId)
    .end('untrusted error name and message');
  assert.equal(unknownEvent.attributes['error.type'], 'unknown');
  assert.equal(JSON.stringify(unknownEvent).includes('untrusted error'), false);
});

test('循环、bigint 和抛错 getter 可安全序列化，不访问 getter', () => {
  const circular = { count: 1n };
  circular.self = circular;
  Object.defineProperty(circular, 'danger', {
    enumerable: true,
    get() { throw new Error('getter was invoked'); },
  });

  const event = new TraceRecorder(binding, () => {}).start('custom.operation', traceId)
    .set('details', circular)
    .end();
  assert.deepEqual(event.attributes.details, {
    count: '1n',
    self: '[circular]',
    danger: '[accessor]',
  });
  assert.doesNotThrow(() => JSON.stringify(event));
});

test('normalize 共享节点预算，超预算和超大 bigint 使用固定短占位', () => {
  const wideTree = Array.from({ length: 100 }, () =>
    Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, index])),
  );
  const event = new TraceRecorder(binding, () => {}).start('custom.operation', traceId)
    .set('tree', wideTree)
    .set('hugeInteger', 1n << 1_000_000n)
    .end();

  assert.doesNotThrow(() => JSON.stringify(event));
  assert.match(JSON.stringify(event), /node-budget-exhausted/);
  assert.equal(event.attributes.hugeInteger, '[bigint]');
  assert.ok(Buffer.byteLength(JSON.stringify(event.attributes), 'utf8') < 16 * 1024);
});

test('属性总量受限，超限 set 不留下部分修改', () => {
  const span = new TraceRecorder(binding, () => {}).start('custom.operation', traceId);
  for (let index = 0; index < 4; index += 1) {
    span.set(`large${index}`, 'x'.repeat(20_000));
  }
  assert.throws(() => span.set('largeOverflow', 'x'.repeat(20_000)), RangeError);
  const attributes = span.end().attributes;
  assert.equal(attributes.largeOverflow, undefined);
  assert.equal(attributes.large0.length, 4_001);
});

test('sink 同步抛错被吞并并计入 dropped/errors', () => {
  const recorder = new TraceRecorder(binding, () => { throw new Error('sink private details'); });
  const event = recorder.start('http.server', traceId).end();
  assert.equal(event.status, 'ok');
  assert.deepEqual(recorder.metrics(), { accepted: 0, dropped: 1, errors: 1 });
});

test('sink 明确返回 accepted:false 计为 dropped 而不是 accepted', () => {
  const recorder = new TraceRecorder(binding, () => ({ accepted: false, reason: 'queue_full' }));
  recorder.start('http.server', traceId).end();
  assert.deepEqual(recorder.metrics(), { accepted: 0, dropped: 1, errors: 0 });
});

test('异步 sink resolve accepted:false 同样计为 dropped', async () => {
  const recorder = new TraceRecorder(binding, () => Promise.resolve({ accepted: false }));
  recorder.start('http.server', traceId).end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(recorder.metrics(), { accepted: 0, dropped: 1, errors: 0 });
});

test('sink 拒绝 Promise 不产生 unhandledRejection，并计入 dropped/errors', async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const recorder = new TraceRecorder(binding, () => Promise.reject(new Error('sink rejection secret')));
    const event = recorder.start('http.server', traceId).end();
    assert.equal(event.status, 'ok');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(recorder.metrics(), { accepted: 0, dropped: 1, errors: 1 });
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('sink 与 end 返回对象互不共享，修改任一快照不改写另一方', () => {
  let published;
  const span = new TraceRecorder(binding, (event) => { published = event; })
    .start('http.server', traceId)
    .set('nested', { value: 'original' });
  const returned = span.end();

  returned.attributes.nested.value = 'return changed';
  assert.equal(published.attributes.nested.value, 'original');
  published.attributes.nested.value = 'sink changed';
  assert.equal(span.end().attributes.nested.value, 'original');
});

test('Promise 上的 accepted:false 不会跳过 rejection 处理', async () => {
  const recorder = new TraceRecorder(binding, () => {
    const rejected = Promise.reject(new Error('private rejection'));
    rejected.accepted = false;
    return rejected;
  });
  assert.doesNotThrow(() => recorder.start('http.server', traceId).end());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(recorder.metrics(), { accepted: 0, dropped: 1, errors: 1 });
});

test('无效 binding、sink、trace/parent ID、operation 和保留属性均拒绝', () => {
  assert.throws(() => new TraceRecorder({ ...binding, projectId: 'not-a-uuid' }, () => {}), TypeError);
  assert.throws(() => new TraceRecorder({ ...binding, environment: 'production' }, () => {}), TypeError);
  assert.throws(() => new TraceRecorder({ ...binding, service: '' }, () => {}), TypeError);
  assert.throws(() => new TraceRecorder(binding, null), TypeError);

  const uppercaseBinding = { ...binding, projectId: binding.projectId.toUpperCase() };
  const canonicalEvent = new TraceRecorder(uppercaseBinding, () => {}).start('valid.operation', traceId).end();
  assert.equal(canonicalEvent.projectId, binding.projectId);

  const recorder = new TraceRecorder(binding, () => {});
  for (const args of [
    ['valid.operation', 'bad trace id'],
    [42, traceId],
    ['', traceId],
    ['x'.repeat(161), traceId],
    ['ok', traceId, 'bad parent id'],
  ]) {
    assert.throws(() => recorder.start(...args), TypeError);
  }
  const span = recorder.start('valid.operation', traceId);
  assert.throws(() => span.set('', 1), TypeError);
  assert.throws(() => span.set('durationMs', 1), TypeError);
});
