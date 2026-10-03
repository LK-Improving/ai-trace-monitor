import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ALERT_DEFAULTS, evaluateSpanAlerts } = require('../dist/alert-engine.js');

const base = {
  schemaVersion: 1,
  projectId: 'b35a64bb-8a12-4806-9e77-8831870a5dd0',
  environment: 'dev',
  traceId: 'trace_v1_01234567-89ab-cdef-0123-456789abcdef',
  spanId: 'span-1',
  service: 'api',
  operation: 'http.server',
  startTime: 1_790_280_000_000,
  endTime: 1_790_280_001_000,
  status: 'ok',
  attributes: {},
};

test('内置延迟阈值为 2000ms，严格超限才触发', () => {
  assert.equal(ALERT_DEFAULTS.spanLatencyMs, 2_000);
  assert.deepEqual(evaluateSpanAlerts({ ...base, endTime: base.startTime + 2_000 }), []);
  const [alert] = evaluateSpanAlerts({ ...base, endTime: base.startTime + 2_001 });
  assert.equal(alert.rule, 'span_latency');
  assert.equal(alert.level, 'warning');
  assert.match(alert.message, /2001ms.*2000ms/);
});

test('Span error 单独告警且不会记录任意 error 正文', () => {
  const privateCanary = 'PRIVATE_PROMPT_OR_CREDENTIAL_CANARY';
  const [alert] = evaluateSpanAlerts({ ...base, status: 'error', error: privateCanary });
  assert.equal(alert.rule, 'span_error');
  assert.equal(alert.level, 'critical');
  assert.equal(JSON.stringify(alert).includes(privateCanary), false);
});

test('LLM 单 Span 总 Token 严格大于 5000 才告警', () => {
  assert.equal(ALERT_DEFAULTS.llmTotalTokens, 5_000);
  assert.deepEqual(evaluateSpanAlerts({ ...base, operation: 'llm.generate', tokenUsage: { input: 3000, output: 2000, total: 5000 } }), []);
  const [alert] = evaluateSpanAlerts({ ...base, operation: 'llm.generate', tokenUsage: { input: 3000, output: 2001, total: 5001 } });
  assert.equal(alert.rule, 'llm_token_threshold');
  assert.match(alert.message, /5001.*5000/);
  assert.deepEqual(evaluateSpanAlerts({ ...base, operation: 'openai.request', tokenUsage: { input: 3000, output: 2001, total: 5001 } }), []);
});

test('成功 rag.retrieve 的标准计数、兼容计数或空 sources 明确表示零召回时触发', () => {
  const [alert] = evaluateSpanAlerts({ ...base, operation: 'rag.retrieve', attributes: { 'rag.recalled_count': 0 } });
  assert.equal(alert.rule, 'rag_empty_recall');
  assert.equal(alert.level, 'warning');
  for (const attributes of [
    { retrievedCount: 0 },
    { sources: [] },
    { 'rag.sources': [] },
  ]) {
    assert.equal(
      evaluateSpanAlerts({ ...base, operation: 'rag.retrieve', attributes })[0]?.rule,
      'rag_empty_recall',
    );
  }
  assert.deepEqual(
    evaluateSpanAlerts({
      ...base,
      operation: 'rag.retrieve',
      attributes: { 'rag.recalled_count': 2, retrievedCount: 0, sources: [] },
    }),
    [],
    'The established numeric rag.recalled_count takes precedence over contradictory compatibility fields',
  );
  assert.deepEqual(
    evaluateSpanAlerts({ ...base, operation: 'rag.retrieve', status: 'error', attributes: { 'rag.recalled_count': 0 } })
      .map(({ rule }) => rule),
    ['span_error'],
  );
  for (const span of [
    { ...base, operation: 'rag.retrieve', attributes: {} },
    { ...base, operation: 'rag.retrieve', attributes: { 'rag.recalled_count': '0' } },
    { ...base, operation: 'rag.retrieve', attributes: { retrievedCount: '0' } },
    { ...base, operation: 'rag.retrieve', attributes: { sources: ['doc-1'] } },
    { ...base, operation: 'rag.rerank', attributes: { 'rag.recalled_count': 0 } },
  ]) assert.deepEqual(evaluateSpanAlerts(span), []);
});

test('同一个失败且超时 Span 可以命中两个隔离规则', () => {
  const alerts = evaluateSpanAlerts({ ...base, status: 'error', endTime: base.startTime + 2_001 });
  assert.deepEqual(alerts.map(({ rule }) => rule).sort(), ['span_error', 'span_latency']);
});
