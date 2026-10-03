import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProjectsController } = require('../dist/projects/projects.controller.js');
const { ProjectsService } = require('../dist/projects/projects.service.js');
const {
  parseCreateProject,
  parseCreateProjectKey,
  parseCreateService,
  parseAuditLogsQuery,
  parseProjectPrivacyPolicyPatch,
  parseProjectId,
} = require('../dist/projects/project.validation.js');
const { GUARDS_METADATA } = require('@nestjs/common/constants');
const { AdminTokenGuard } = require('../dist/admin/admin-token.guard.js');

const projectId = 'b35a64bb-8a12-4806-9e77-8831870a5dd0';
const keyId = '2195c20c-a0b8-47bb-bfd3-1b181fd9d66f';

function assertBadRequest(callback) {
  assert.throws(callback, (error) => error.getStatus() === 400);
}

test('项目/服务/密钥输入严格校验，环境只允许规范值', () => {
  assert.deepEqual(parseCreateProject({ name: ' Support ', slug: 'support-app' }), {
    name: 'Support', slug: 'support-app', retentionDays: 30,
  });
  assert.equal(parseCreateService({ name: 'api', environment: 'prod' }).environment, 'prod');
  assert.deepEqual(parseCreateProjectKey({ name: 'browser' }), { name: 'browser', scopes: ['spans:write'] });
  assert.deepEqual(parseCreateProjectKey({ name: 'query', scopes: ['trace:read'] }), {
    name: 'query', scopes: ['trace:read'],
  });

  assertBadRequest(() => parseCreateProject({ name: 'Support', slug: 'Bad Slug' }));
  assertBadRequest(() => parseCreateProject({ name: 'Support', slug: 'support', projectId }));
  assertBadRequest(() => parseCreateService({ name: 'api', environment: 'production' }));
  assertBadRequest(() => parseCreateService({ name: 'api', environment: 'dev', extra: true }));
  assertBadRequest(() => parseCreateProjectKey({ name: 'browser', scope: 'trace:read' }));
  assertBadRequest(() => parseCreateProjectKey({ name: 'browser', scopes: ['traces:read'] }));
  assertBadRequest(() => parseCreateProjectKey({ name: 'browser', scopes: ['trace:read', 'trace:read'] }));
  assertBadRequest(() => parseCreateProjectKey({ name: 'browser', scopes: ['spans:write', 'trace:read'] }));
  assertBadRequest(() => parseProjectPrivacyPolicyPatch({ additionalRedactedFields: ['bad.field'] }));
  assertBadRequest(() => parseProjectPrivacyPolicyPatch({ additionalRedactedFields: Array(65).fill('field') }));
  assert.deepEqual(parseProjectPrivacyPolicyPatch({ additionalRedactedFields: ['UserEmail'] }), {
    additionalRedactedFields: ['useremail'],
  });
  assert.throws(() => parseProjectPrivacyPolicyPatch({ capturePromptResponse: true }), (error) => error.getStatus() === 403);
  assert.deepEqual(parseAuditLogsQuery({}), { page: 1, pageSize: 50 });
  assert.throws(() => parseAuditLogsQuery({ page: '1000', pageSize: '100' }), (error) => error.getStatus() === 400);
  assert.deepEqual(parseAuditLogsQuery({ page: '1', pageSize: '20' }), { page: 1, pageSize: 20 });
  for (const invalidQuery of [
    { limit: '20' },
    { page: 0 },
    { page: '0' },
    { page: '01' },
    { page: 1 },
    { page: ['1'] },
    { pageSize: ['20'] },
    { pageSize: '101' },
    { projectId },
    { page: '1000', pageSize: '11' },
  ]) {
    assertBadRequest(() => parseAuditLogsQuery(invalidQuery));
  }
  assertBadRequest(() => parseProjectId('not-a-uuid'));
});

test('所有管理路由都由独立的 AdminTokenGuard 保护', () => {
  const guards = Reflect.getMetadata(GUARDS_METADATA, ProjectsController);
  assert.ok(guards.includes(AdminTokenGuard));
});

test('创建密钥只保存 SHA-256 Hash、审计不带明文且只在创建响应展示一次', async () => {
  let insertSql = '';
  let insertValues;
  const database = {
    async query(sql, values = []) {
      if (sql.includes('SELECT id FROM projects')) return { rows: [{ id: projectId }] };
      if (sql.includes('INSERT INTO project_keys')) {
        insertSql = sql;
        insertValues = values;
        return {
          rows: [{
            id: keyId,
            project_id: projectId,
            name: values[1],
            key_prefix: values[2],
            scopes: values[4],
            last_used_at: null,
            revoked_at: null,
            created_at: new Date('2026-09-25T00:00:00.000Z'),
          }],
        };
      }
      if (sql.includes('FROM project_keys')) {
        assert.doesNotMatch(sql, /key_hash/i);
        return {
          rows: [{
            id: keyId,
            project_id: projectId,
            name: 'query',
            key_prefix: insertValues[2],
            scopes: insertValues[4],
            last_used_at: null,
            revoked_at: null,
            created_at: new Date('2026-09-25T00:00:00.000Z'),
          }],
        };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
  const service = new ProjectsService(database);

  const created = await service.createProjectKey(projectId, { name: 'query', scopes: ['trace:read'] });
  assert.match(created.key, /^tr_[A-Za-z0-9_-]{43}$/);
  assert.equal(insertValues[2], created.keyPrefix);
  assert.equal(insertValues[3], createHash('sha256').update(created.key).digest('hex'));
  assert.deepEqual(insertValues[4], ['trace:read']);
  assert.deepEqual(created.scopes, ['trace:read']);
  assert.match(insertSql, /INSERT INTO audit_logs/);
  assert.match(insertSql, /'platform_admin'/);
  assert.equal(insertValues.includes(created.key), false, 'raw key never enters SQL/audit parameters');

  const listed = await service.listProjectKeys(projectId);
  assert.equal(listed.length, 1);
  assert.equal('key' in listed[0], false);
  assert.equal('keyHash' in listed[0], false);
  assert.equal(JSON.stringify(listed).includes(created.key), false);
  assert.deepEqual(listed[0].scopes, ['trace:read']);
  assert.equal(listed[0].keyPrefix, created.keyPrefix);
});

test('轮换在同一 SQL 语句撤销旧密钥、继承 scopes 并只展示新明文一次', async () => {
  let sqlText = '';
  let sqlValues;
  const database = {
    async query(sql, values = []) {
      sqlText = sql;
      sqlValues = values;
      return { rows: [{
        id: '3195c20c-a0b8-47bb-bfd3-1b181fd9d66f',
        old_key_id: keyId,
        project_id: projectId,
        name: 'server-reader',
        key_prefix: values[2],
        scopes: ['trace:read'],
        last_used_at: null,
        revoked_at: null,
        created_at: new Date('2026-10-03T00:00:00.000Z'),
      }] };
    },
  };
  const service = new ProjectsService(database);
  const rotated = await service.rotateProjectKey(projectId, keyId);

  assert.match(rotated.key, /^tr_[A-Za-z0-9_-]{43}$/);
  assert.equal(rotated.rotatedFromKeyId, keyId);
  assert.deepEqual(rotated.scopes, ['trace:read']);
  assert.match(sqlText, /FOR UPDATE/);
  assert.match(sqlText, /SET revoked_at = now\(\)/);
  assert.match(sqlText, /INSERT INTO project_keys/);
  assert.match(sqlText, /INSERT INTO audit_logs/);
  assert.equal(sqlValues.includes(rotated.key), false);
  assert.equal(sqlValues[3], createHash('sha256').update(rotated.key).digest('hex'));
});

test('撤销是更新 revoked_at，不执行物理删除，且重复撤销幂等', async () => {
  const revokedAt = new Date('2026-09-25T00:10:00.000Z');
  const statements = [];
  const database = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes('WITH target AS MATERIALIZED')) return { rows: [{ id: keyId, revoked_at: revokedAt }] };
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
  const service = new ProjectsService(database);
  const result = await service.revokeProjectKey(projectId, keyId);
  const repeated = await service.revokeProjectKey(projectId, keyId);
  assert.deepEqual(result, { id: keyId, revokedAt: revokedAt.toISOString() });
  assert.deepEqual(repeated, result);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /SET revoked_at = now\(\)/i);
  assert.match(statements[0], /INSERT INTO audit_logs/);
  assert.match(statements[0], /UNION ALL[\s\S]*NOT EXISTS/);
  assert.doesNotMatch(statements[0], /^\s*DELETE/i);
});

test('service onboarding 仍按项目创建服务并在同一语句记录安全审计元数据', async () => {
  let insertSql = '';
  let insertValues;
  const database = {
    async query(sql, values = []) {
      if (sql.includes('SELECT id FROM projects')) return { rows: [{ id: projectId }] };
      insertSql = sql;
      insertValues = values;
      return { rows: [{
        id: keyId,
        project_id: projectId,
        name: 'api',
        environment: 'prod',
        sdk_version: '1.2.3',
        created_at: new Date('2026-10-03T00:00:00.000Z'),
      }] };
    },
  };
  const created = await new ProjectsService(database).createService(projectId, {
    name: 'api', environment: 'prod', sdkVersion: '1.2.3',
  });
  assert.deepEqual(created, {
    id: keyId, projectId, name: 'api', environment: 'prod', sdkVersion: '1.2.3',
    createdAt: '2026-10-03T00:00:00.000Z',
  });
  assert.match(insertSql, /INSERT INTO services/);
  assert.match(insertSql, /INSERT INTO audit_logs/);
  assert.deepEqual(insertValues, [projectId, 'api', 'prod', '1.2.3']);
});

test('privacy policy stores bounded redaction names, never enables content capture, and audits only counts', async () => {
  const statements = [];
  const policyRow = {
    project_id: projectId,
    additional_redacted_fields: ['customer_email'],
    capture_prompt_response: false,
    updated_at: new Date('2026-10-03T00:00:00.000Z'),
  };
  const database = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql.includes('SELECT id FROM projects')) return { rows: [{ id: projectId }] };
      if (sql.includes('WITH updated AS')) {
        assert.match(sql, /INSERT INTO audit_logs/);
        assert.match(sql, /cardinality\(additional_redacted_fields\)/);
        return { rows: [{ ...policyRow, additional_redacted_fields: values[1] }] };
      }
      if (sql.includes('FROM project_privacy_policies')) return { rows: [policyRow] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const service = new ProjectsService(database);
  const current = await service.getPrivacyPolicy(projectId);
  assert.deepEqual(current, {
    projectId, additionalRedactedFields: ['customer_email'], capturePromptResponse: false,
    updatedAt: '2026-10-03T00:00:00.000Z',
  });
  const updated = await service.updatePrivacyPolicy(projectId, {
    additionalRedactedFields: ['CustomerEmail', 'tenant_id'], capturePromptResponse: false,
  });
  assert.deepEqual(updated.additionalRedactedFields, ['customeremail', 'tenant_id']);
  const updateCall = statements.find(({ sql }) => sql.includes('WITH updated AS'));
  assert.deepEqual(updateCall.values, [projectId, ['customeremail', 'tenant_id']]);
  assert.doesNotMatch(updateCall.sql, /jsonb_build_object\([^)]*additional_redacted_fields,/i);
  await assert.rejects(
    service.updatePrivacyPolicy(projectId, { capturePromptResponse: true }),
    (error) => error.getStatus() === 403,
  );
});

test('audit list is bounded and never returns stored details or untrusted metadata verbatim', async () => {
  const statements = [];
  const database = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql.includes('SELECT id FROM projects')) return { rows: [{ id: projectId }] };
      return { rows: [{
        total: '1', id: '42', actor_id: 'attacker-secret', action: 'secret prompt raw content',
        resource: `service:${'0'.repeat(36)}`, details: { prompt: 'must-not-return' },
        created_at: new Date('2026-10-03T00:00:00.000Z'),
      }] };
    },
  };
  const result = await new ProjectsService(database).listAuditLogs(projectId, { page: '1', pageSize: '20' });
  assert.deepEqual(result, {
    items: [{ id: '42', actorId: 'system', action: 'other', resource: 'unknown', createdAt: '2026-10-03T00:00:00.000Z' }],
    total: 1, page: 1, pageSize: 20,
  });
  assert.deepEqual(Object.keys(result.items[0]), ['id', 'actorId', 'action', 'resource', 'createdAt']);
  assert.equal(typeof result.items[0].id, 'string');
  assert.equal('projectId' in result.items[0], false);
  const listCall = statements.find(({ sql }) => sql.includes('LEFT JOIN page ON TRUE'));
  assert.match(listCall.sql, /LIMIT \$2 OFFSET \$3/);
  assert.match(listCall.sql, /SELECT COUNT\(\*\) FROM audit_logs WHERE project_id = \$1/);
  assert.doesNotMatch(listCall.sql, /details/i);
  assert.deepEqual(listCall.values, [projectId, 20, 0]);
  assert.doesNotMatch(JSON.stringify(result), /attacker-secret|private@example|must-not-return|prompt/i);
});

test('empty audit pages retain the exact count from the same query snapshot', async () => {
  let auditQueryCount = 0;
  const database = {
    async query(sql) {
      if (sql.includes('SELECT id FROM projects')) return { rows: [{ id: projectId }] };
      auditQueryCount += 1;
      return { rows: [{
        total: '0', id: null, actor_id: null, action: null, resource: null, created_at: null,
      }] };
    },
  };
  const result = await new ProjectsService(database).listAuditLogs(projectId, { page: '1', pageSize: '20' });
  assert.deepEqual(result, { items: [], total: 0, page: 1, pageSize: 20 });
  assert.equal(auditQueryCount, 1);
});

test('数据库唯一冲突映射为 409，并使用参数化 SQL', async () => {
  let sqlText = '';
  let sqlValues;
  const database = {
    async query(sql, values) {
      sqlText = sql;
      sqlValues = values;
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    },
  };
  const service = new ProjectsService(database);
  await assert.rejects(service.createProject({ name: 'Support', slug: 'support' }), (error) => error.getStatus() === 409);
  assert.match(sqlText, /VALUES \(\$1, \$2, \$3\)/);
  assert.deepEqual(sqlValues, ['Support', 'support', 30]);
});
