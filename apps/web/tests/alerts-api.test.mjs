import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

function loadTypeScriptModule(source, importReplacements = {}) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  let runnableOutput = outputText;
  for (const [specifier, replacement] of Object.entries(importReplacements)) {
    runnableOutput = runnableOutput.replaceAll(`'${specifier}'`, `'${replacement}'`);
  }
  return import(`data:text/javascript;base64,${Buffer.from(runnableOutput).toString('base64')}`);
}

const apiFetchStub = `data:text/javascript;base64,${Buffer.from(
  'export function apiFetch(input, init) { return globalThis.fetch(input, init); }',
).toString('base64')}`;
const alerts = await readFile(new URL('../src/alerts-api.ts', import.meta.url), 'utf8')
  .then((source) => loadTypeScriptModule(source, { './api': apiFetchStub }));

const projectId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const alertId = '123e4567-e89b-12d3-a456-426614174000';
const alertItem = {
  id: alertId,
  title: 'LLM 调用错误',
  message: '模型请求返回错误',
  rule: 'span_error',
  service: 'llm-gateway',
  environment: 'staging',
  level: 'critical',
  state: 'active',
  traceId: 'trace_v1_abcdef123456',
  spanId: 'span_abcdef123456',
  firstSeenAt: '2026-10-02T03:04:05.000Z',
  lastSeenAt: '2026-10-02T03:05:05.000Z',
  triggerCount: 3,
};
const listPayload = { items: [alertItem], total: 1, page: 2, pageSize: 20 };
const summaryPayload = { total: 8, active: 3, acknowledged: 2, resolved: 3, criticalActive: 1 };

test('alert list request scopes project/environment and serializes filters and pagination', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  let requestInit;
  const controller = new AbortController();
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify(listPayload), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await alerts.fetchAlerts({
      projectId, environment: 'staging', state: 'active', level: 'critical', page: 2, pageSize: 20,
    }, controller.signal);
    assert.equal(requestedUrl, `/api/v1/alerts?projectId=${projectId}&environment=staging&state=active&level=critical&page=2&pageSize=20`);
    assert.equal(requestInit.signal, controller.signal);
    assert.deepEqual(result.items, [alertItem]);
    assert.equal(result.total, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('summary request uses the selected project and environment', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(summaryPayload), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    assert.deepEqual(await alerts.fetchAlertSummary(projectId, 'prod'), summaryPayload);
    assert.equal(requestedUrl, `/api/v1/alerts/summary?projectId=${projectId}&environment=prod`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('state updates use only the exact PATCH endpoint and one state field', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  let requestInit;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestInit = init;
    return new Response(null, { status: 204 });
  };

  try {
    await alerts.updateAlertState(alertId, 'acknowledged');
    assert.equal(requestedUrl, `/api/v1/alerts/${alertId}/state`);
    assert.equal(requestInit.method, 'PATCH');
    assert.equal(requestInit.headers['content-type'], 'application/json');
    assert.equal(requestInit.body, JSON.stringify({ state: 'acknowledged' }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('alert payload parsers reject malformed items, invalid enums, and mismatched pagination', () => {
  assert.deepEqual(alerts.parseAlertListPayload(listPayload, { page: 2, pageSize: 20 }), listPayload);
  assert.deepEqual(alerts.parseAlertSummaryPayload(summaryPayload), summaryPayload);
  assert.throws(() => alerts.parseAlertListPayload(listPayload, { page: 1, pageSize: 20 }), /响应与约定不一致/);
  assert.throws(() => alerts.parseAlertListPayload({ ...listPayload, items: [{ ...alertItem, environment: 'qa' }] }, { page: 2, pageSize: 20 }), /响应与约定不一致/);
  assert.throws(() => alerts.parseAlertListPayload({ ...listPayload, items: [{ ...alertItem, state: 'muted' }] }, { page: 2, pageSize: 20 }), /响应与约定不一致/);
  assert.throws(() => alerts.parseAlertListPayload({ ...listPayload, items: [{ ...alertItem, traceId: null }] }, { page: 2, pageSize: 20 }), /响应与约定不一致/);
  assert.throws(() => alerts.parseAlertSummaryPayload({ ...summaryPayload, criticalActive: -1 }), /响应与约定不一致/);
});

test('invalid filters and unsupported states fail before making a request', async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response('{}', { status: 200 });
  };

  try {
    await assert.rejects(alerts.fetchAlerts({
      projectId: 'not-a-uuid', environment: 'dev', state: 'all', level: 'all', page: 1, pageSize: 20,
    }), /Invalid alert filters/);
    await assert.rejects(alerts.updateAlertState(alertId, 'muted'), /Invalid alert state update/);
    await assert.rejects(alerts.fetchAlertSummary(projectId, 'development'), /Invalid alert summary filters/);
    assert.equal(requestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('API and network errors stay explicit and do not expose backend details', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'sensitive backend detail' }), { status: 401 });

  try {
    await assert.rejects(alerts.fetchAlertSummary(projectId, 'all'), (error) => {
      assert.equal(error.status, 401);
      assert.match(error.message, /PLATFORM_ADMIN_TOKEN/);
      assert.doesNotMatch(error.message, /sensitive backend detail/);
      return true;
    });
    globalThis.fetch = async () => { throw new TypeError('network internals'); };
    await assert.rejects(alerts.fetchAlertSummary(projectId, 'all'), /无法连接告警 API 服务/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
