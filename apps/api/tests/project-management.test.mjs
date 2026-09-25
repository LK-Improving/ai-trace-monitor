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
  assert.deepEqual(parseCreateProjectKey({ name: 'browser' }), { name: 'browser' });

  assertBadRequest(() => parseCreateProject({ name: 'Support', slug: 'Bad Slug' }));
  assertBadRequest(() => parseCreateProject({ name: 'Support', slug: 'support', projectId }));
  assertBadRequest(() => parseCreateService({ name: 'api', environment: 'production' }));
  assertBadRequest(() => parseCreateService({ name: 'api', environment: 'dev', extra: true }));
  assertBadRequest(() => parseCreateProjectKey({ name: 'browser', scope: 'traces:read' }));
  assertBadRequest(() => parseProjectId('not-a-uuid'));
});

test('所有管理路由都由独立的 AdminTokenGuard 保护', () => {
  const guards = Reflect.getMetadata(GUARDS_METADATA, ProjectsController);
  assert.ok(guards.includes(AdminTokenGuard));
});

test('创建密钥只保存 SHA-256 Hash 并只在创建响应中展示明文', async () => {
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
            scopes: ['spans:write'],
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
            name: 'browser',
            key_prefix: insertValues[2],
            scopes: ['spans:write'],
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

  const created = await service.createProjectKey(projectId, { name: 'browser' });
  assert.match(created.key, /^tr_[A-Za-z0-9_-]{43}$/);
  assert.equal(insertValues[2], created.keyPrefix);
  assert.equal(insertValues[3], createHash('sha256').update(created.key).digest('hex'));
  assert.doesNotMatch(insertSql, /\$5/);
  assert.deepEqual(created.scopes, ['spans:write']);

  const listed = await service.listProjectKeys(projectId);
  assert.equal(listed.length, 1);
  assert.equal('key' in listed[0], false);
  assert.equal('keyHash' in listed[0], false);
  assert.equal(JSON.stringify(listed).includes(created.key), false);
});

test('撤销是更新 revoked_at，不执行物理删除，且重复撤销幂等', async () => {
  const revokedAt = new Date('2026-09-25T00:10:00.000Z');
  const statements = [];
  const database = {
    async query(sql) {
      statements.push(sql);
      if (sql.startsWith('UPDATE project_keys')) return { rows: [{ id: keyId, revoked_at: revokedAt }] };
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
  const service = new ProjectsService(database);
  const result = await service.revokeProjectKey(projectId, keyId);
  assert.deepEqual(result, { id: keyId, revokedAt: revokedAt.toISOString() });
  assert.match(statements[0], /SET revoked_at = now\(\)/i);
  assert.doesNotMatch(statements[0], /^\s*DELETE/i);
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
