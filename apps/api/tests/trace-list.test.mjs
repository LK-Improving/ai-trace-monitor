import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const outputDir = process.env.TRACE_LIST_TEST_OUTPUT_DIR
  ?? fileURLToPath(new URL('../dist/', import.meta.url));
const { TraceListService } = require(path.join(outputDir, 'traces', 'trace-list.service.js'));
const { parseTraceListQuery } = require(path.join(outputDir, 'traces', 'trace-query.js'));

const projectId = 'b35a64bb-8a12-4806-9e77-8831870a5dd0';
const from = '2026-09-30T00:00:00Z';
const to = '2026-10-01T00:00:00Z';

function rawQuery(overrides = {}) {
  return {
    projectId,
    environment: 'staging',
    from,
    to,
    page: '3',
    pageSize: '10',
    ...overrides,
  };
}

function traceRow(overrides = {}) {
  return {
    trace_id: 'trace_v1_01234567-89ab-cdef-0123-456789abcdef',
    environment: 'staging',
    root_operation: 'http.server',
    services: ['api', 'worker'],
    status: 'error',
    duration_ms: '1250',
    total_tokens: '42',
    started_at: '2026-09-30 12:00:00.123',
    span_count: '3',
    ...overrides,
  };
}

function createHarness({
  projectExists = true,
  databaseError,
  countRows = [{ total: '1' }],
  itemRows = [traceRow()],
  clickHouseError,
} = {}) {
  const databaseCalls = [];
  const clickHouseCalls = [];
  const callOrder = [];
  const database = {
    async query(sql, values) {
      databaseCalls.push({ sql, values });
      if (databaseError) throw databaseError;
      return { rows: projectExists ? [{ id: projectId }] : [] };
    },
  };
  const clickhouse = {
    async query(sql, queryParams) {
      clickHouseCalls.push({ sql, queryParams });
      if (sql.includes('SELECT count() AS total')) {
        callOrder.push('count');
        if (clickHouseError) throw clickHouseError;
        return countRows;
      }
      callOrder.push('page');
      if (clickHouseError) throw clickHouseError;
      return itemRows;
    },
  };
  return {
    service: new TraceListService(database, clickhouse),
    databaseCalls,
    clickHouseCalls,
    callOrder,
  };
}

function hasHttpStatus(status) {
  return (error) => error?.getStatus?.() === status;
}

test('列表查询校验时间窗并将项目、环境及可选过滤项作为绑定参数', async () => {
  const parsed = parseTraceListQuery(rawQuery({
    environment: 'all',
    traceId: 'trace_v1_01234567-89ab-cdef-0123-456789abcdef',
    service: "svc'); DROP TABLE trace_spans --",
    status: 'error',
  }));
  assert.equal(parsed.fromMs, Date.parse(from));
  assert.equal(parsed.toMs, Date.parse(to));

  for (const invalid of [
    rawQuery({ from: '2026-02-30T00:00:00Z' }),
    rawQuery({ from: '2026-09-30T00:00:00Z', to: '2026-09-30T00:00:00Z' }),
    rawQuery({ from: '2026-08-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }),
  ]) {
    assert.throws(() => parseTraceListQuery(invalid), hasHttpStatus(400));
  }

  const { service, databaseCalls, clickHouseCalls } = createHarness();
  await service.list(rawQuery({
    environment: 'all',
    traceId: 'trace_v1_01234567-89ab-cdef-0123-456789abcdef',
    service: "svc'); DROP TABLE trace_spans --",
    status: 'error',
  }));

  assert.equal(databaseCalls.length, 1);
  assert.match(databaseCalls[0].sql, /WHERE id = \$1/);
  assert.deepEqual(databaseCalls[0].values, [projectId]);
  assert.equal(clickHouseCalls.length, 2);
  for (const call of clickHouseCalls) {
    assert.doesNotMatch(call.sql, new RegExp(projectId));
    assert.doesNotMatch(call.sql, /DROP TABLE|trace_v1_01234567|2026-09-30|2026-10-01/);
    assert.deepEqual({
      projectId: call.queryParams.projectId,
      environment: call.queryParams.environment,
      fromMs: call.queryParams.fromMs,
      toMs: call.queryParams.toMs,
      traceId: call.queryParams.traceId,
      service: call.queryParams.service,
      status: call.queryParams.status,
    }, {
      projectId,
      environment: 'all',
      fromMs: Date.parse(from),
      toMs: Date.parse(to),
      traceId: 'trace_v1_01234567-89ab-cdef-0123-456789abcdef',
      service: "svc'); DROP TABLE trace_spans --",
      status: 'error',
    });
  }
});

test('先按项目、环境、trace 和 span 去重，再按整条 trace 聚合与筛选', async () => {
  const { service, clickHouseCalls } = createHarness();
  await service.list(rawQuery({ service: 'worker', status: 'error' }));

  const sql = clickHouseCalls[0].sql;
  assert.match(sql, /argMax\(\s*tuple\(parent_span_id, service, operation, status, start_time, end_time, total_tokens, model\)/);
  assert.match(sql, /GROUP BY project_id, trace_id, environment, span_id/);
  assert.match(sql, /sumIf\(total_tokens, model != '' OR operation = 'llm\.generate'\)/);
  assert.match(sql, /AS trace_status/);
  assert.match(sql, /AS token_total/);
  assert.doesNotMatch(sql, /attributes|\berror\b\s*(?:,|\))/i);

  const grouping = sql.indexOf('GROUP BY project_id, trace_id, environment\n  HAVING');
  const having = sql.slice(grouping);
  assert.notEqual(grouping, -1);
  assert.match(having, /countIf\(service = \{service:String\}\) > 0/);
  assert.match(having, /countIf\(status = 'error'\) > 0/);
  assert.match(having, /countIf\(status = 'error'\) = 0/);
  assert.doesNotMatch(sql.slice(sql.indexOf('WHERE project_id'), sql.indexOf('GROUP BY project_id, trace_id, environment, span_id')), /\{service:String\}|\{status:String\}/);
});

test('聚合列表映射安全字段、稳定分页和半开时间范围', async () => {
  const { service, clickHouseCalls, callOrder } = createHarness({
    itemRows: [traceRow({
      attributes: '{"prompt":"must not escape"}',
      error: 'private error body',
    })],
  });
  const result = await service.list(rawQuery({ service: 'worker', status: 'error' }));

  assert.deepEqual(callOrder, ['count', 'page']);
  assert.deepEqual(result, {
    items: [{
      traceId: 'trace_v1_01234567-89ab-cdef-0123-456789abcdef',
      environment: 'staging',
      rootOperation: 'http.server',
      services: ['api', 'worker'],
      status: 'error',
      durationMs: 1250,
      totalTokens: 42,
      startedAt: '2026-09-30T12:00:00.123Z',
      spanCount: 3,
    }],
    total: 1,
    page: 3,
    pageSize: 10,
    range: {
      from: '2026-09-30T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /prompt|private error body|attributes/);

  const pageCall = clickHouseCalls[1];
  assert.match(pageCall.sql, /ORDER BY started_at DESC, trace_id ASC, environment ASC/);
  assert.match(pageCall.sql, /trace_status AS status/);
  assert.match(pageCall.sql, /token_total AS total_tokens/);
  assert.match(pageCall.sql, /LIMIT \{pageSize:UInt64\}\s+OFFSET \{offset:UInt64\}/);
  assert.equal(pageCall.queryParams.pageSize, 10);
  assert.equal(pageCall.queryParams.offset, 20);
});

test('缺少根 span 时用最早 span 的 operation；空结果不执行分页查询', async () => {
  const withFallback = createHarness({
    itemRows: [traceRow({ root_operation: 'worker.task' })],
  });
  const fallbackResult = await withFallback.service.list(rawQuery());
  assert.equal(fallbackResult.items[0].rootOperation, 'worker.task');
  assert.match(withFallback.clickHouseCalls[1].sql, /argMin\(operation, tuple\(start_time, span_id, operation\)\)/);

  const empty = createHarness({ countRows: [{ total: '0' }] });
  assert.deepEqual(await empty.service.list(rawQuery()), {
    items: [],
    total: 0,
    page: 3,
    pageSize: 10,
    range: {
      from: '2026-09-30T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
    },
  });
  assert.deepEqual(empty.callOrder, ['count']);
});

test('项目不存在为 404，PG、ClickHouse 与异常存储结果统一安全 503', async () => {
  const missing = createHarness({ projectExists: false });
  await assert.rejects(missing.service.list(rawQuery()), hasHttpStatus(404));
  assert.equal(missing.clickHouseCalls.length, 0);

  const databaseFailure = createHarness({ databaseError: new Error('postgres password leaked') });
  const clickHouseFailure = createHarness({ clickHouseError: new Error('SQL and credential leaked') });
  const invalidCount = createHarness({ countRows: [{ total: 'NaN; secret' }] });
  const invalidTime = createHarness({ itemRows: [traceRow({ started_at: 'not a timestamp' })] });
  const invalidNumber = createHarness({ itemRows: [traceRow({ duration_ms: 'Infinity' })] });
  const invalidTraceId = createHarness({ itemRows: [traceRow({ trace_id: 'stored id is invalid' })] });
  const longRootOperation = createHarness({ itemRows: [traceRow({ root_operation: 'x'.repeat(161) })] });
  const tooManyServices = createHarness({ itemRows: [traceRow({ services: Array(121).fill('worker') })] });
  const longServiceName = createHarness({ itemRows: [traceRow({ services: ['x'.repeat(121)] })] });
  const invalidNumericTimestamp = createHarness({ itemRows: [traceRow({ started_at: Number.MAX_SAFE_INTEGER + 1 })] });

  for (const [label, harness] of [
    ['PostgreSQL failure', databaseFailure],
    ['ClickHouse failure', clickHouseFailure],
    ['invalid count', invalidCount],
    ['invalid timestamp', invalidTime],
    ['invalid duration', invalidNumber],
    ['invalid trace id', invalidTraceId],
    ['long root operation', longRootOperation],
    ['too many services', tooManyServices],
    ['long service name', longServiceName],
    ['unsafe numeric timestamp', invalidNumericTimestamp],
  ]) {
    await assert.rejects(harness.service.list(rawQuery()), (error) => {
      assert.equal(error.getStatus(), 503);
      assert.equal(error.message, 'Analytics data is unavailable');
      assert.doesNotMatch(JSON.stringify(error.getResponse()), /password|credential|SQL|secret|timestamp|Infinity/);
      return true;
    }, `Expected ${label} to be mapped to a safe 503`);
  }
});
