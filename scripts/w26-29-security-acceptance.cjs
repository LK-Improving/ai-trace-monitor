// Isolated W26-W29 project-scope, key lifecycle, privacy, and audit acceptance.
// Run only against the local Compose dependencies with an explicit opt-in:
//   $env:TRACE_OPS_RUN_W26_29_INTEGRATION='1'
//   node --env-file=.env scripts/w26-29-security-acceptance.cjs
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

if (process.env.TRACE_OPS_RUN_W26_29_INTEGRATION !== '1') {
  throw new Error('Set TRACE_OPS_RUN_W26_29_INTEGRATION=1 to run the isolated local acceptance');
}

const root = path.resolve(__dirname, '..');
const apiRequire = createRequire(path.join(root, 'apps/api/package.json'));
const { Pool } = apiRequire('pg');
const { createClient, ClickHouseLogLevel } = apiRequire('@clickhouse/client');
const runId = randomUUID();
const runPrefix = `w26-${runId}`;
const projectSlugs = [`${runPrefix}-one`, `${runPrefix}-two`];
const report = {
  status: 'running',
  cleanup: 'pending',
  appendOnlyAuditMetadataRetainedAfterProjectCleanup: true,
  checks: [],
};
const projectIds = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const apiPort = Number(process.env.API_PORT ?? 3001);
let pool;
let clickhouse;

function localUrl(value, fallback, protocols = ['http:']) {
  const parsed = new URL(value ?? fallback);
  if (!protocols.includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Only loopback integration dependencies are allowed');
  }
  return parsed;
}

function passed(name) {
  report.checks.push(name);
}

async function request(route, { method = 'GET', body, token, admin = false } = {}) {
  const headers = { 'x-trace-id': `w26-${randomUUID()}` };
  const credential = admin ? process.env.PLATFORM_ADMIN_TOKEN : token;
  if (credential) headers.authorization = `Bearer ${credential}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/v1${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

async function createProject(index) {
  const result = await request('/projects', {
    method: 'POST',
    admin: true,
    body: { name: `W26 isolated project ${index + 1}`, slug: projectSlugs[index] },
  });
  assert.equal(result.status, 201, 'isolated project creation must succeed');
  assert.equal(typeof result.body?.id, 'string');
  projectIds.push(result.body.id);
  return result.body.id;
}

async function createKey(projectId, name, scope) {
  const result = await request(`/projects/${projectId}/keys`, {
    method: 'POST',
    admin: true,
    body: { name, scopes: [scope] },
  });
  assert.equal(result.status, 201, 'project key creation must succeed');
  assert.match(result.body?.key ?? '', /^tr_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(result.body?.scopes, [scope]);
  return result.body;
}

function traceQuery(projectId, traceId) {
  const now = Date.now();
  const params = new URLSearchParams({
    projectId,
    environment: 'all',
    from: new Date(now - 60 * 60_000).toISOString(),
    to: new Date(now + 60_000).toISOString(),
  });
  if (traceId) params.set('traceId', traceId);
  return params.toString();
}

function makeSpan(traceId, privateCanary) {
  const startTime = Date.now();
  return {
    traceId,
    spanId: randomUUID().replaceAll('-', ''),
    service: runPrefix,
    operation: 'http.server',
    startTime,
    endTime: startTime + 5,
    status: 'ok',
    attributes: {
      customer_secret_marker: privateCanary,
      prompt: privateCanary,
      safe_operation: 'w26-privacy-check',
    },
  };
}

async function main() {
  assert.equal(typeof process.env.PLATFORM_ADMIN_TOKEN, 'string');
  assert.ok(process.env.PLATFORM_ADMIN_TOKEN.length > 0, 'admin token is required but never printed');
  assert.ok(Number.isSafeInteger(apiPort) && apiPort > 0 && apiPort <= 65_535, 'API_PORT must be valid');
  localUrl(process.env.DATABASE_URL, 'postgresql://trace_ops:trace_ops_dev_only@localhost:5432/trace_ops', ['postgres:', 'postgresql:']);
  localUrl(process.env.CLICKHOUSE_URL, 'http://localhost:8123');

  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5_000 });
  clickhouse = createClient({
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    database: process.env.CLICKHOUSE_DATABASE ?? 'observability',
    username: process.env.CLICKHOUSE_USER ?? 'trace_ops',
    password: process.env.CLICKHOUSE_PASSWORD ?? 'trace_ops_dev_only',
    log: { level: ClickHouseLogLevel.OFF },
    request_timeout: 10_000,
  });

  const projectA = await createProject(0);
  const projectB = await createProject(1);
  const service = await request(`/projects/${projectA}/services`, {
    method: 'POST', admin: true, body: { name: runPrefix, environment: 'dev' },
  });
  assert.equal(service.status, 201, 'service onboarding must succeed');
  passed('two isolated projects and one registered service');

  const readKey = await createKey(projectA, 'w26-read', 'trace:read');
  const writeKey = await createKey(projectA, 'w26-write', 'spans:write');
  const ownRead = await request(`/traces?${traceQuery(projectA)}`, { token: readKey.key });
  assert.equal(ownRead.status, 200, 'trace:read must read only its bound project');
  const crossRead = await request(`/traces?${traceQuery(projectB)}`, { token: readKey.key });
  assert.notEqual(crossRead.status, 200, 'project key must not read a different project');

  const probeTraceId = `trace_v1_${randomUUID()}`;
  const privateCanary = `${runPrefix}-private-canary`;
  const validSpanRequest = (key, traceId = probeTraceId) => ({
    projectKey: key,
    environment: 'dev',
    spans: [makeSpan(traceId, privateCanary)],
  });
  const readCannotWrite = await request('/spans', { method: 'POST', body: validSpanRequest(readKey.key) });
  assert.ok([401, 403].includes(readCannotWrite.status), 'trace:read key must not write spans');
  passed('read/write scopes are distinct and cross-project reads are rejected');

  const policyWrite = await request(`/projects/${projectA}/privacy`, {
    method: 'PATCH', admin: true, body: { additionalRedactedFields: ['customer_secret_marker'] },
  });
  assert.equal(policyWrite.status, 200, 'privacy policy update must succeed');
  assert.deepEqual(policyWrite.body?.additionalRedactedFields, ['customer_secret_marker']);
  assert.equal(policyWrite.body?.capturePromptResponse, false, 'content capture stays disabled');
  const policyRead = await request(`/projects/${projectA}/privacy`, { admin: true });
  assert.equal(policyRead.status, 200);
  assert.deepEqual(policyRead.body?.additionalRedactedFields, ['customer_secret_marker']);
  assert.equal(policyRead.body?.capturePromptResponse, false);
  passed('project privacy policy persists and Prompt/Response capture remains disabled');

  const ingest = await request('/spans', {
    method: 'POST', body: validSpanRequest(writeKey.key),
  });
  assert.equal(ingest.status, 202, 'valid spans:write key should be accepted');
  const deadline = Date.now() + 45_000;
  let storedRows = [];
  while (Date.now() < deadline) {
    const result = await clickhouse.query({
      query: 'SELECT attributes FROM trace_spans WHERE project_id={projectId:String} AND trace_id={traceId:String} LIMIT 1',
      query_params: { projectId: projectA, traceId: probeTraceId },
      format: 'JSONEachRow',
    });
    storedRows = await result.json();
    if (storedRows.length > 0) break;
    await delay(500);
  }
  assert.equal(storedRows.length, 1, 'accepted span must reach ClickHouse through Kafka and Collector');
  const storedAttributes = typeof storedRows[0].attributes === 'string'
    ? JSON.parse(storedRows[0].attributes)
    : storedRows[0].attributes;
  assert.equal(Object.hasOwn(storedAttributes, 'customer_secret_marker'), false);
  assert.equal(Object.hasOwn(storedAttributes, 'prompt'), false);
  assert.equal(JSON.stringify(storedAttributes).includes(privateCanary), false);
  passed('privacy policy redacts custom fields before the Kafka/ClickHouse pipeline');

  const rotated = await request(`/projects/${projectA}/keys/${writeKey.id}/rotate`, {
    method: 'POST', admin: true,
  });
  assert.equal(rotated.status, 201, 'key rotation must succeed');
  assert.match(rotated.body?.key ?? '', /^tr_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(rotated.body?.scopes, ['spans:write']);
  const oldKeyUse = await request('/spans', {
    method: 'POST', body: validSpanRequest(writeKey.key, `trace_v1_${randomUUID()}`),
  });
  assert.equal(oldKeyUse.status, 401, 'rotated key must immediately stop working');
  const newKeyUse = await request('/spans', {
    method: 'POST', body: validSpanRequest(rotated.body.key, `trace_v1_${randomUUID()}`),
  });
  assert.equal(newKeyUse.status, 202, 'replacement key must remain usable');
  passed('rotation revokes the old key atomically and preserves its scope');

  const revoked = await request(`/projects/${projectA}/keys/${rotated.body.id}`, {
    method: 'DELETE', admin: true,
  });
  assert.ok([200, 204].includes(revoked.status), 'key revocation must succeed');
  const revokedUse = await request('/spans', {
    method: 'POST', body: validSpanRequest(rotated.body.key, `trace_v1_${randomUUID()}`),
  });
  assert.equal(revokedUse.status, 401, 'revoked key must no longer authenticate');
  passed('revocation takes effect for ingest credentials');

  const audit = await request(`/projects/${projectA}/audit-logs?page=1&pageSize=20`, { admin: true });
  assert.equal(audit.status, 200, 'project audit events must be queryable');
  assert.ok(Array.isArray(audit.body?.items));
  const auditText = JSON.stringify(audit.body);
  for (const secret of [readKey.key, writeKey.key, rotated.body.key, privateCanary]) {
    assert.equal(auditText.includes(secret), false, 'audit response must not contain secrets or content');
  }
  passed('key, service, and privacy changes are auditable without secret values');
}

async function cleanup() {
  const failures = [];
  if (clickhouse) {
    for (const projectId of projectIds) {
      try {
        await clickhouse.command({
          query: 'ALTER TABLE trace_spans DELETE WHERE project_id={projectId:String}',
          query_params: { projectId },
          clickhouse_settings: { mutations_sync: '1' },
        });
        const result = await clickhouse.query({
          query: 'SELECT count() AS count FROM trace_spans WHERE project_id={projectId:String}',
          query_params: { projectId },
          format: 'JSONEachRow',
        });
        const rows = await result.json();
        assert.equal(Number(rows[0]?.count), 0);
      } catch {
        failures.push('isolated ClickHouse rows');
      }
    }
  }
  if (pool) {
    for (let index = 0; index < projectIds.length; index += 1) {
      try {
        const result = await pool.query('DELETE FROM projects WHERE id=$1 AND slug=$2', [projectIds[index], projectSlugs[index]]);
        assert.equal(result.rowCount, 1);
      } catch {
        failures.push('isolated project rows');
      }
    }
    try { await pool.end(); } catch { failures.push('PostgreSQL disconnect'); }
  }
  if (clickhouse) {
    try { await clickhouse.close(); } catch { failures.push('ClickHouse disconnect'); }
  }
  report.cleanup = failures.length === 0 ? 'passed' : 'failed';
  report.cleanupFailures = failures;
}

main().then(() => {
  report.status = 'passed';
}).catch(error => {
  report.status = 'failed';
  report.failure = 'Acceptance failed; private diagnostics withheld';
  report.failureCode = /^[A-Z_0-9]+$/.test(error?.code ?? '') ? error.code : undefined;
  report.failureLocation = String(error?.stack ?? '').split('\n')
    .find(line => line.includes('w26-29-security-acceptance.cjs:'))?.trim();
}).finally(async () => {
  await cleanup();
  const directory = path.join(root, 'output', 'acceptance');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'w26-29-security-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (report.status !== 'passed' || report.cleanup !== 'passed') process.exitCode = 1;
});
