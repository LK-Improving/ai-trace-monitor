import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolveApiParentSpanId,
  resolveApiTraceId,
  TraceIdMiddleware,
} = require('../dist/trace/trace-id.middleware.js');

test('复用有效的单个 x-trace-id', () => {
  assert.equal(resolveApiTraceId('trace_web_abc-123'), 'trace_web_abc-123');
});

test('缺失、无效和重复 x-trace-id 时生成新的 v1 Trace ID', () => {
  for (const value of [undefined, 'contains spaces', ['first', 'second']]) {
    assert.equal(resolveApiTraceId(value, () => 'trace_v1_generated'), 'trace_v1_generated');
  }
  assert.match(resolveApiTraceId(undefined), /^trace_v1_[0-9a-f-]{36}$/i);
});

test('仅接受唯一严格小写 32 位十六进制 parent span ID', () => {
  const valid = '0123456789abcdef0123456789abcdef';
  assert.equal(resolveApiParentSpanId(valid), valid);
  assert.equal(resolveApiParentSpanId([valid]), valid);

  for (const value of [
    undefined,
    '',
    '0123456789abcdef0123456789abcde',
    '0123456789abcdef0123456789abcdef0',
    '0123456789ABCDEF0123456789ABCDEF',
    `${valid}, ${valid}`,
    [valid, valid],
    ['malformed', valid],
  ]) {
    assert.equal(resolveApiParentSpanId(value), undefined);
  }
});

test('中间件将最终 Trace ID 写入请求上下文和响应头后继续处理', () => {
  const validParentSpanId = '0123456789abcdef0123456789abcdef';
  const request = {
    headers: {
      'x-trace-id': 'incoming-id',
      'x-parent-span-id': validParentSpanId,
    },
  };
  const headers = new Map();
  let nextCalled = false;
  const response = { setHeader: (name, value) => headers.set(name, value) };

  new TraceIdMiddleware().use(request, response, () => { nextCalled = true; });

  assert.equal(request.traceId, 'incoming-id');
  assert.equal(request.parentSpanId, validParentSpanId);
  assert.equal(headers.get('x-trace-id'), 'incoming-id');
  assert.equal(nextCalled, true);
});

test('无效或重复 parent header 被忽略且不改变 Trace ID 中间件行为', () => {
  for (const parentHeader of ['not-a-span-id', ['0123456789abcdef0123456789abcdef', 'fedcba9876543210fedcba9876543210']]) {
    const request = { headers: { 'x-trace-id': 'incoming-id', 'x-parent-span-id': parentHeader } };
    const headers = new Map();
    let nextCalled = false;
    const response = { setHeader: (name, value) => headers.set(name, value) };

    new TraceIdMiddleware().use(request, response, () => { nextCalled = true; });

    assert.equal(request.traceId, 'incoming-id');
    assert.equal(request.parentSpanId, undefined);
    assert.equal(headers.get('x-trace-id'), 'incoming-id');
    assert.equal(nextCalled, true);
  }
});

test('缺失、无效或重复 x-trace-id 时忽略有效 parent 并继续生成 Trace ID', () => {
  const validParentSpanId = '0123456789abcdef0123456789abcdef';
  const traceHeaders = [
    undefined,
    'invalid trace id',
    ['trace-one', 'trace-two'],
  ];

  for (const traceHeader of traceHeaders) {
    const request = { headers: { 'x-parent-span-id': validParentSpanId } };
    if (traceHeader !== undefined) request.headers['x-trace-id'] = traceHeader;
    const headers = new Map();
    let nextCalled = false;
    const response = { setHeader: (name, value) => headers.set(name, value) };

    new TraceIdMiddleware().use(request, response, () => { nextCalled = true; });

    assert.match(request.traceId, /^trace_v1_[0-9a-f-]{36}$/i);
    assert.equal(request.parentSpanId, undefined);
    assert.equal(headers.get('x-trace-id'), request.traceId);
    assert.equal(nextCalled, true);
  }
});
