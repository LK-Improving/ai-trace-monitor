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
const chain = await readFile(new URL('../src/chain-api.ts', import.meta.url), 'utf8')
  .then((source) => loadTypeScriptModule(source, { './api': apiFetchStub }));

const FROM = '2026-09-26T07:30:00.000Z';
const TO = '2026-09-26T08:30:00.000Z';
const WINDOW = { from: FROM, to: TO };
const TRACE_ID = 'trace-same-id';
const HASH = 'a'.repeat(64);

test('alert timestamp windows center on lastSeenAt and stay within the 30-day query limit', () => {
  const center = '2026-10-02T03:05:05.000Z';
  const window = chain.createTimeWindowAround(center);
  assert.deepEqual(window, {
    from: '2026-10-02T02:50:05.000Z',
    to: '2026-10-02T03:20:05.000Z',
  });
  assert.equal(Date.parse(window.to) - Date.parse(window.from), 30 * 60 * 1000);
  assert.throws(() => chain.createTimeWindowAround('not-a-timestamp'), /Invalid time window center/);
});

function span(spanId, parentSpanId = null, attributes = {}) {
  return {
    spanId,
    parentSpanId,
    service: 'assistant-api',
    operation: 'http.server',
    status: 'ok',
    startTime: FROM,
    endTime: FROM,
    durationMs: 0,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    attributes,
    prompt: 'must be stripped',
  };
}

function detailPayload({ projectId = 'project-a', environment = 'prod', spans = [span('root')], nodes, roots, orphans = [], cycles = [], truncated = false } = {}) {
  const selectedRoots = roots ?? spans.filter((item) => item.parentSpanId === null).map((item) => item.spanId);
  const treeNodes = nodes ?? spans.map((item) => ({
    spanId: item.spanId,
    parentSpanId: item.parentSpanId,
    children: spans.filter((candidate) => candidate.parentSpanId === item.spanId).map((candidate) => candidate.spanId),
  }));
  const root = spans.find((item) => item.parentSpanId === null) ?? null;
  return {
    traceId: TRACE_ID,
    projectId,
    environment,
    rootSpan: root,
    spans,
    summary: { spanCount: spans.length, durationMs: 0, totalTokens: 0, status: 'ok', truncated },
    errors: [],
    redaction: { contentIncluded: false },
    tree: { roots: selectedRoots, nodes: treeNodes, orphanSpanIds: orphans, cycleSpanIds: cycles, multipleRoots: selectedRoots.length > 1 },
    unexpected: 'strip me',
  };
}

function traceListPayload({ items = [], total = items.length, page = 1, pageSize = 20 } = {}) {
  return { items, total, page, pageSize, range: WINDOW, unexpected: 'strip me' };
}

function llmMetrics(overrides = {}) {
  return {
    callCount: 2, errorCount: 1, errorRate: 0.5, inputTokens: 30, outputTokens: 12, totalTokens: 42,
    p50LatencyMs: 100, p95LatencyMs: 250, p99LatencyMs: 300,
    ttftSampleCount: 1, p50TtftMs: 20, p95TtftMs: 20, p99TtftMs: 20,
    ...overrides,
  };
}

function aiMetricsPayload(overrides = {}) {
  const llm = llmMetrics();
  return {
    generatedAt: TO,
    range: { key: '1h', from: FROM, to: TO },
    llm: { ...llm, models: [{ model: 'vendor/model-1', ...llm }] },
    rag: {
      callCount: 3, successCount: 2, errorCount: 1, successRate: 2 / 3,
      emptyRecallCount: 1, observedRecallCount: 2, emptyRecallRate: 0.5,
      p50LatencyMs: 50, p95LatencyMs: 100, p99LatencyMs: 120,
      recallSampleCount: 1, p95RecallMs: 20, rerankSampleCount: 1, p95RerankMs: 10,
    },
    unexpected: 'strip me',
    ...overrides,
  };
}

test('list request applies exact server-side filters, time window, paging, and sends no Authorization header', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify(traceListPayload({ page: 2, pageSize: 20 })), { status: 200 });
  };
  try {
    const result = await chain.fetchTraceList({
      projectId: 'project-a', environment: 'all', range: '1h', page: 2, pageSize: 20,
      traceId: TRACE_ID, service: 'assistant-api', status: 'error', window: WINDOW,
    });
    const url = new URL(request.url, 'http://localhost');
    assert.equal(url.pathname, '/api/v1/traces');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      projectId: 'project-a', environment: 'all', from: FROM, to: TO,
      page: '2', pageSize: '20', traceId: TRACE_ID, service: 'assistant-api', status: 'error',
    });
    assert.equal(new Headers(request.init.headers).has('authorization'), false);
    assert.equal(result.range.from, FROM);
    assert.equal(Object.hasOwn(result, 'unexpected'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('detail request binds the concrete environment, project, ID and query window; same ID from another project is rejected', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify(detailPayload({ projectId: 'project-b', environment: 'staging' })), { status: 200 });
  };
  try {
    await assert.rejects(chain.fetchTraceDetail({
      projectId: 'project-a', environment: 'staging', traceId: TRACE_ID, window: WINDOW,
    }), /接口响应格式/);
    const url = new URL(request.url, 'http://localhost');
    assert.equal(url.pathname, `/api/v1/traces/${TRACE_ID}`);
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      projectId: 'project-a', environment: 'staging', from: FROM, to: TO,
    });
    assert.equal(new Headers(request.init.headers).has('authorization'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.throws(() => chain.parseTraceDetailPayload(detailPayload({ projectId: 'project-b' }), {
    projectId: 'project-a', environment: 'prod', traceId: TRACE_ID,
  }), /接口响应格式/);
});

test('detail allowlist accepts contract Span IDs and preserves orphan/cycle effective tree metadata', () => {
  const root = span('root');
  const orphan = span('孤儿/节点', 'missing/parent', { prompt: 'never expose', sources: [HASH.toUpperCase()] });
  const cycleA = span('环/a', '环/b');
  const cycleB = span('环/b', '环/a', { 'rag.rerank_before': { items: [{ idHash: HASH, rank: 1, score: 0.9 }], total_count: 1, truncated: false } });
  const payload = detailPayload({
    spans: [root, orphan, cycleA, cycleB],
    roots: ['root', '孤儿/节点', '环/a'],
    nodes: [
      { spanId: 'root', parentSpanId: null, children: [] },
      { spanId: '孤儿/节点', parentSpanId: null, children: [] },
      { spanId: '环/a', parentSpanId: null, children: ['环/b'] },
      { spanId: '环/b', parentSpanId: '环/a', children: [] },
    ],
    orphans: ['孤儿/节点'],
    cycles: ['环/a', '环/b'],
  });
  const result = chain.parseTraceDetailPayload(payload, { projectId: 'project-a', environment: 'prod', traceId: TRACE_ID });
  assert.equal(result.spans[1].parentSpanId, 'missing/parent');
  assert.equal(result.tree.nodes[1].parentSpanId, null);
  assert.deepEqual(result.tree.orphanSpanIds, ['孤儿/节点']);
  assert.deepEqual(result.tree.cycleSpanIds, ['环/a', '环/b']);
  assert.deepEqual(result.spans[1].attributes.sources, [HASH]);
  assert.equal(Object.hasOwn(result.spans[1].attributes, 'prompt'), false);
  assert.equal(result.tree.multipleRoots, true);
  assert.throws(() => chain.parseTraceDetailPayload(detailPayload({ spans: [span('bad\nspan')] })), /接口响应格式/);
  assert.throws(() => chain.parseTraceDetailPayload({ ...payload, traceId: 'not a valid trace id' }), /接口响应格式/);
});

test('iterative tree flattening handles a truncated 2,000-span chain without recursion', () => {
  const spans = Array.from({ length: 2_000 }, (_, index) => span(`S${index}`, index === 0 ? null : `S${index - 1}`));
  const nodes = spans.map((item, index) => ({
    spanId: item.spanId,
    parentSpanId: item.parentSpanId,
    children: index === spans.length - 1 ? [] : [`S${index + 1}`],
  }));
  const payload = detailPayload({ spans, nodes, roots: ['S0'], truncated: true });
  const parsed = chain.parseTraceDetailPayload(payload, { projectId: 'project-a', environment: 'prod', traceId: TRACE_ID });
  const flattened = chain.flattenTraceTree(parsed);
  assert.equal(parsed.summary.truncated, true);
  assert.equal(flattened.length, 2_000);
  assert.equal(flattened[1_999].span.spanId, 'S1999');
  assert.equal(flattened[1_999].depth, 1_999);
});

test('AI parser retains model failures and real RAG/TTFT samples while stripping unallowlisted fields', () => {
  const result = chain.parseAiMetricsPayload(aiMetricsPayload(), '1h');
  assert.equal(result.llm.models[0].errorCount, 1);
  assert.equal(result.llm.models[0].errorRate, 0.5);
  assert.equal(result.llm.p95TtftMs, 20);
  assert.equal(result.rag.p95RecallMs, 20);
  assert.equal(result.rag.p95RerankMs, 10);
  assert.equal(Object.hasOwn(result, 'unexpected'), false);

  const noSamples = aiMetricsPayload({
    llm: { ...llmMetrics({ callCount: 0, errorCount: 0, errorRate: 0, ttftSampleCount: 0 }), models: [] },
    rag: {
      callCount: 0, successCount: 0, errorCount: 0, successRate: 0,
      emptyRecallCount: 0, observedRecallCount: 0, emptyRecallRate: null,
      p50LatencyMs: 0, p95LatencyMs: 0, p99LatencyMs: 0,
      recallSampleCount: 0, p95RecallMs: 0, rerankSampleCount: 0, p95RerankMs: 0,
    },
  });
  assert.equal(chain.parseAiMetricsPayload(noSamples, '1h').rag.emptyRecallRate, null);
  assert.throws(() => chain.parseAiMetricsPayload(aiMetricsPayload(), '24h'), /接口响应格式/);
});

test('pagination rejects offsets beyond the backend query cap and network errors stay generic', async () => {
  await assert.rejects(chain.fetchTraceList({
    projectId: 'project-a', environment: 'all', range: '24h', page: 502, pageSize: 20,
  }), /Invalid Trace pagination/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('private network details'); };
  try {
    await assert.rejects(chain.fetchAiMetrics('project-a', 'all', '24h'), (error) => {
      assert.match(error.message, /无法连接 API 服务/);
      assert.doesNotMatch(error.message, /private network details/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
