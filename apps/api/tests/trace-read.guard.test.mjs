import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TraceReadGuard } = require('../dist/traces/trace-read.guard.js');
const projectId = 'b35a64bb-8a12-4806-9e77-8831870a5dd0';
const otherProjectId = 'e48b6b53-d508-45d7-ad43-f2d34d17e689';

function makeKey() {
  return `tr_${randomBytes(32).toString('base64url')}`;
}

function executionContext(authorization, query = { projectId }) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization }, query }),
    }),
  };
}

function createHarness({
  key = makeKey(),
  candidate = {},
  adminToken = 'platform-admin-secret',
  touchRowCount = 1,
  databaseError,
} = {}) {
  const calls = [];
  const defaultCandidate = {
    id: '2195c20c-a0b8-47bb-bfd3-1b181fd9d66f',
    project_id: projectId,
    key_hash: createHash('sha256').update(key).digest('hex'),
    scopes: ['trace:read'],
    revoked_at: null,
    project_status: 'active',
  };
  const database = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (databaseError) throw databaseError;
      if (sql.includes('FROM project_keys AS key')) return { rows: [{ ...defaultCandidate, ...candidate }] };
      if (sql.startsWith('UPDATE project_keys')) return { rows: touchRowCount ? [{ id: defaultCandidate.id }] : [], rowCount: touchRowCount };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const config = { get: (name) => name === 'PLATFORM_ADMIN_TOKEN' ? adminToken : undefined };
  return { key, calls, guard: new TraceReadGuard(config, database) };
}

function hasStatus(status) {
  return (error) => error?.getStatus?.() === status;
}

test('平台管理员凭证仍可读 Trace，不需要项目 key 查询', async () => {
  const harness = createHarness({ databaseError: new Error('must not query') });
  assert.equal(await harness.guard.canActivate(executionContext('Bearer platform-admin-secret')), true);
  assert.equal(harness.calls.length, 0);
});

test('trace:read 项目 key 只能读取显式指定的同项目并触达 last_used_at', async () => {
  const harness = createHarness();
  assert.equal(await harness.guard.canActivate(executionContext(`Bearer ${harness.key}`)), true);
  assert.equal(harness.calls.length, 2);
  assert.deepEqual(harness.calls[0].values, [harness.key.slice(0, 11)]);
  assert.deepEqual(harness.calls[1].values, [
    '2195c20c-a0b8-47bb-bfd3-1b181fd9d66f', projectId,
  ]);
  assert.match(harness.calls[1].sql, /trace:read/);
});

test('无效/撤销 key 返回 401，缺少 trace:read 返回 403', async (t) => {
  await t.test('无效 key', async () => {
    const harness = createHarness({ candidate: { key_hash: 'f'.repeat(64) } });
    await assert.rejects(harness.guard.canActivate(executionContext(`Bearer ${harness.key}`)), hasStatus(401));
    assert.equal(harness.calls.length, 1);
  });
  await t.test('已撤销 key', async () => {
    const harness = createHarness({ candidate: { revoked_at: new Date() } });
    await assert.rejects(harness.guard.canActivate(executionContext(`Bearer ${harness.key}`)), hasStatus(401));
    assert.equal(harness.calls.length, 1);
  });
  await t.test('仅有 spans:write', async () => {
    const harness = createHarness({ candidate: { scopes: ['spans:write'] } });
    await assert.rejects(harness.guard.canActivate(executionContext(`Bearer ${harness.key}`)), hasStatus(403));
    assert.equal(harness.calls.length, 1);
  });
});

test('项目 key 必须明确指定自身 projectId，不能跨项目读取', async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.guard.canActivate(executionContext(`Bearer ${harness.key}`, { projectId: otherProjectId })),
    hasStatus(403),
  );
  assert.equal(harness.calls.length, 1, 'mismatched project is rejected before last-used update or Trace query');
});

test('项目 key 缺少 projectId 为 400，撤销竞争与数据库不可用均失败关闭', async (t) => {
  await t.test('缺少 projectId', async () => {
    const harness = createHarness();
    await assert.rejects(harness.guard.canActivate(executionContext(`Bearer ${harness.key}`, {})), hasStatus(400));
    assert.equal(harness.calls.length, 0);
  });
  await t.test('key 在验证后被撤销', async () => {
    const harness = createHarness({ touchRowCount: 0 });
    await assert.rejects(harness.guard.canActivate(executionContext(`Bearer ${harness.key}`)), hasStatus(401));
  });
  await t.test('存储故障不泄露数据库错误或凭证', async () => {
    const sentinel = 'database-password-secret';
    const harness = createHarness({ databaseError: new Error(sentinel) });
    await assert.rejects(harness.guard.canActivate(executionContext(`Bearer ${harness.key}`)), (error) => {
      assert.equal(error.getStatus(), 503);
      assert.doesNotMatch(JSON.stringify(error.getResponse()), new RegExp(`${sentinel}|${harness.key}`));
      return true;
    });
  });
});
