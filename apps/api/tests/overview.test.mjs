import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OverviewController } = require('../dist/overview/overview.controller.js');
const { OverviewService } = require('../dist/overview/overview.service.js');
const { parseOverviewQuery } = require('../dist/overview/overview-query.js');
const { AdminTokenGuard } = require('../dist/admin/admin-token.guard.js');
const { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { RequestMethod } = require('@nestjs/common');

const projectId = 'b35a64bb-8a12-4806-9e77-8831870a5dd0';
const generatedAt = new Date('2026-09-26T10:30:00.000Z');

function createHarness({
  names = ['alpha'],
  metricRows = [{ request_count: 0, error_count: 0, p95_latency_ms: 0, total_tokens: 0 }],
  seriesRows = [],
  serviceRows = [],
  recentErrorRows = [],
  databaseError,
  clickHouseError,
  projectExists = true,
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
      if (sql.includes('SELECT DISTINCT name FROM services')) {
        return { rows: names.map((name) => ({ name })) };
      }
      throw new Error(`Unexpected PostgreSQL query in test: ${sql}`);
    },
  };
  const clickhouse = {
    async query(sql, queryParams) {
      clickHouseCalls.push({ sql, queryParams });
      if (clickHouseError) throw clickHouseError;
      if (sql.includes('quantileIf(0.95)(duration_ms') && sql.includes('sumIf(total_tokens')) return metricRows;
      if (sql.includes('GROUP BY bucket_start')) return seriesRows;
      if (sql.includes('GROUP BY service')) return serviceRows;
      if (sql.includes('LIMIT 20')) return recentErrorRows;
      throw new Error(`Unexpected ClickHouse query in test: ${sql}`);
    },
  };
  const service = new OverviewService(database, clickhouse);
  service.now = () => generatedAt;
  return {
    service,
    databaseCalls,
    clickHouseCalls,
  };
}

function assertHttpStatus(status) {
  return (error) => error?.getStatus?.() === status;
}

test('总览查询参数要求 UUID 并只接受支持的环境与时间范围', async () => {
  assert.deepEqual(parseOverviewQuery({ projectId: projectId.toUpperCase() }), {
    projectId,
    environment: 'all',
    range: '24h',
  });
  assert.deepEqual(parseOverviewQuery({ projectId, environment: 'staging', range: '7d' }), {
    projectId,
    environment: 'staging',
    range: '7d',
  });

  for (const query of [
    {},
    { projectId: ['b35a64bb-8a12-4806-9e77-8831870a5dd0'] },
    { projectId: 'not-a-uuid' },
    { projectId, environment: 'production' },
    { projectId, range: '30d' },
    { projectId, extra: 'unexpected' },
  ]) {
    assert.throws(() => parseOverviewQuery(query), assertHttpStatus(400));
  }

  const harness = createHarness();
  await assert.rejects(harness.service.getOverview({ projectId, range: '1h; DROP TABLE trace_spans' }), assertHttpStatus(400));
  assert.equal(harness.databaseCalls.length, 0);
  assert.equal(harness.clickHouseCalls.length, 0);
});

test('GET /overview 由 AdminTokenGuard 保护', () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, OverviewController), 'overview');
  assert.ok(Reflect.getMetadata(GUARDS_METADATA, OverviewController).includes(AdminTokenGuard));
  assert.equal(Reflect.getMetadata(METHOD_METADATA, OverviewController.prototype.getOverview), RequestMethod.GET);
});

test('ClickHouse 参数与 SQL 分离，项目、环境和时间均通过绑定参数传入', async () => {
  const { service, databaseCalls, clickHouseCalls } = createHarness();
  await service.getOverview({ projectId, environment: 'staging', range: '24h' });

  assert.deepEqual(databaseCalls[0].values, [projectId]);
  assert.deepEqual(databaseCalls[1].values, [projectId, 'staging']);
  assert.equal(clickHouseCalls.length, 4);
  for (const call of clickHouseCalls) {
    assert.doesNotMatch(call.sql, new RegExp(projectId));
    assert.doesNotMatch(call.sql, /staging|2026-09-25|2026-09-26/);
    assert.match(call.sql, /FROM trace_spans/i);
    assert.doesNotMatch(call.sql, /observability\.trace_spans/i);
    assert.deepEqual(call.queryParams, {
      projectId,
      environment: 'staging',
      fromMs: Date.parse('2026-09-25T10:30:00.000Z'),
      toMs: Date.parse('2026-09-26T10:30:00.000Z'),
    });
  }
  assert.ok(clickHouseCalls.every(({ sql }) => sql.includes('INTERVAL 15 MINUTE') || !sql.includes('toStartOfInterval')));
  const requestQuery = clickHouseCalls.find(({ sql }) => sql.includes('toStartOfInterval'))?.sql;
  const metricsQuery = clickHouseCalls.find(({ sql }) => sql.includes('sumIf(total_tokens'))?.sql;
  assert.match(requestQuery, /parent_span_id = ''/, 'Request trends must count root Spans, not every child operation');
  assert.match(metricsQuery, /countIf\(parent_span_id = '' AND operation NOT IN/);
  assert.match(metricsQuery, /quantileIf\(0\.95\)\(duration_ms, parent_span_id = '' AND operation NOT IN/);
  for (const sql of [requestQuery, metricsQuery]) {
    assert.match(sql, /operation NOT IN \('browser.web_vital', 'browser.javascript_error', 'browser.unhandled_rejection'\)/);
    assert.doesNotMatch(sql, /NOT IN \([^)]*browser.network_error/, 'Browser failed network requests still participate in request metrics');
  }
  assert.match(metricsQuery, /model != '' OR operation = 'llm\.generate'/, 'Token totals must avoid counting parent/root copies');
});

test('空结果返回零指标、零填充时间序列及已登记服务的 no_data 状态', async () => {
  const { service } = createHarness({ names: ['alpha', 'beta'] });
  const result = await service.getOverview({ projectId, range: '1h' });

  assert.deepEqual(result.metrics, {
    requestCount: 0,
    errorCount: 0,
    errorRate: 0,
    p95LatencyMs: 0,
    totalTokens: 0,
  });
  assert.equal(result.series.length, 60);
  assert.ok(result.series.every((bucket) => bucket.requestCount === 0 && bucket.errorCount === 0 && bucket.errorRate === 0));
  assert.deepEqual(result.services, ['alpha', 'beta'].map((name) => ({
    name,
    requestCount: 0,
    errorCount: 0,
    errorRate: 0,
    p95LatencyMs: 0,
    lastSeenAt: null,
    status: 'no_data',
  })));
  assert.deepEqual(result.recentErrors, []);
});

test('聚合结果映射为比例错误率、静态时间桶、服务健康状态和最近错误', async () => {
  const { service } = createHarness({
    names: ['alpha', 'beta', 'gamma'],
    metricRows: [{ request_count: '300', error_count: '3', p95_latency_ms: '123.5', total_tokens: '9876' }],
    seriesRows: [{ bucket_start: '2026-09-26 09:31:00.000', request_count: '100', error_count: '2' }],
    serviceRows: [
      { name: 'alpha', request_count: '100', error_count: '2', p95_latency_ms: '123.5', last_seen_at: '2026-09-26 10:28:00.000' },
      { name: 'beta', request_count: '200', error_count: '1', p95_latency_ms: '80', last_seen_at: '2026-09-26 10:29:00.000' },
    ],
    recentErrorRows: [{
      trace_id: 'trace-123',
      service: 'alpha',
      operation: 'llm.generate',
      start_time: '2026-09-26 10:29:00.000',
      duration_ms: '250.25',
      error: 'private prompt must not escape',
      attributes: '{"prompt":"private prompt"}',
      prompt: 'private prompt',
    }],
  });

  const result = await service.getOverview({ projectId, range: '1h' });
  assert.equal(result.generatedAt, generatedAt.toISOString());
  assert.deepEqual(result.range, {
    key: '1h',
    from: '2026-09-26T09:30:00.000Z',
    to: generatedAt.toISOString(),
  });
  assert.deepEqual(result.metrics, {
    requestCount: 300,
    errorCount: 3,
    errorRate: 0.01,
    p95LatencyMs: 123.5,
    totalTokens: 9876,
  });
  assert.deepEqual(result.series[1], {
    bucketStart: '2026-09-26T09:31:00.000Z',
    requestCount: 100,
    errorCount: 2,
    errorRate: 0.02,
  });
  assert.deepEqual(result.services, [
    {
      name: 'alpha', requestCount: 100, errorCount: 2, errorRate: 0.02,
      p95LatencyMs: 123.5, lastSeenAt: '2026-09-26T10:28:00.000Z', status: 'degraded',
    },
    {
      name: 'beta', requestCount: 200, errorCount: 1, errorRate: 0.005,
      p95LatencyMs: 80, lastSeenAt: '2026-09-26T10:29:00.000Z', status: 'healthy',
    },
    {
      name: 'gamma', requestCount: 0, errorCount: 0, errorRate: 0,
      p95LatencyMs: 0, lastSeenAt: null, status: 'no_data',
    },
  ]);
  assert.deepEqual(result.recentErrors, [{
    traceId: 'trace-123',
    service: 'alpha',
    operation: 'llm.generate',
    startTime: '2026-09-26T10:29:00.000Z',
    durationMs: 250.25,
  }]);
  assert.deepEqual(Object.keys(result.recentErrors[0]).sort(), ['durationMs', 'operation', 'service', 'startTime', 'traceId']);
});

test('错误列表 SQL 不读取 error、attributes 或 prompt，且最多返回 20 条', async () => {
  const { service, clickHouseCalls } = createHarness();
  await service.getOverview({ projectId });
  const errorQuery = clickHouseCalls.find(({ sql }) => sql.includes('LIMIT 20'))?.sql;

  assert.ok(errorQuery);
  assert.match(errorQuery, /SELECT trace_id, service, operation, start_time, duration_ms/i);
  assert.match(errorQuery, /status = 'error'/);
  assert.match(errorQuery, /LIMIT 20/);
  assert.doesNotMatch(errorQuery, /\berror\s*,|\battributes\b|\bprompt\b/i);
});

test('项目不存在返回 404，数据库与 ClickHouse 故障都映射成不含底层信息的 503', async () => {
  const missing = createHarness({ projectExists: false });
  await assert.rejects(missing.service.getOverview({ projectId }), assertHttpStatus(404));
  assert.equal(missing.clickHouseCalls.length, 0);

  const databaseFailure = createHarness({ databaseError: new Error('postgres password leaked') });
  await assert.rejects(databaseFailure.service.getOverview({ projectId }), (error) => {
    assert.equal(error.getStatus(), 503);
    assert.doesNotMatch(JSON.stringify(error.getResponse()), /postgres password leaked/);
    return true;
  });

  const clickHouseFailure = createHarness({ clickHouseError: new Error('query and password leaked') });
  await assert.rejects(clickHouseFailure.service.getOverview({ projectId }), (error) => {
    assert.equal(error.getStatus(), 503);
    assert.doesNotMatch(JSON.stringify(error.getResponse()), /query and password leaked/);
    return true;
  });
});
