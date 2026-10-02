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
const [overview, proxy] = await Promise.all([
  readFile(new URL('../src/overview-api.ts', import.meta.url), 'utf8')
    .then((source) => loadTypeScriptModule(source, { './api': apiFetchStub })),
  readFile(new URL('../src/admin-proxy.ts', import.meta.url), 'utf8').then((source) => loadTypeScriptModule(source)),
]);

const generatedAt = '2026-09-26T08:30:00.000Z';
const overviewPayload = {
  generatedAt,
  range: { key: '24h', from: '2026-09-25T08:30:00.000Z', to: generatedAt },
  metrics: { requestCount: 1250, errorCount: 12, errorRate: 0.0096, p50LatencyMs: 320, p95LatencyMs: 1680, p99LatencyMs: 2410, totalTokens: 64000 },
  series: [{ bucketStart: '2026-09-26T08:00:00.000Z', requestCount: 140, errorCount: 2, errorRate: 0.0143, totalTokens: 5100 }],
  services: [{
    name: 'assistant-api', requestCount: 1250, errorCount: 12, errorRate: 0.0096,
    p50LatencyMs: 320, p95LatencyMs: 1680, p99LatencyMs: 2410, lastSeenAt: generatedAt, status: 'degraded',
  }],
  recentErrors: [{
    traceId: 'trace-123', environment: 'staging', service: 'assistant-api', operation: 'POST /chat',
    startTime: generatedAt, durationMs: 1680,
  }],
  topModels: [{ model: 'gpt-4o-mini', callCount: 950, totalTokens: 64000, p95LatencyMs: 780 }],
};

test('projects endpoint maps the existing direct array response and preserves an empty result', () => {
  assert.deepEqual(overview.parseProjectsPayload([{ id: 'p-1', name: '客服助手', slug: 'customer-assistant', status: 'active' }]), [
    { id: 'p-1', name: '客服助手', slug: 'customer-assistant' },
  ]);
  assert.deepEqual(overview.parseProjectsPayload([]), []);
  assert.throws(() => overview.parseProjectsPayload({ data: [] }), /接口响应格式/);
});

test('overview request uses the selected project, environment and range, and maps all contract sections', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(overviewPayload), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await overview.fetchOverview({ projectId: 'project-1', environment: 'staging', range: '24h' });
    assert.equal(requestedUrl, '/api/v1/metrics/overview?projectId=project-1&environment=staging&range=24h');
    assert.deepEqual(result.metrics, overviewPayload.metrics);
    assert.deepEqual(result.series, overviewPayload.series);
    assert.deepEqual(result.services, overviewPayload.services);
    assert.deepEqual(result.recentErrors, overviewPayload.recentErrors);
    assert.deepEqual(result.topModels, overviewPayload.topModels);
    assert.equal(overview.hasOverviewData(result), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unauthorized and network failures remain explicit instead of falling back to sample data', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'do not expose backend detail' }), { status: 401 });

  try {
    await assert.rejects(overview.fetchProjects(), (error) => {
      assert.equal(error.status, 401);
      assert.match(overview.overviewErrorMessage(error), /PLATFORM_ADMIN_TOKEN/);
      assert.doesNotMatch(overview.overviewErrorMessage(error), /backend detail/);
      return true;
    });
    globalThis.fetch = async () => { throw new TypeError('network details are not user-facing'); };
    await assert.rejects(overview.fetchProjects(), /无法连接 API 服务/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('overview response with a different range or malformed service status is rejected', () => {
  assert.throws(() => overview.parseOverviewPayload(overviewPayload, '7d'), /接口响应格式/);
  assert.throws(() => overview.parseOverviewPayload({
    ...overviewPayload,
    services: [{ ...overviewPayload.services[0], status: 'unknown' }],
  }), /接口响应格式/);
});

test('no-data response is distinguishable from non-empty observations', () => {
  const empty = overview.parseOverviewPayload({
    ...overviewPayload,
    metrics: { requestCount: 0, errorCount: 0, errorRate: 0, p50LatencyMs: 0, p95LatencyMs: 0, p99LatencyMs: 0, totalTokens: 0 },
    series: [],
    services: [{ ...overviewPayload.services[0], requestCount: 0, errorCount: 0, errorRate: 0, status: 'no_data' }],
    recentErrors: [],
    topModels: [],
  });
  assert.equal(overview.hasOverviewData(empty), false);
});

test('only exact read-only management GET paths may receive an admin token through the proxy', () => {
  assert.equal(proxy.isAdminReadRequest('GET', '/api/v1/projects'), true);
  assert.equal(proxy.isAdminReadRequest('get', '/api/v1/overview?range=24h'), true);
  assert.equal(proxy.isAdminReadRequest('GET', '/api/v1/projects/'), true);
  assert.equal(proxy.isAdminReadRequest('POST', '/api/v1/projects'), false);
  assert.equal(proxy.isAdminReadRequest('GET', '/api/v1/projects/project-1/keys'), false);
  assert.equal(proxy.isAdminReadRequest('GET', '/api/v1/overview/export'), false);
  assert.equal(proxy.isAdminReadRequest('GET', 'http://outside.example/api/v1/projects'), false);
  assert.equal(proxy.isAdminReadRequest('GET', '//outside.example/api/v1/projects'), false);
  assert.equal(proxy.isAdminReadRequest('GET', 'not a URL with spaces'), false);
});
