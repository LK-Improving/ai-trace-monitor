import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const distRoot = process.env.API_DIST_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const { TraceDetailService } = require(join(distRoot, 'traces/trace-detail.service.js'));
const { projectTraceDetail } = require(join(distRoot, 'traces/trace-detail.projection.js'));

const projectId = 'b35a64bb-8a12-4806-9e77-8831870a5dd0';
const traceId = 'trace_detail_w13';
const baseMs = Date.parse('2026-09-20T12:00:00.000Z');
const validQuery = {
  projectId,
  environment: 'prod',
  from: '2026-09-20T12:00:00.000Z',
  to: '2026-09-20T13:00:00.000Z',
};

function chDate(milliseconds) {
  return new Date(milliseconds).toISOString().replace('T', ' ').replace('Z', '');
}

function makeRow({
  spanId,
  parentSpanId = '',
  service = 'api',
  operation = 'http.server',
  status = 'ok',
  startOffset = 0,
  endOffset = 10,
  eventOffset = startOffset,
  model = '',
  inputTokens = 0,
  outputTokens = 0,
  totalTokens = inputTokens + outputTokens,
  attributes = {},
} = {}) {
  return {
    span_id: spanId,
    event_time: chDate(baseMs + eventOffset),
    parent_span_id: parentSpanId,
    service,
    operation,
    status,
    start_time: chDate(baseMs + startOffset),
    end_time: chDate(baseMs + endOffset),
    duration_ms: endOffset - startOffset,
    model,
    input_tokens: String(inputTokens),
    output_tokens: String(outputTokens),
    total_tokens: String(totalTokens),
    attributes: typeof attributes === 'string' ? attributes : JSON.stringify(attributes),
  };
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function fiveSpanRows() {
  return [
    makeRow({
      spanId: 'root', operation: 'http.server', endOffset: 10_000,
      totalTokens: 900, attributes: { 'http.method': 'POST', 'http.status_code': 200, prompt: 'secret-canary-root' },
    }),
    makeRow({
      spanId: 'rag', parentSpanId: 'root', operation: 'rag.retrieve', startOffset: 1_000, endOffset: 7_000,
      attributes: { topK: 2, sources: [HASH_A, HASH_B], 'rag.recalled_count': 2, 'rag.empty': false },
    }),
    makeRow({ spanId: 'recall', parentSpanId: 'rag', operation: 'rag.recall', startOffset: 2_000, endOffset: 3_000 }),
    makeRow({ spanId: 'rerank', parentSpanId: 'rag', operation: 'rag.rerank', startOffset: 4_000, endOffset: 5_000 }),
    makeRow({
      spanId: 'llm', parentSpanId: 'root', operation: 'llm.generate', status: 'error',
      startOffset: 6_000, endOffset: 8_000, model: 'gpt-4o-mini', inputTokens: 20, outputTokens: 10,
      attributes: {
        model: 'gpt-4o-mini', requested_model: 'gpt-4o-mini', 'llm.model': 'gpt-4o-mini',
        'ai.error_category': 'provider_error', response: 'secret-canary-response', stack: 'secret-canary-stack',
      },
    }),
  ];
}

function createHarness({ rows = fiveSpanRows(), projectExists = true, databaseError, clickHouseError } = {}) {
  const databaseCalls = [];
  const clickHouseCalls = [];
  const database = {
    async query(sql, values = []) {
      databaseCalls.push({ sql, values });
      if (databaseError) throw databaseError;
      return { rows: projectExists ? [{ id: values[0] }] : [] };
    },
  };
  const clickhouse = {
    async query(sql, queryParams) {
      clickHouseCalls.push({ sql, queryParams });
      if (clickHouseError) throw clickHouseError;
      return typeof rows === 'function' ? rows(queryParams) : rows;
    },
  };
  return {
    service: new TraceDetailService(database, clickhouse),
    databaseCalls,
    clickHouseCalls,
  };
}

function statusIs(status) {
  return (error) => error?.getStatus?.() === status;
}

function projectionQuery(overrides = {}) {
  return {
    traceId,
    projectId,
    environment: 'prod',
    fromMs: baseMs,
    toMs: baseMs + 60_000,
    includeContent: false,
    ...overrides,
  };
}

test('详情返回完整五跨度树、有限摘要与安全属性投影', async () => {
  const { service, databaseCalls, clickHouseCalls } = createHarness();
  const result = await service.detail(traceId, validQuery);

  assert.equal(result.traceId, traceId);
  assert.equal(result.projectId, projectId);
  assert.equal(result.environment, 'prod');
  assert.equal(result.rootSpan.operation, 'http.server');
  assert.equal(result.spans.length, 5);
  assert.deepEqual(result.summary, {
    spanCount: 5,
    durationMs: 10_000,
    totalTokens: 30,
    status: 'error',
    truncated: false,
  });
  assert.deepEqual(result.tree.roots, ['root']);
  assert.deepEqual(result.tree.nodes[0], {
    spanId: 'root', parentSpanId: null, children: ['rag', 'llm'],
  });
  assert.deepEqual(result.tree.nodes[1], {
    spanId: 'rag', parentSpanId: 'root', children: ['recall', 'rerank'],
  });
  assert.deepEqual(result.errors, [{ spanId: 'llm', category: 'provider_error' }]);
  assert.deepEqual(result.redaction, { contentIncluded: false });
  assert.deepEqual(result.spans.find((span) => span.spanId === 'rag').attributes.sources, [HASH_A, HASH_B]);
  assert.equal(result.spans.find((span) => span.spanId === 'root').attributes['http.method'], 'POST');
  assert.doesNotMatch(JSON.stringify(result), /secret-canary|"prompt"|"response"|"stack"/i);

  assert.deepEqual(databaseCalls[0].values, [projectId]);
  const call = clickHouseCalls[0];
  assert.deepEqual(call.queryParams, {
    projectId,
    environment: 'prod',
    traceId,
    fromMs: Date.parse(validQuery.from),
    toMs: Date.parse(validQuery.to),
  });
  assert.match(call.sql, /project_id = \{projectId:String\}/);
  assert.match(call.sql, /environment = \{environment:String\}/);
  assert.match(call.sql, /trace_id = \{traceId:String\}/);
  assert.match(call.sql, /event_time >= fromUnixTimestamp64Milli\(\{fromMs:Int64\}/);
  assert.match(call.sql, /event_time < fromUnixTimestamp64Milli\(\{toMs:Int64\}/);
  assert.match(call.sql, /GROUP BY span_id/i);
  assert.match(call.sql, /LIMIT 2001/i);
  assert.match(call.sql, /argMax\([\s\S]*tuple\(event_time, end_time, start_time, parent_span_id, service, operation, status,\s*total_tokens, model, duration_ms, input_tokens, output_tokens, attributes\),\s*tuple\(event_time, end_time, start_time, parent_span_id, service, operation, status,\s*total_tokens, model, duration_ms, input_tokens, output_tokens, attributes\)/i);
  assert.doesNotMatch(call.sql, /\berror\b/i);
});

test('六个并发请求通过各自的项目和环境绑定参数隔离同名 traceId', async () => {
  const { service, clickHouseCalls } = createHarness({
    rows: (params) => [makeRow({
      spanId: `span-${params.projectId.slice(0, 8)}`,
      service: params.environment,
    })],
  });
  const projectIds = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-8000-000000000006',
  ];
  const environments = ['dev', 'staging', 'prod', 'dev', 'staging', 'prod'];
  const results = await Promise.all(projectIds.map((id, index) => service.detail(traceId, {
    ...validQuery,
    projectId: id,
    environment: environments[index],
  })));

  assert.deepEqual(results.map((result) => result.projectId), projectIds);
  assert.deepEqual(results.map((result) => result.environment), environments);
  assert.deepEqual(results.map((result) => result.spans[0].spanId), projectIds.map((id) => `span-${id.slice(0, 8)}`));
  assert.equal(clickHouseCalls.length, 6);
  assert.ok(clickHouseCalls.every(({ queryParams }) => queryParams.traceId === traceId));
  assert.deepEqual(clickHouseCalls.map(({ queryParams }) => queryParams.projectId), projectIds);
  assert.deepEqual(clickHouseCalls.map(({ queryParams }) => queryParams.environment), environments);
});

test('重复跨度按 event、end、start 与完整确定性 tuple 去重', async () => {
  const rows = fiveSpanRows();
  rows.push(makeRow({
    spanId: 'llm', parentSpanId: 'root', operation: 'llm.generate', status: 'error',
    startOffset: 6_000, endOffset: 9_000, eventOffset: 6_000, model: 'gpt-4o-mini',
    inputTokens: 25, outputTokens: 15,
    attributes: { model: 'gpt-4o-mini', 'ai.error_category': 'provider_error' },
  }));
  const { service } = createHarness({ rows });
  const result = await service.detail(traceId, validQuery);

  assert.equal(result.spans.length, 5);
  assert.equal(result.spans.find((span) => span.spanId === 'llm').endTime, chDate(baseMs + 9_000).replace(' ', 'T') + 'Z');
  assert.equal(result.summary.totalTokens, 40);
});

test('an orphan, a multi-node cycle, and a self-cycle retain reported parents while tree links are safe', () => {
  const result = projectTraceDetail(projectionQuery(), [
    makeRow({ spanId: 'orphan', parentSpanId: 'missing', startOffset: 0, endOffset: 1 }),
    makeRow({ spanId: 'cycle-a', parentSpanId: 'cycle-b', startOffset: 10, endOffset: 11 }),
    makeRow({ spanId: 'cycle-b', parentSpanId: 'cycle-a', startOffset: 20, endOffset: 21 }),
    makeRow({ spanId: 'self-cycle', parentSpanId: 'self-cycle', startOffset: 30, endOffset: 31 }),
  ]);

  assert.equal(result.rootSpan, null);
  assert.deepEqual(result.tree.orphanSpanIds, ['orphan']);
  assert.deepEqual(result.tree.cycleSpanIds, ['cycle-a', 'cycle-b', 'self-cycle']);
  assert.deepEqual(result.tree.roots, ['orphan', 'cycle-a', 'self-cycle']);
  assert.equal(result.spans.find((span) => span.spanId === 'orphan').parentSpanId, 'missing');
  assert.equal(result.spans.find((span) => span.spanId === 'cycle-a').parentSpanId, 'cycle-b');
  assert.equal(result.tree.nodes.find((node) => node.spanId === 'orphan').parentSpanId, null);
  assert.equal(result.tree.nodes.find((node) => node.spanId === 'cycle-a').parentSpanId, null);
  assert.equal(result.tree.nodes.find((node) => node.spanId === 'cycle-b').parentSpanId, 'cycle-a');
  assert.equal(result.tree.nodes.find((node) => node.spanId === 'self-cycle').parentSpanId, null);
  assert.equal(result.tree.multipleRoots, true);
  for (const node of result.tree.nodes) {
    assert.ok(node.parentSpanId === null || result.tree.nodes.some((candidate) => candidate.spanId === node.parentSpanId));
  }
});

test('二千层树用迭代构建且不因调用栈深度失败', () => {
  const rows = Array.from({ length: 2_000 }, (_, index) => makeRow({
    spanId: `deep-${String(index).padStart(4, '0')}`,
    parentSpanId: index === 0 ? '' : `deep-${String(index - 1).padStart(4, '0')}`,
    startOffset: index,
    endOffset: index + 1,
  }));
  const result = projectTraceDetail(projectionQuery(), rows);

  assert.equal(result.spans.length, 2_000);
  assert.equal(result.tree.roots.length, 1);
  assert.equal(result.tree.nodes.at(-1).children.length, 0);
  assert.equal(result.tree.nodes[1_999].parentSpanId, 'deep-1998');
});

test('第 2001 行只作为截断标记，不进入详情响应', async () => {
  const rows = Array.from({ length: 2_001 }, (_, index) => makeRow({
    spanId: `bounded-${String(index).padStart(4, '0')}`,
    parentSpanId: index === 0 ? '' : `bounded-${String(index - 1).padStart(4, '0')}`,
    startOffset: index,
    endOffset: index + 1,
  }));
  const { service } = createHarness({ rows });
  const result = await service.detail(traceId, validQuery);

  assert.equal(result.summary.spanCount, 2_000);
  assert.equal(result.summary.truncated, true);
  assert.equal(result.spans.length, 2_000);
  assert.ok(result.spans.every((span) => !span.spanId.endsWith('2000')));
});

test('严格 allowlist 丢弃任意嵌套属性、坏 JSON 与超界值，并保留来源哈希', () => {
  const result = projectTraceDetail(projectionQuery(), [makeRow({
    spanId: 'legacy id with spaces',
    operation: 'http.server',
    model: 'gpt-4o-mini',
    inputTokens: 5,
    outputTokens: 2,
    attributes: {
      model: 'gpt-4o-mini',
      requested_model: 'gpt-4o-mini',
      topK: 101,
      sources: [HASH_A, 'secret-canary-not-a-hash'],
      'rag.recalled_count': 3,
      'rag.recall_ms': 12.5,
      'rag.rerank_before': {
        items: [{ idHash: HASH_B, rank: 1, score: 0.91, payload: 'secret-canary-payload' }],
        total_count: 1,
        truncated: false,
        url: 'https://private.example',
      },
      'ai.error_category': 'provider_error',
      'http.method': 'POST',
      'http.status_code': 201,
      prompt: 'secret-canary-prompt',
      response: 'secret-canary-response',
      payload: 'secret-canary-payload',
      url: 'https://private.example/secret-canary',
      stack: 'secret-canary-stack',
      arbitrary: { nested: 'secret-canary-nested' },
    },
  })]);
  const attrs = result.spans[0].attributes;

  assert.equal(result.spans[0].spanId, 'legacy id with spaces');
  assert.equal(result.summary.totalTokens, 7, 'a non-empty safe model column follows list token semantics');
  assert.deepEqual(Object.keys(attrs).sort(), [
    'ai.error_category', 'http.method', 'http.status_code', 'model', 'rag.recalled_count',
    'rag.recall_ms', 'rag.rerank_before', 'requested_model',
  ].sort());
  assert.deepEqual(attrs['rag.rerank_before'], {
    items: [{ idHash: HASH_B, rank: 1, score: 0.91 }], total_count: 1, truncated: false,
  });
  assert.doesNotMatch(JSON.stringify(result), /secret-canary|private\.example|"payload"|"url"|"stack"/i);

  const unsafeModel = projectTraceDetail(projectionQuery(), [makeRow({
    spanId: 'model-filtered', operation: 'custom.root', model: 'model name that fails public validation',
    inputTokens: 8, outputTokens: 4,
  })]);
  assert.equal(unsafeModel.spans[0].model, null);
  assert.equal(unsafeModel.summary.totalTokens, 12, 'the raw non-empty model still follows list token semantics');

  const badJson = projectTraceDetail(projectionQuery(), [makeRow({ spanId: 'bad-attributes', attributes: '{invalid-json' })]);
  assert.deepEqual(badJson.spans[0].attributes, {});
});

test('项目或 trace 不存在为 404，且缺失项目时不访问 ClickHouse', async () => {
  const missingProject = createHarness({ projectExists: false });
  await assert.rejects(missingProject.service.detail(traceId, validQuery), statusIs(404));
  assert.equal(missingProject.clickHouseCalls.length, 0);

  const missingTrace = createHarness({ rows: [] });
  await assert.rejects(missingTrace.service.detail(traceId, validQuery), statusIs(404));
});

test('依赖故障与坏存储行返回固定安全 503，query 校验仍保留 400/403', async () => {
  const failures = [
    createHarness({ databaseError: new Error('database password secret-canary') }),
    createHarness({ clickHouseError: new Error('SQL and raw attributes secret-canary') }),
    createHarness({ rows: [makeRow({ spanId: 'bad-row', status: 'unexpected-storage-status' })] }),
  ];
  for (const harness of failures) {
    await assert.rejects(harness.service.detail(traceId, validQuery), (error) => {
      assert.equal(error.getStatus(), 503);
      assert.equal(error.message, 'Trace data is unavailable');
      assert.doesNotMatch(JSON.stringify(error.getResponse()), /password|SQL|secret-canary|unexpected-storage-status/i);
      return true;
    });
  }

  const invalid = createHarness();
  await assert.rejects(invalid.service.detail(traceId, { ...validQuery, from: undefined }), statusIs(400));
  await assert.rejects(invalid.service.detail(traceId, { ...validQuery, includeContent: 'true' }), statusIs(403));
  assert.equal(invalid.databaseCalls.length, 0);
  assert.equal(invalid.clickHouseCalls.length, 0);

  const mismatchedProjectResult = createHarness({ projectExists: false });
  mismatchedProjectResult.service.database.query = async () => ({ rows: [{ id: 'other-project' }] });
  await assert.rejects(mismatchedProjectResult.service.detail(traceId, validQuery), (error) => {
    assert.equal(error.getStatus(), 503);
    assert.equal(error.message, 'Trace data is unavailable');
    return true;
  });
});
