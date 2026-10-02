import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const outputDir = process.env.METRICS_OVERVIEW_TEST_OUTPUT_DIR
  ?? fileURLToPath(new URL('../dist/', import.meta.url));
const fromOutput = (file) => require(path.join(outputDir, file));
const { MetricsOverviewService } = fromOutput('metrics/metrics-overview.service.js');
const { parseMetricsQuery } = fromOutput('metrics/metrics-query.js');
const { MetricsController } = fromOutput('metrics/metrics.controller.js');
const { AdminTokenGuard } = fromOutput('admin/admin-token.guard.js');
const { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { RequestMethod } = require('@nestjs/common');

const projectId = 'b35a64bb-8a12-4806-9e77-8831870a5dd0';
const generatedAt = new Date('2026-10-02T10:30:00.000Z');
const traceId = 'trace_v1_01234567-89ab-cdef-0123-456789abcdef';

function emptyRows() {
  return {
    metrics: [{
      request_count: 0,
      error_count: 0,
      latency_quantiles: [0, 0, 0],
      total_tokens: 0,
    }],
    series: [],
    services: [],
    recentErrors: [],
    topModels: [],
  };
}

function createHarness({
  serviceNames = ['alpha'],
  rows = emptyRows(),
  projectExists = true,
  databaseError,
  clickHouseError,
} = {}) {
  const databaseCalls = [];
  const clickHouseCalls = [];
  const database = {
    async query(sql, values = []) {
      databaseCalls.push({ sql, values });
      if (databaseError) throw databaseError;
      if (sql.includes('FROM projects')) {
        return { rows: projectExists ? [{ id: projectId }] : [] };
      }
      if (sql.includes('FROM services')) {
        return { rows: serviceNames.map((name) => ({ name })) };
      }
      throw new Error(`Unexpected PostgreSQL query: ${sql}`);
    },
  };
  const clickhouse = {
    async query(sql, queryParams) {
      clickHouseCalls.push({ sql, queryParams });
      if (clickHouseError) throw clickHouseError;
      if (sql.includes('token_metrics AS')) return rows.metrics;
      if (sql.includes('GROUP BY bucket_start')) return rows.series;
      if (sql.includes('GROUP BY service')) return rows.services;
      if (/LIMIT 20\b/.test(sql)) return rows.recentErrors;
      if (sql.includes('LIMIT 101')) return rows.topModels;
      throw new Error(`Unexpected ClickHouse query: ${sql}`);
    },
  };
  const service = new MetricsOverviewService(database, clickhouse);
  service.now = () => generatedAt;
  return { service, databaseCalls, clickHouseCalls };
}

function hasHttpStatus(status) {
  return (error) => error?.getStatus?.() === status;
}

function rawQuery(overrides = {}) {
  return { projectId, ...overrides };
}

test('query parser accepts paired UTC custom bounds and service grouping, rejects ambiguous ranges', () => {
  const parsed = parseMetricsQuery(rawQuery({
    from: '2026-10-01T00:07:00.000Z',
    to: '2026-10-01T03:02:00.000Z',
    groupBy: 'service',
  }), generatedAt.getTime());
  assert.equal(parsed.range, 'custom');
  assert.equal(parsed.fromMs, Date.parse('2026-10-01T00:07:00.000Z'));
  assert.equal(parsed.toMs, Date.parse('2026-10-01T03:02:00.000Z'));
  assert.equal(parsed.bucketMs, 15 * 60_000);
  assert.equal(parsed.bucketInterval, 'INTERVAL 15 MINUTE');
  assert.equal(parsed.groupBy, 'service');

  for (const query of [
    rawQuery({ from: '2026-10-01T00:00:00.000Z' }),
    rawQuery({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-01T01:00:00.000Z', range: '1h' }),
    rawQuery({ from: '2026-10-01T00:00:00+00:00', to: '2026-10-01T01:00:00.000Z' }),
    rawQuery({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }),
    rawQuery({ from: '2026-08-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }),
    rawQuery({ groupBy: 'operation' }),
    rawQuery({ projectId, unexpected: 'value' }),
  ]) {
    assert.throws(() => parseMetricsQuery(query, generatedAt.getTime()), hasHttpStatus(400));
  }
});

test('GET /metrics/overview is guarded by AdminTokenGuard', () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, MetricsController), 'metrics');
  assert.ok(Reflect.getMetadata(GUARDS_METADATA, MetricsController).includes(AdminTokenGuard));
  assert.equal(Reflect.getMetadata(PATH_METADATA, MetricsController.prototype.getOverview), 'overview');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, MetricsController.prototype.getOverview), RequestMethod.GET);
});

test('five bounded ClickHouse queries share the exact dedup and parameter isolation contract', async () => {
  const serviceFilter = "alpha' OR 1=1 --";
  const { service, databaseCalls, clickHouseCalls } = createHarness();
  await service.getOverview(rawQuery({ environment: 'staging', range: '24h', service: serviceFilter }));

  assert.equal(databaseCalls.length, 2);
  assert.deepEqual(databaseCalls[0].values, [projectId]);
  assert.deepEqual(databaseCalls[1].values, [projectId, 'staging', serviceFilter]);
  assert.equal(clickHouseCalls.length, 5);
  for (const { sql, queryParams } of clickHouseCalls) {
    assert.doesNotMatch(sql, new RegExp(projectId));
    assert.doesNotMatch(sql, /alpha' OR 1=1/);
    assert.deepEqual(queryParams, {
      projectId,
      environment: 'staging',
      fromMs: Date.parse('2026-10-01T10:30:00.000Z'),
      toMs: generatedAt.getTime(),
      service: serviceFilter,
    });
    assert.match(sql, /FROM trace_spans/);
    assert.match(sql, /project_id = \{projectId:String\}/);
    assert.match(sql, /environment:String/);
    assert.match(sql, /fromMs:Int64/);
    assert.match(sql, /toMs:Int64/);
    assert.match(sql, /argMax\(/);
    assert.match(sql, /GROUP BY project_id, environment, trace_id, span_id/);
    const rawGroup = sql.indexOf('GROUP BY project_id, environment, trace_id, span_id');
    const rawScope = sql.slice(sql.indexOf('FROM trace_spans'), rawGroup);
    assert.doesNotMatch(rawScope, /\{service:String\}/, 'service selection must happen after raw deduplication');
    assert.match(sql, /HAVING \{service:String\} = '' OR countIf\(service = \{service:String\}\) > 0/);
    assert.match(sql, /GROUP BY project_id, environment, trace_id\s+HAVING/);
  }

  const metricsSql = clickHouseCalls.find(({ sql }) => sql.includes('token_metrics AS'))?.sql;
  assert.match(metricsSql, /count\(\) AS request_count[\s\S]*FROM trace_rows\s+WHERE request_root_count > 0/);
  assert.match(metricsSql, /countIf\(error_span_count > 0\) AS error_count/);
  assert.match(metricsSql, /quantilesExact\(0\.5, 0\.95, 0\.99\)\(duration_ms\)/);
  assert.match(metricsSql, /sum\(token_total\) AS total_tokens/);
  assert.match(metricsSql, /sumIf\(total_tokens, operation = 'llm\.generate'\)/);
  assert.doesNotMatch(metricsSql, /model != ''/);
  assert.match(metricsSql, /parent_span_id = '' AND operation NOT IN \('browser\.web_vital', 'browser\.javascript_error', 'browser\.unhandled_rejection'\)/);

  const seriesSql = clickHouseCalls.find(({ sql }) => sql.includes('GROUP BY bucket_start'))?.sql;
  assert.match(seriesSql, /sum\(token_total\) AS total_tokens/);
  const serviceSql = clickHouseCalls.find(({ sql }) => sql.includes('GROUP BY service'))?.sql;
  assert.match(serviceSql, /INNER JOIN trace_rows USING \(project_id, environment, trace_id\)/);
  assert.match(serviceSql, /count\(\) AS request_count/);
  assert.match(serviceSql, /quantilesExact\(0\.5, 0\.95, 0\.99\)/);
  const errorsSql = clickHouseCalls.find(({ sql }) => /LIMIT 20\b/.test(sql))?.sql;
  assert.match(errorsSql, /WHERE request_root_count > 0 AND error_span_count > 0/);
  assert.match(errorsSql, /ORDER BY started_at DESC, trace_id ASC, environment ASC/);
  assert.doesNotMatch(errorsSql.slice(errorsSql.lastIndexOf('SELECT')), /\berror\s*,|attributes|prompt/i);
  const topModelsSql = clickHouseCalls.find(({ sql }) => sql.includes('LIMIT 101'))?.sql;
  assert.match(topModelsSql, /operation = 'llm\.generate'/);
  assert.ok(topModelsSql.includes("match(normalized_spans.model, '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$')"));
  assert.match(topModelsSql, /GROUP BY safe_model[\s\S]*LIMIT 101/);
});

test('root, child, multiple-root, duplicate-span and rootless-token fixture preserves trace semantics', async () => {
  // The fixture includes duplicate delivery, two qualifying roots for one
  // trace, a failed child, a browser-only observation, and a rootless LLM call.
  const fixture = [
    { trace: 'multi-root', span: 'root-a', parent: '', operation: 'http.server', status: 'ok', tokens: 0 },
    { trace: 'multi-root', span: 'root-a', parent: '', operation: 'http.server', status: 'ok', tokens: 0 },
    { trace: 'multi-root', span: 'root-b', parent: '', operation: 'http.server.retry', status: 'ok', tokens: 0 },
    { trace: 'multi-root', span: 'child', parent: 'root-a', operation: 'llm.generate', status: 'error', tokens: 40 },
    { trace: 'request-b', span: 'root', parent: '', operation: 'http.server', status: 'ok', tokens: 0 },
    { trace: 'browser-only', span: 'vital', parent: '', operation: 'browser.web_vital', status: 'ok', tokens: 0 },
    { trace: 'rootless-llm', span: 'llm', parent: 'missing-parent', operation: 'llm.generate', status: 'ok', tokens: 25 },
    { trace: 'rootless-llm', span: 'llm', parent: 'missing-parent', operation: 'llm.generate', status: 'ok', tokens: 25 },
  ];
  const deduplicatedKeys = new Set(fixture.map((row) => `${row.trace}/${row.span}`));
  assert.equal(deduplicatedKeys.size, 6);

  const rows = emptyRows();
  rows.metrics[0] = {
    request_count: '2', // the multi-root trace counts once; rootless/browser traces do not count
    error_count: '1', // a failed child makes its request trace an error
    latency_quantiles: [125, 250, 500],
    total_tokens: '65', // includes the rootless llm.generate call after span deduplication
  };
  rows.series = [{
    bucket_start: '2026-10-02 10:00:00.000',
    request_count: '2',
    error_count: '1',
    total_tokens: '65',
  }];
  rows.services = [{
    name: 'alpha', request_count: '6', error_count: '1',
    latency_quantiles: [20, 100, 250], last_seen_at: '2026-10-02 10:29:59.000',
  }];
  rows.recentErrors = [{
    trace_id: traceId,
    environment: 'dev',
    service: 'alpha',
    operation: 'http.server',
    start_time: '2026-10-02 10:27:00.000',
    duration_ms: '250',
    error: 'private error body',
    attributes: '{"prompt":"private prompt"}',
    prompt: 'private prompt',
  }];
  rows.topModels = [{
    model: 'gpt-4o-mini', call_count: '2', total_tokens: '65', latency_quantiles: [180],
    error: 'private error body', attributes: '{"prompt":"private prompt"}',
  }];
  const { service, clickHouseCalls } = createHarness({ serviceNames: ['alpha', 'beta'], rows });
  const result = await service.getOverview(rawQuery({ range: '1h' }));

  assert.deepEqual(result.metrics, {
    requestCount: 2,
    errorCount: 1,
    errorRate: 0.5,
    p50LatencyMs: 125,
    p95LatencyMs: 250,
    p99LatencyMs: 500,
    totalTokens: 65,
  });
  assert.deepEqual(result.summary, result.metrics);
  assert.equal(result.series.length, 60);
  assert.deepEqual(result.series[30], {
    bucketStart: '2026-10-02T10:00:00.000Z',
    requestCount: 2,
    errorCount: 1,
    errorRate: 0.5,
    totalTokens: 65,
  });
  assert.deepEqual(result.timeseries, result.series);
  assert.deepEqual(result.services, [
    {
      name: 'alpha', requestCount: 6, errorCount: 1, errorRate: 1 / 6,
      p50LatencyMs: 20, p95LatencyMs: 100, p99LatencyMs: 250,
      lastSeenAt: '2026-10-02T10:29:59.000Z', status: 'degraded',
    },
    {
      name: 'beta', requestCount: 0, errorCount: 0, errorRate: 0,
      p50LatencyMs: 0, p95LatencyMs: 0, p99LatencyMs: 0,
      lastSeenAt: null, status: 'no_data',
    },
  ]);
  assert.deepEqual(result.recentErrors, [{
    traceId,
    environment: 'dev',
    service: 'alpha',
    operation: 'http.server',
    startTime: '2026-10-02T10:27:00.000Z',
    durationMs: 250,
  }]);
  assert.deepEqual(result.topModels, [{
    model: 'gpt-4o-mini', callCount: 2, totalTokens: 65, p95LatencyMs: 180,
  }]);
  assert.doesNotMatch(JSON.stringify(result), /private prompt|private error body|attributes|"error"/);
  assert.deepEqual(Object.keys(result.recentErrors[0]).sort(), ['durationMs', 'environment', 'operation', 'service', 'startTime', 'traceId']);
  assert.deepEqual(Object.keys(result.topModels[0]).sort(), ['callCount', 'model', 'p95LatencyMs', 'totalTokens']);

  const metricsSql = clickHouseCalls.find(({ sql }) => sql.includes('token_metrics AS'))?.sql;
  assert.match(metricsSql, /countIf\(parent_span_id = '' AND operation NOT IN/);
  assert.match(metricsSql, /FROM trace_rows\s+WHERE request_root_count > 0/);
  assert.match(metricsSql, /GROUP BY project_id, environment, trace_id/);
  assert.match(metricsSql, /sumIf\(total_tokens, operation = 'llm\.generate'\)/);
  const dedupSql = clickHouseCalls[0].sql;
  assert.match(dedupSql, /argMax\([\s\S]*tuple\(event_time, end_time, start_time, parent_span_id, service, operation/);
});

test('empty results zero-fill default and grouped custom series, including partial edge buckets', async () => {
  const empty = createHarness({ serviceNames: ['alpha', 'beta'] });
  const result = await empty.service.getOverview(rawQuery({ range: '1h' }));
  assert.deepEqual(result.metrics, {
    requestCount: 0,
    errorCount: 0,
    errorRate: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
    p99LatencyMs: 0,
    totalTokens: 0,
  });
  assert.equal(result.series.length, 60);
  assert.ok(result.series.every((bucket) => bucket.requestCount === 0 && bucket.errorCount === 0 && bucket.errorRate === 0 && bucket.totalTokens === 0));
  assert.deepEqual(result.services.map(({ name, status, lastSeenAt }) => ({ name, status, lastSeenAt })), [
    { name: 'alpha', status: 'no_data', lastSeenAt: null },
    { name: 'beta', status: 'no_data', lastSeenAt: null },
  ]);
  assert.deepEqual(result.topModels, []);

  const grouped = createHarness({ serviceNames: ['alpha'] });
  const custom = await grouped.service.getOverview(rawQuery({
    from: '2026-10-01T00:07:00.000Z',
    to: '2026-10-01T03:02:00.000Z',
    groupBy: 'service',
    service: 'alpha',
  }));
  assert.deepEqual(custom.range, {
    key: 'custom',
    from: '2026-10-01T00:07:00.000Z',
    to: '2026-10-01T03:02:00.000Z',
  });
  assert.equal(custom.series.length, 13);
  assert.equal(custom.series[0].bucketStart, '2026-10-01T00:00:00.000Z');
  assert.equal(custom.series.at(-1).bucketStart, '2026-10-01T03:00:00.000Z');
  assert.ok(custom.series.every((bucket) => bucket.service === 'alpha' && bucket.requestCount === 0));
  assert.deepEqual(custom.timeseries, custom.series);
  const seriesCall = grouped.clickHouseCalls.find(({ sql }) => sql.includes('GROUP BY bucket_start'));
  assert.match(seriesCall.sql, /series_service AS service/);
  assert.match(seriesCall.sql, /INTERVAL 15 MINUTE/);
  assert.match(seriesCall.sql, /fromUnixTimestamp64Milli\(\{fromMs:Int64\}, 'UTC'\)/);
  assert.deepEqual(seriesCall.queryParams, {
    projectId,
    environment: 'all',
    fromMs: Date.parse('2026-10-01T00:07:00.000Z'),
    toMs: Date.parse('2026-10-01T03:02:00.000Z'),
    service: 'alpha',
  });

  const lateObservedRows = emptyRows();
  lateObservedRows.series = [{
    bucket_start: '2026-10-01 00:00:00.000',
    service: 'late-service', request_count: 1, error_count: 0, total_tokens: 0,
  }];
  const lateObserved = createHarness({ serviceNames: [], rows: lateObservedRows });
  const lateResult = await lateObserved.service.getOverview(rawQuery({
    from: '2026-10-01T00:07:00.000Z',
    to: '2026-10-01T03:02:00.000Z',
    groupBy: 'service',
  }));
  assert.equal(lateResult.series[0].service, 'late-service');
  assert.equal(lateResult.services[0].status, 'no_data');

  const longCustom = createHarness({ serviceNames: [] });
  const longResult = await longCustom.service.getOverview(rawQuery({
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-10-01T00:00:00.000Z',
  }));
  assert.equal(longResult.range.key, 'custom');
  assert.equal(longResult.series.length, 120);
  const longSeriesCall = longCustom.clickHouseCalls.find(({ sql }) => sql.includes('GROUP BY bucket_start'));
  assert.match(longSeriesCall.sql, /INTERVAL 6 HOUR/);
});

test('same trace id in different environments remains distinct in recent errors', async () => {
  const rows = emptyRows();
  rows.recentErrors = ['dev', 'prod'].map((environment) => ({
    trace_id: traceId,
    environment,
    service: 'alpha',
    operation: 'http.server',
    start_time: '2026-10-02 10:00:00.000',
    duration_ms: 10,
  }));
  const { service } = createHarness({ rows });
  const result = await service.getOverview(rawQuery({ environment: 'all', range: '1h' }));
  assert.deepEqual(result.recentErrors.map(({ environment }) => environment), ['dev', 'prod']);
  assert.equal(result.recentErrors[0].traceId, result.recentErrors[1].traceId);
});

test('invalid ClickHouse rows and query failures become a safe 503; missing projects stay 404', async () => {
  const missing = createHarness({ projectExists: false });
  await assert.rejects(missing.service.getOverview(rawQuery()), hasHttpStatus(404));
  assert.equal(missing.clickHouseCalls.length, 0);

  const invalidMetrics = emptyRows();
  invalidMetrics.metrics[0].request_count = '1; password leaked';
  const invalidTimestamp = emptyRows();
  invalidTimestamp.series = [{ bucket_start: 'not a timestamp', request_count: 0, error_count: 0, total_tokens: 0 }];
  const invalidService = emptyRows();
  invalidService.services = [{
    name: 'alpha', request_count: '-1', error_count: 0,
    latency_quantiles: [0, 0, 0], last_seen_at: '2026-10-02 10:00:00.000',
  }];
  const invalidError = emptyRows();
  invalidError.recentErrors = [{
    trace_id: 'invalid trace id', service: 'alpha', operation: 'http.server',
    start_time: '2026-10-02 10:00:00.000', duration_ms: 10,
  }];
  const invalidErrorEnvironment = emptyRows();
  invalidErrorEnvironment.recentErrors = [{
    trace_id: traceId, environment: 'production', service: 'alpha', operation: 'http.server',
    start_time: '2026-10-02 10:00:00.000', duration_ms: 10,
  }];
  const unsanitizedModel = emptyRows();
  unsanitizedModel.topModels = [{
    model: 'bad+model', call_count: 1, total_tokens: 1, latency_quantiles: [1],
  }];
  const tooManyModels = emptyRows();
  tooManyModels.topModels = Array.from({ length: 101 }, (_, index) => ({
    model: `model-${index}`, call_count: 1, total_tokens: 1, latency_quantiles: [1],
  }));
  const databaseFailure = createHarness({ databaseError: new Error('postgres password leaked') });
  const clickHouseFailure = createHarness({ clickHouseError: new Error('query and credential leaked') });

  for (const harness of [
    createHarness({ rows: invalidMetrics }),
    createHarness({ rows: invalidTimestamp }),
    createHarness({ rows: invalidService }),
    createHarness({ rows: invalidError }),
    createHarness({ rows: invalidErrorEnvironment }),
    createHarness({ rows: unsanitizedModel }),
    createHarness({ rows: tooManyModels }),
    databaseFailure,
    clickHouseFailure,
  ]) {
    await assert.rejects(harness.service.getOverview(rawQuery()), (error) => {
      assert.equal(error.getStatus(), 503);
      assert.equal(error.message, 'Analytics data is unavailable');
      assert.doesNotMatch(JSON.stringify(error.getResponse()), /password|credential|bad\+model|invalid trace id/);
      return true;
    });
  }

  const invalidQuery = createHarness();
  await assert.rejects(
    invalidQuery.service.getOverview(rawQuery({ from: '2026-10-01T00:00:00.000Z' })),
    hasHttpStatus(400),
  );
  assert.equal(invalidQuery.databaseCalls.length, 0);
  assert.equal(invalidQuery.clickHouseCalls.length, 0);
});
