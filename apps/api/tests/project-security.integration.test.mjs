import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const require = createRequire(import.meta.url);
const enabled = process.env.TRACE_OPS_RUN_PROJECT_SECURITY_INTEGRATION === '1';

test('W26-W29 Postgres migration is repeatable and enforces key, privacy, and append-only constraints', {
  skip: enabled ? false : 'Set TRACE_OPS_RUN_PROJECT_SECURITY_INTEGRATION=1 to use the configured loopback PostgreSQL database',
}, async () => {
  const { Pool } = require('pg');
  const { AlertsDatabase } = require('../dist/alerts/alerts.database.js');
  const { ProjectsService } = require('../dist/projects/projects.service.js');
  const { TraceReadGuard } = require('../dist/traces/trace-read.guard.js');
  const rawDatabaseUrl = process.env.DATABASE_URL;
  assert.ok(rawDatabaseUrl, 'DATABASE_URL must be set explicitly');
  const databaseUrl = new URL(rawDatabaseUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname), 'integration test only permits loopback PostgreSQL');

  const config = { get: (name) => name === 'DATABASE_URL' ? rawDatabaseUrl : undefined };
  const database = new AlertsDatabase(config);
  const pool = new Pool({ connectionString: rawDatabaseUrl, max: 1 });
  const client = await pool.connect();
  const savepointRejects = async (sql, values = []) => {
    await client.query('SAVEPOINT expected_rejection');
    await assert.rejects(client.query(sql, values));
    await client.query('ROLLBACK TO SAVEPOINT expected_rejection');
    await client.query('RELEASE SAVEPOINT expected_rejection');
  };

  try {
    await database.onModuleInit();
    await database.onModuleInit();
    await client.query('BEGIN');
    const project = await client.query(
      `INSERT INTO projects (name, slug) VALUES ($1, $2) RETURNING id`,
      ['Security migration rollback test', `security-migration-${randomUUID()}`],
    );
    const projectId = project.rows[0].id;
    const scopedDatabase = { query: (sql, values = []) => client.query(sql, values) };
    const projects = new ProjectsService(scopedDatabase);
    const policy = await client.query(
      'SELECT additional_redacted_fields, capture_prompt_response FROM project_privacy_policies WHERE project_id = $1',
      [projectId],
    );
    assert.deepEqual(policy.rows[0].additional_redacted_fields, []);
    assert.equal(policy.rows[0].capture_prompt_response, false);

    await client.query(
      `INSERT INTO project_keys (project_id, name, key_prefix, key_hash, scopes)
       VALUES ($1, 'read-only test key', 'tr_testprefix', $2, ARRAY['trace:read']::text[])`,
      [projectId, randomUUID().replaceAll('-', '').padEnd(64, 'a')],
    );
    await savepointRejects(
      `INSERT INTO project_keys (project_id, name, key_prefix, key_hash, scopes)
       VALUES ($1, 'invalid test key', 'tr_invalidxx', $2, ARRAY['traces:read']::text[])`,
      [projectId, randomUUID().replaceAll('-', '').padEnd(64, 'b')],
    );
    await savepointRejects(
      `INSERT INTO project_keys (project_id, name, key_prefix, key_hash, scopes)
       VALUES ($1, 'combined test key', 'tr_combinedxx', $2, ARRAY['spans:write', 'trace:read']::text[])`,
      [projectId, randomUUID().replaceAll('-', '').padEnd(64, 'c')],
    );
    await savepointRejects(
      'UPDATE project_privacy_policies SET capture_prompt_response = true WHERE project_id = $1',
      [projectId],
    );
    await savepointRejects(
      'UPDATE project_privacy_policies SET additional_redacted_fields = $2::text[] WHERE project_id = $1',
      [projectId, Array.from({ length: 65 }, (_, index) => `field${index}`)],
    );

    const onboarded = await projects.createService(projectId, {
      name: 'api', environment: 'dev', sdkVersion: 'test',
    });
    assert.equal(onboarded.projectId, projectId);
    const reader = await projects.createProjectKey(projectId, {
      name: 'read-only', scopes: ['trace:read'],
    });
    assert.equal(reader.scopes.includes('trace:read'), true);
    assert.match(reader.key, /^tr_[A-Za-z0-9_-]{43}$/);
    const keyList = await projects.listProjectKeys(projectId);
    const listedReader = keyList.find(({ id }) => id === reader.id);
    assert.equal(listedReader.keyPrefix, reader.keyPrefix);
    assert.equal('key' in listedReader, false);
    assert.equal('keyHash' in listedReader, false);

    const anotherProject = await client.query(
      `INSERT INTO projects (name, slug) VALUES ($1, $2) RETURNING id`,
      ['Security other project', `security-other-${randomUUID()}`],
    );
    const otherProjectId = anotherProject.rows[0].id;
    const guard = new TraceReadGuard({ get: () => undefined }, scopedDatabase);
    const requestContext = (key, requestedProjectId) => ({
      switchToHttp: () => ({ getRequest: () => ({
        headers: { authorization: `Bearer ${key}` }, query: { projectId: requestedProjectId },
      }) }),
    });
    assert.equal(await guard.canActivate(requestContext(reader.key, projectId)), true);
    await assert.rejects(
      guard.canActivate(requestContext(reader.key, otherProjectId)),
      (error) => error.getStatus() === 403,
    );

    const rotated = await projects.rotateProjectKey(projectId, reader.id);
    assert.deepEqual(rotated.scopes, ['trace:read']);
    assert.equal(rotated.rotatedFromKeyId, reader.id);
    await assert.rejects(guard.canActivate(requestContext(reader.key, projectId)), (error) => error.getStatus() === 401);
    assert.equal(await guard.canActivate(requestContext(rotated.key, projectId)), true);
    const revoked = await projects.revokeProjectKey(projectId, rotated.id);
    const repeatedRevoke = await projects.revokeProjectKey(projectId, rotated.id);
    assert.deepEqual(repeatedRevoke, revoked);
    await assert.rejects(guard.canActivate(requestContext(rotated.key, projectId)), (error) => error.getStatus() === 401);

    const changedPolicy = await projects.updatePrivacyPolicy(projectId, {
      additionalRedactedFields: ['CustomerEmail', 'tenant_id'],
    });
    assert.deepEqual(changedPolicy.additionalRedactedFields, ['customeremail', 'tenant_id']);
    const auditLogs = await projects.listAuditLogs(projectId, { page: '1', pageSize: '50' });
    assert.ok(auditLogs.total >= 5);
    assert.ok(auditLogs.items.some(({ action }) => action === 'project_key.rotated'));
    assert.ok(auditLogs.items.some(({ action }) => action === 'project_privacy_policy.updated'));
    assert.ok(auditLogs.items.every((item) => !('details' in item)));

    const audit = await client.query(
      `INSERT INTO audit_logs (project_id, actor_id, action, resource, details)
       VALUES ($1, 'platform_admin', 'service.created', 'service:00000000-0000-4000-8000-000000000000', $2::jsonb)
       RETURNING id, project_id, actor_id, action, resource, details, created_at`,
      [projectId, JSON.stringify({ projectSlug: `security-migration-${projectId}` })],
    );
    await savepointRejects('UPDATE audit_logs SET details = \'{}\'::jsonb WHERE id = $1', [audit.rows[0].id]);
    await savepointRejects('DELETE FROM audit_logs WHERE id = $1', [audit.rows[0].id]);

    const auditFk = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'audit_logs'::regclass AND confrelid = 'projects'::regclass AND contype = 'f'
         AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                             WHERE attrelid = 'audit_logs'::regclass AND attname = 'project_id')]::smallint[]`,
    );
    assert.equal(auditFk.rows.length, 1);
    assert.match(auditFk.rows[0].definition, /ON DELETE SET NULL/i);

    await client.query('DELETE FROM projects WHERE id = $1', [projectId]);
    const retainedAudit = await client.query(
      `SELECT id, project_id, actor_id, action, resource, details, created_at
       FROM audit_logs WHERE id = $1`,
      [audit.rows[0].id],
    );
    assert.equal(retainedAudit.rows.length, 1);
    assert.equal(retainedAudit.rows[0].project_id, null);
    assert.equal(retainedAudit.rows[0].actor_id, audit.rows[0].actor_id);
    assert.equal(retainedAudit.rows[0].action, audit.rows[0].action);
    assert.equal(retainedAudit.rows[0].resource, audit.rows[0].resource);
    assert.deepEqual(retainedAudit.rows[0].details, audit.rows[0].details);
    assert.deepEqual(retainedAudit.rows[0].created_at, audit.rows[0].created_at);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
    await database.onModuleDestroy();
  }
});
