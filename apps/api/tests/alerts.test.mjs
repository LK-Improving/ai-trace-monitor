import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseAlertId,
  parseAlertState,
  parseAlertsListQuery,
  parseAlertsSummaryQuery,
} = require('../dist/alerts/alerts-query.js');
const { AlertsController } = require('../dist/alerts/alerts.controller.js');
const { AlertsService } = require('../dist/alerts/alerts.service.js');
const { AdminTokenGuard } = require('../dist/admin/admin-token.guard.js');
const { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { RequestMethod } = require('@nestjs/common');

const projectId = 'b35a64bb-8a12-4806-9e77-8831870a5dd0';
const alertId = '2f7b10f4-f8bb-4a80-9711-164cc2797c84';
const from = '2026-10-01T00:00:00.000Z';
const to = '2026-10-02T00:00:00.000Z';
const row = {
  id: alertId,
  title: 'Span 执行错误',
  message: 'Span 状态为 error；内置规则对每个失败 Span 触发一次。',
  rule: 'span_error',
  service: 'api',
  environment: 'dev',
  level: 'critical',
  state: 'active',
  trace_id: 'trace_v1_01234567-89ab-cdef-0123-456789abcdef',
  span_id: 'span-1',
  first_seen_at: new Date('2026-10-01T12:00:00Z'),
  last_seen_at: new Date('2026-10-01T12:00:00Z'),
  trigger_count: '2',
};

function assertBadRequest(callback) {
  assert.throws(callback, (error) => error.getStatus() === 400);
}

test('告警查询使用固定枚举、默认值和有界分页', () => {
  assert.deepEqual(parseAlertsListQuery({ projectId }), {
    projectId,
    environment: 'all',
    state: 'all',
    level: 'all',
    page: 1,
    pageSize: 20,
    offset: 0,
  });
  assert.deepEqual(parseAlertsListQuery({
    projectId: projectId.toUpperCase(),
    environment: 'staging',
    state: 'acknowledged',
    level: 'warning',
    page: '3',
    pageSize: '50',
  }), {
    projectId,
    environment: 'staging',
    state: 'acknowledged',
    level: 'warning',
    page: 3,
    pageSize: 50,
    offset: 100,
  });
  assert.deepEqual(parseAlertsSummaryQuery({ projectId, environment: 'prod' }), {
    projectId,
    environment: 'prod',
  });
  assert.deepEqual(parseAlertsListQuery({ projectId, from, to }).from, from);
  assert.deepEqual(parseAlertsSummaryQuery({ projectId, from, to }).to, to);
  assert.equal(parseAlertId(alertId.toUpperCase()), alertId);
  assert.equal(parseAlertState({ state: 'active' }), 'active');
});

test('告警查询拒绝未知参数、数组值、非法状态和越界分页', () => {
  for (const query of [
    null,
    { projectId: [projectId] },
    { projectId, environment: 'production' },
    { projectId, state: 'open' },
    { projectId, level: 'fatal' },
    { projectId, page: '0' },
    { projectId, page: '1.5' },
    { projectId, page: '1000001' },
    { projectId, pageSize: '101' },
    { projectId, page: '1000000', pageSize: '100' },
    { projectId, debug: 'true' },
    { projectId, from },
    { projectId, from: to, to: from },
    { projectId, from: '2026-09-01T00:00:00.000Z', to },
    { projectId, from: '2026-10-01T00:00:00+00:00', to },
  ]) assertBadRequest(() => parseAlertsListQuery(query));
  assertBadRequest(() => parseAlertsSummaryQuery({ projectId, page: '1' }));
  assertBadRequest(() => parseAlertsSummaryQuery({ projectId, to }));
  assertBadRequest(() => parseAlertId('not-a-uuid'));
  for (const body of [null, {}, { state: 'open' }, { state: 'resolved', extra: true }]) {
    assertBadRequest(() => parseAlertState(body));
  }
});

test('告警 controller 路由均由 AdminTokenGuard 保护且路径与契约一致', () => {
  assert(Reflect.getMetadata(GUARDS_METADATA, AlertsController).includes(AdminTokenGuard));
  assert.equal(Reflect.getMetadata(PATH_METADATA, AlertsController), 'alerts');
  for (const [method, path, verb] of [
    ['list', '/', RequestMethod.GET],
    ['summary', 'summary', RequestMethod.GET],
    ['updateState', ':id/state', RequestMethod.PATCH],
  ]) {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AlertsController.prototype[method]), path);
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AlertsController.prototype[method]), verb);
  }
});

test('列表过滤 project/environment/state/level 并返回严格分页契约', async () => {
  const calls = [];
  const database = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('FROM projects')) return { rows: [{ id: projectId }] };
      if (sql.includes('count(*) AS total')) return { rows: [{ total: '1' }] };
      return { rows: [row] };
    },
    async transaction() { throw new Error('Unexpected transaction'); },
  };
  const service = new AlertsService(database);
  const response = await service.list({
    projectId,
    environment: 'dev',
    state: 'active',
    level: 'critical',
    page: '2',
    pageSize: '10',
  });
  assert.deepEqual(response, {
    items: [{
      id: alertId,
      title: row.title,
      message: row.message,
      rule: 'span_error',
      service: 'api',
      environment: 'dev',
      level: 'critical',
      state: 'active',
      traceId: row.trace_id,
      spanId: 'span-1',
      firstSeenAt: '2026-10-01T12:00:00.000Z',
      lastSeenAt: '2026-10-01T12:00:00.000Z',
      triggerCount: 2,
    }],
    total: 1,
    page: 2,
    pageSize: 10,
  });
  assert.deepEqual(calls[1].values, [projectId, 'dev', 'active', 'critical', null, null]);
  assert.deepEqual(calls[2].values, [projectId, 'dev', 'active', 'critical', null, null, 10, 10]);
  assert.match(calls[2].sql, /last_seen_at >= \$5::timestamptz/);
});

test('summary 同项目和环境聚合所有状态及 critical active', async () => {
  const calls = [];
  const database = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('FROM projects')) return { rows: [{ id: projectId }] };
      return { rows: [{ total: '7', active: '2', acknowledged: '3', resolved: '2', critical_active: '1' }] };
    },
  };
  const response = await new AlertsService(database).summary({ projectId, environment: 'staging' });
  assert.deepEqual(response, { total: 7, active: 2, acknowledged: 3, resolved: 2, criticalActive: 1 });
  assert.deepEqual(calls[1].values, [projectId, 'staging', null, null]);
});

test('告警列表与统计按最近发生时间使用同一半开窗口', async () => {
  const calls = [];
  const database = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('FROM projects')) return { rows: [{ id: projectId }] };
      if (sql.includes('critical_active')) return { rows: [{ total: '0', active: '0', acknowledged: '0', resolved: '0', critical_active: '0' }] };
      if (sql.includes('count(*) AS total')) return { rows: [{ total: '0' }] };
      return { rows: [] };
    },
  };
  const service = new AlertsService(database);
  await service.list({ projectId, from, to });
  await service.summary({ projectId, from, to });
  const filtered = calls.filter(({ sql }) => sql.includes('FROM alert_incidents'));
  assert.equal(filtered.length, 3);
  for (const { sql, values } of filtered) {
    assert.match(sql, /last_seen_at >= \$\d+::timestamptz/);
    assert.match(sql, /last_seen_at < \$\d+::timestamptz/);
    assert.deepEqual(values.filter((value) => value === from || value === to), [from, to]);
  }
});

test('状态 API 通过 scope 锁序列化状态更新并支持重新打开', async () => {
  const statements = [];
  let currentState = 'active';
  const database = {
    async transaction(operation) {
      return operation({
        async query(sql, values) {
          statements.push({ sql, values });
          if (sql.includes('SELECT project_id, environment, service, rule')) {
            return { rows: [{ project_id: projectId, environment: 'dev', service: 'api', rule: 'span_error' }] };
          }
          if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
          if (sql.includes('FROM alert_incidents WHERE id = $1 FOR UPDATE')) {
            return { rows: [{ ...row, state: currentState }] };
          }
          if (sql.includes("state IN ('active', 'acknowledged')")) return { rows: [] };
          if (sql.startsWith('UPDATE alert_incidents')) {
            currentState = values[1];
            return { rows: [{ ...row, state: currentState }] };
          }
          throw new Error('Unexpected SQL');
        },
      });
    },
  };
  const service = new AlertsService(database);
  assert.equal((await service.updateState(alertId, { state: 'acknowledged' })).state, 'acknowledged');
  assert.equal((await service.updateState(alertId, { state: 'resolved' })).state, 'resolved');
  assert.equal((await service.updateState(alertId, { state: 'active' })).state, 'active');
  assert.equal((await service.updateState(alertId, { state: 'active' })).state, 'active', 'Same-state writes are idempotent');
  assert.equal(statements.filter(({ sql }) => sql.includes('pg_advisory_xact_lock')).length, 4);
  assert(statements.some(({ sql }) => sql.includes('id <> $5')));
});

test('重新打开不能创建同 scope 的第二个 active/acknowledged alert', async () => {
  const database = {
    async transaction(operation) {
      return operation({
        async query(sql) {
          if (sql.includes('SELECT project_id, environment, service, rule')) {
            return { rows: [{ project_id: projectId, environment: 'dev', service: 'api', rule: 'span_error' }] };
          }
          if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
          if (sql.includes('FROM alert_incidents WHERE id = $1 FOR UPDATE')) {
            return { rows: [{ ...row, state: 'resolved' }] };
          }
          if (sql.includes("state IN ('active', 'acknowledged')")) return { rows: [{ id: 'another-alert' }] };
          throw new Error('Unexpected SQL');
        },
      });
    },
  };
  await assert.rejects(
    new AlertsService(database).updateState(alertId, { state: 'active' }),
    (error) => error.getStatus() === 409,
  );
});

test('resolved alert 不能直接转为 acknowledged', async () => {
  const database = {
    async transaction(operation) {
      return operation({
        async query(sql) {
          if (sql.includes('SELECT project_id, environment, service, rule')) {
            return { rows: [{ project_id: projectId, environment: 'dev', service: 'api', rule: 'span_error' }] };
          }
          if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
          if (sql.includes('FROM alert_incidents WHERE id = $1 FOR UPDATE')) {
            return { rows: [{ ...row, state: 'resolved' }] };
          }
          throw new Error('Unexpected SQL');
        },
      });
    },
  };
  await assert.rejects(
    new AlertsService(database).updateState(alertId, { state: 'acknowledged' }),
    (error) => error.getStatus() === 400,
  );
});
