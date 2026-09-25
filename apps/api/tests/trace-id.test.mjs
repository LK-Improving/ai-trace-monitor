import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveApiTraceId, TraceIdMiddleware } = require('../dist/trace/trace-id.middleware.js');

test('复用有效的单个 x-trace-id', () => {
  assert.equal(resolveApiTraceId('trace_web_abc-123'), 'trace_web_abc-123');
});

test('缺失、无效和重复 x-trace-id 时生成新的 v1 Trace ID', () => {
  for (const value of [undefined, 'contains spaces', ['first', 'second']]) {
    assert.equal(resolveApiTraceId(value, () => 'trace_v1_generated'), 'trace_v1_generated');
  }
  assert.match(resolveApiTraceId(undefined), /^trace_v1_[0-9a-f-]{36}$/i);
});

test('中间件将最终 Trace ID 写入请求上下文和响应头后继续处理', () => {
  const request = { headers: { 'x-trace-id': 'incoming-id' } };
  const headers = new Map();
  let nextCalled = false;
  const response = { setHeader: (name, value) => headers.set(name, value) };

  new TraceIdMiddleware().use(request, response, () => { nextCalled = true; });

  assert.equal(request.traceId, 'incoming-id');
  assert.equal(headers.get('x-trace-id'), 'incoming-id');
  assert.equal(nextCalled, true);
});
