import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const outputDir = process.env.AI_METRICS_TEST_OUTPUT_DIR
  ?? fileURLToPath(new URL('../dist/', import.meta.url));
const { AiMetricsService } = require(path.join(outputDir, 'metrics', 'ai-metrics.service.js'));

const projectId = 'b35a64bb-8a12-4806-9e77-8831870a5dd0';
const generatedAtMs = Date.parse('2026-10-02T11:00:00.000Z');

function llmRow(overrides = {}) {
  return {
    call_count: '3',
    error_count: '1',
    invalid_status_count: '0',
    invalid_duration_count: '0',
    input_tokens: '100',
    output_tokens: '40',
    total_tokens: '140',
    p50_latency_ms: '25.5',
    p95_latency_ms: '48',
    p99_latency_ms: '49',
    ttft_sample_count: '2',
    p50_ttft_ms: '12',
    p95_ttft_ms: '18',
    p99_ttft_ms: '19',
    ...overrides,
  };
}

function ragRow(overrides = {}) {
  return {
    call_count: '4',
    success_count: '3',
    error_count: '1',
    invalid_status_count: '0',
    invalid_duration_count: '0',
    empty_recall_count: '1',
    observed_recall_count: '2',
    p50_latency_ms: '8',
    p95_latency_ms: '24.5',
    p99_latency_ms: '26',
    recall_sample_count: '2',
    p95_recall_ms: '15',
    rerank_sample_count: '1',
    p95_rerank_ms: '0',
    ...overrides,
  };
}

function zeroLlmRow() {
  return llmRow({
    call_count: '0', error_count: '0', input_tokens: '0', output_tokens: '0', total_tokens: '0',
    p50_latency_ms: '0', p95_latency_ms: '0', p99_latency_ms: '0', ttft_sample_count: '0',
    p50_ttft_ms: '0', p95_ttft_ms: '0', p99_ttft_ms: '0',
  });
}

function zeroRagRow() {
  return ragRow({
    call_count: '0', success_count: '0', error_count: '0', empty_recall_count: '0', observed_recall_count: '0',
    p50_latency_ms: '0', p95_latency_ms: '0', p99_latency_ms: '0', recall_sample_count: '0', p95_recall_ms: '0',
    rerank_sample_count: '0', p95_rerank_ms: '0',
  });
}

function createHarness({
  projectExists = true,
  databaseError,
  clickHouseError,
  llmRows = [llmRow()],
  modelRows = [
    { model: 'gpt-4.1-mini', ...llmRow({ call_count: '2', error_count: '0', input_tokens: '70', output_tokens: '20', total_tokens: '90', p50_latency_ms: '22', p95_latency_ms: '38', p99_latency_ms: '39', ttft_sample_count: '2', p50_ttft_ms: '12', p95_ttft_ms: '18', p99_ttft_ms: '19' }) },
    { model: '(unknown)', ...llmRow({ call_count: '1', error_count: '1', input_tokens: '30', output_tokens: '20', total_tokens: '50', p50_latency_ms: '35', p95_latency_ms: '35', p99_latency_ms: '35', ttft_sample_count: '0', p50_ttft_ms: '0', p95_ttft_ms: '0', p99_ttft_ms: '0' }) },
  ],
  ragRows = [ragRow()],
} = {}) {
  const databaseCalls = [];
  const clickHouseCalls = [];
  const database = {
    async query(sql, values = []) {
      databaseCalls.push({ sql, values });
      if (databaseError) throw databaseError;
      if (sql.includes('SELECT id FROM projects')) {
        return { rows: projectExists ? [{ id: projectId }] : [] };
      }
      throw new Error('Unexpected PostgreSQL query');
    },
  };
  const clickhouse = {
    async query(sql, queryParams) {
      clickHouseCalls.push({ sql, queryParams });
      if (clickHouseError) throw clickHouseError;
      if (sql.includes('GROUP BY display_model')) return modelRows;
      if (sql.includes('FROM rag_spans')) return ragRows;
      if (sql.includes('FROM llm_spans')) return llmRows;
      throw new Error('Unexpected ClickHouse query');
    },
  };
  const service = new AiMetricsService(database, clickhouse);
  service.now = () => generatedAtMs;
  return { service, databaseCalls, clickHouseCalls };
}

function hasHttpStatus(status) {
  return (error) => error?.getStatus?.() === status;
}

test('AI metrics use three bound, post-dedup queries and return ratios plus model/RAG aggregates', async () => {
  const { service, databaseCalls, clickHouseCalls } = createHarness({
    modelRows: [
      { model: 'gpt-4.1-mini', ...llmRow({ call_count: '2', error_count: '0', input_tokens: '70', output_tokens: '20', total_tokens: '90', p50_latency_ms: '22', p95_latency_ms: '38', p99_latency_ms: '39', ttft_sample_count: '2', p50_ttft_ms: '12', p95_ttft_ms: '18', p99_ttft_ms: '19' }) },
      { model: 'private model canary', ...llmRow({ call_count: '1', error_count: '1', input_tokens: '30', output_tokens: '20', total_tokens: '50', p50_latency_ms: '35', p95_latency_ms: '35', p99_latency_ms: '35', ttft_sample_count: '0', p50_ttft_ms: '0', p95_ttft_ms: '0', p99_ttft_ms: '0', prompt: 'private-prompt-canary', error: 'private-error-canary', attributes: '{"prompt":"private-attribute-canary"}' }) },
    ],
  });
  const result = await service.getMetrics({ projectId, environment: 'staging', range: '1h', service: 'worker' });

  assert.equal(databaseCalls.length, 1);
  assert.deepEqual(databaseCalls[0].values, [projectId]);
  assert.equal(clickHouseCalls.length, 3);
  for (const { sql, queryParams } of clickHouseCalls) {
    assert.deepEqual(queryParams, {
      projectId,
      environment: 'staging',
      fromMs: generatedAtMs - 60 * 60 * 1000,
      toMs: generatedAtMs,
      service: 'worker',
    });
    assert.doesNotMatch(sql, new RegExp(projectId));
    assert.doesNotMatch(sql, /2026-10-02|staging|worker/);
    assert.match(sql, /GROUP BY project_id, environment, trace_id, span_id/);
    assert.match(sql, /WHERE \(\{service:String\} = '' OR service = \{service:String\}\)/);
    assert.ok(sql.indexOf('WHERE ({service:String}') > sql.indexOf('GROUP BY project_id, environment, trace_id, span_id'));
  }

  const llmSql = clickHouseCalls.find(({ sql }) => sql.includes("operation = 'llm.generate'"))?.sql;
  const ragSql = clickHouseCalls.find(({ sql }) => sql.includes("operation = 'rag.retrieve'"))?.sql;
  const modelSql = clickHouseCalls.find(({ sql }) => sql.includes('GROUP BY display_model'))?.sql;
  assert.match(llmSql, /quantilesExact\(0\.5, 0\.95, 0\.99\)\(duration_ms\)/);
  assert.match(llmSql, /quantilesExactIf\(0\.5, 0\.95, 0\.99\)\(ttft_ms, ttft_valid\)/);
  assert.match(modelSql, /match\(model, '\^\[A-Za-z0-9\]\[A-Za-z0-9\._:\/-\]\{0,119\}\$'\)/);
  assert.match(modelSql, /LIMIT 101/);
  assert.match(ragSql, /JSONType\(safe_attributes, 'rag\.recalled_count'\)/);
  assert.match(ragSql, /JSONType\(safe_attributes, 'rag\.recalled_count'\) IN \('Int64', 'UInt64', 'Double'\)/);
  assert.doesNotMatch(ragSql, /recalledCount/);
  assert.match(ragSql, /JSONType\(safe_attributes, 'rag\.recall_ms'\) IN \('Int64', 'UInt64', 'Double'\)/);
  assert.match(ragSql, /JSONType\(safe_attributes, 'rag\.rerank_ms'\) IN \('Int64', 'UInt64', 'Double'\)/);
  assert.match(llmSql, /JSONType\(safe_attributes, 'llm\.ttft_ms'\) IN \('Int64', 'UInt64', 'Double'\)/);
  assert.doesNotMatch(`${llmSql}\n${ragSql}`, /'Float64'/);

  assert.deepEqual(result, {
    generatedAt: '2026-10-02T11:00:00.000Z',
    range: { key: '1h', from: '2026-10-02T10:00:00.000Z', to: '2026-10-02T11:00:00.000Z' },
    llm: {
      callCount: 3, errorCount: 1, errorRate: 1 / 3,
      inputTokens: 100, outputTokens: 40, totalTokens: 140,
      p50LatencyMs: 25.5, p95LatencyMs: 48, p99LatencyMs: 49,
      ttftSampleCount: 2, p50TtftMs: 12, p95TtftMs: 18, p99TtftMs: 19,
      models: [
        {
          model: 'gpt-4.1-mini', callCount: 2, errorCount: 0, errorRate: 0,
          inputTokens: 70, outputTokens: 20, totalTokens: 90,
          p50LatencyMs: 22, p95LatencyMs: 38, p99LatencyMs: 39,
          ttftSampleCount: 2, p50TtftMs: 12, p95TtftMs: 18, p99TtftMs: 19,
        },
        {
          model: '(unknown)', callCount: 1, errorCount: 1, errorRate: 1,
          inputTokens: 30, outputTokens: 20, totalTokens: 50,
          p50LatencyMs: 35, p95LatencyMs: 35, p99LatencyMs: 35,
          ttftSampleCount: 0, p50TtftMs: 0, p95TtftMs: 0, p99TtftMs: 0,
        },
      ],
    },
    rag: {
      callCount: 4, successCount: 3, errorCount: 1, successRate: 0.75,
      emptyRecallCount: 1, observedRecallCount: 2, emptyRecallRate: 0.5,
      p50LatencyMs: 8, p95LatencyMs: 24.5, p99LatencyMs: 26,
      recallSampleCount: 2, p95RecallMs: 15, rerankSampleCount: 1, p95RerankMs: 0,
    },
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private-(?:model|prompt|error|attribute)-canary/);
  assert.equal('attributes' in result.llm, false);
  assert.equal('error' in result.llm, false);
});

test('missing or invalid timing and recall values produce zero samples and no observed empty-recall rate', async () => {
  const { service, clickHouseCalls } = createHarness({
    llmRows: [zeroLlmRow()],
    modelRows: [],
    ragRows: [zeroRagRow()],
  });
  const result = await service.getMetrics({ projectId, range: '1h' });
  const llmSql = clickHouseCalls.find(({ sql }) => sql.includes("operation = 'llm.generate'"))?.sql;
  const ragSql = clickHouseCalls.find(({ sql }) => sql.includes("operation = 'rag.retrieve'"))?.sql;

  assert.equal(result.llm.ttftSampleCount, 0);
  assert.equal(result.llm.p95TtftMs, 0);
  assert.equal(result.rag.observedRecallCount, 0);
  assert.equal(result.rag.emptyRecallCount, 0);
  assert.equal(result.rag.emptyRecallRate, null);
  assert.equal(result.rag.recallSampleCount, 0);
  assert.equal(result.rag.p95RecallMs, 0);
  assert.equal(result.rag.rerankSampleCount, 0);
  assert.equal(result.rag.p95RerankMs, 0);
  assert.match(llmSql, /length\(attributes\) <= 16384 AND isValidJSON\(attributes\)/);
  assert.match(llmSql, /JSONType\(safe_attributes, 'llm\.ttft_ms'\) IN \('Int64', 'UInt64', 'Double'\)/);
  assert.match(llmSql, /BETWEEN 0 AND 120000/);
  assert.match(ragSql, /countIf\(status = 'ok' AND recalled_count_valid\)/);
  assert.match(ragSql, /countIf\(status = 'ok' AND recalled_count_valid AND recalled_count = 0\)/);
  assert.match(ragSql, /JSONExtractFloat\(safe_attributes, 'rag\.recalled_count'\) = floor/);
  assert.match(ragSql, /isFinite\(JSONExtractFloat\(safe_attributes, 'rag\.recalled_count'\)\)/);
  assert.match(ragSql, /JSONExtractFloat\(safe_attributes, 'rag\.recalled_count'\) <= 100/);
});

test('only valid canonical recall counts on successful calls enter the empty-recall denominator', async () => {
  const { service } = createHarness({
    ragRows: [ragRow({
      call_count: '8', success_count: '8', error_count: '0',
      empty_recall_count: '1', observed_recall_count: '2',
    })],
  });
  const result = await service.getMetrics({ projectId });

  assert.equal(result.rag.successCount, 8);
  assert.equal(result.rag.observedRecallCount, 2);
  assert.equal(result.rag.emptyRecallCount, 1);
  assert.equal(result.rag.emptyRecallRate, 0.5);
});

test('a measured zero TTFT remains one valid timing sample', async () => {
  const { service } = createHarness({
    llmRows: [llmRow({ ttft_sample_count: '1', p50_ttft_ms: '0', p95_ttft_ms: '0', p99_ttft_ms: '0' })],
  });
  const result = await service.getMetrics({ projectId });

  assert.equal(result.llm.ttftSampleCount, 1);
  assert.equal(result.llm.p50TtftMs, 0);
  assert.equal(result.llm.p95TtftMs, 0);
});

test('independent total and model reads may differ during continuous ingestion', async () => {
  const { service } = createHarness({
    modelRows: [{ model: 'gpt-4.1-mini', ...llmRow({ call_count: '1', error_count: '0', input_tokens: '8', output_tokens: '4', total_tokens: '12', ttft_sample_count: '1' }) }],
  });
  const result = await service.getMetrics({ projectId });

  assert.equal(result.llm.callCount, 3);
  assert.equal(result.llm.models.length, 1);
  assert.equal(result.llm.models[0].callCount, 1);
});

test('more than 100 model groups fail closed instead of returning partial totals', async () => {
  const modelRows = Array.from({ length: 101 }, (_, index) => ({
    model: `model-${index}`,
    ...llmRow({ call_count: '1', error_count: '0', input_tokens: '1', output_tokens: '1', total_tokens: '2', ttft_sample_count: '0', p50_ttft_ms: '0', p95_ttft_ms: '0', p99_ttft_ms: '0' }),
  }));
  const { service } = createHarness({ modelRows });
  await assert.rejects(service.getMetrics({ projectId }), (error) => {
    assert.equal(error.getStatus(), 503);
    assert.deepEqual(error.getResponse(), { message: 'Analytics data is unavailable', error: 'Service Unavailable', statusCode: 503 });
    return true;
  });
});

test('missing project is 404; database, ClickHouse, and malformed aggregate failures are safe 503s', async () => {
  const missing = createHarness({ projectExists: false });
  await assert.rejects(missing.service.getMetrics({ projectId }), hasHttpStatus(404));
  assert.equal(missing.clickHouseCalls.length, 0);

  const databaseFailure = createHarness({ databaseError: new Error('postgres password canary') });
  await assert.rejects(databaseFailure.service.getMetrics({ projectId }), (error) => {
    assert.equal(error.getStatus(), 503);
    assert.doesNotMatch(JSON.stringify(error.getResponse()), /postgres password canary/);
    return true;
  });

  const clickHouseFailure = createHarness({ clickHouseError: new Error('private SQL and token canary') });
  await assert.rejects(clickHouseFailure.service.getMetrics({ projectId }), (error) => {
    assert.equal(error.getStatus(), 503);
    assert.doesNotMatch(JSON.stringify(error.getResponse()), /private SQL and token canary/);
    return true;
  });

  for (const invalid of [
    llmRow({ ttft_sample_count: '9', prompt: 'private-prompt-canary' }),
    llmRow({ invalid_status_count: '1' }),
    llmRow({ invalid_duration_count: '1' }),
  ]) {
    const invalidRow = createHarness({ llmRows: [invalid] });
    await assert.rejects(invalidRow.service.getMetrics({ projectId }), (error) => {
      assert.equal(error.getStatus(), 503);
      assert.doesNotMatch(JSON.stringify(error.getResponse()), /private-prompt-canary/);
      return true;
    });
  }
});
