// Executes the exact documented Node snippet against an active isolated W18 session.
// Credentials and raw process diagnostics are never printed or saved.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const rootRequire = createRequire(path.join(root, 'package.json'));
createRequire(rootRequire.resolve('dotenv-cli/package.json'))('dotenv').config({ path: path.join(root, '.env') });
const apiRequire = createRequire(path.join(root, 'apps/api/package.json'));
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
const { Pool } = apiRequire('pg');
const { createClient, ClickHouseLogLevel } = apiRequire('@clickhouse/client');
const slug = `p2-quickstart-${randomUUID()}`;
const report = { status: 'running', cleanup: 'pending' };
let pool, ch, projectId, child, projectKey;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  assert.equal(process.env.TRACE_OPS_RUN_INTEGRATION, '1');
  const session = JSON.parse(fs.readFileSync(path.join(root, 'output/acceptance/w18-session.json'), 'utf8'));
  const api = new URL(session.fixtureUrl);
  assert.equal(api.hostname, '127.0.0.1'); assert.equal(api.protocol, 'http:');
  const local = value => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
  assert(local(process.env.DATABASE_URL) && local(process.env.CLICKHOUSE_URL));
  assert.equal(process.env.CLICKHOUSE_TABLE ?? 'trace_spans', 'trace_spans');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  ch = createClient({ url: process.env.CLICKHOUSE_URL, database: process.env.CLICKHOUSE_DATABASE,
    username: process.env.CLICKHOUSE_USER, password: process.env.CLICKHOUSE_PASSWORD,
    request_timeout: 10000, log: { level: ClickHouseLogLevel.OFF } });
  async function post(route, body) {
    const response = await fetch(new URL(`/api/v1${route}`, api), { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${process.env.PLATFORM_ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body) });
    assert.equal(response.status, 201); return response.json();
  }
  const project = await post('/projects', { name: 'P2 Quickstart acceptance', slug });
  projectId = project.id;
  assert.match(projectId, /^[a-f0-9-]{36}$/);
  assert.equal((await pool.query('SELECT slug FROM projects WHERE id=$1', [projectId])).rows[0].slug, slug);
  await post(`/projects/${projectId}/services`, { name: 'quickstart-api', environment: 'dev' });
  projectKey = (await post(`/projects/${projectId}/keys`, { name: 'isolated-quickstart' })).key;
  assert.match(projectKey, /^tr_[A-Za-z0-9_-]{43}$/);
  const ts = webRequire('typescript');
  const source = fs.readFileSync(path.join(root, 'apps/web/src/quickstart.ts'), 'utf8');
  const moduleExports = {};
  new Function('exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(moduleExports);
  assert.equal(moduleExports.NODE_QUICKSTART, moduleExports.getQuickstartSnippet('node'));
  let output = '', errorOutput = '';
  child = spawn(process.execPath, ['--input-type=module', '-'], { cwd: root, windowsHide: true,
    env: { ...process.env, TRACE_OPS_ENDPOINT: new URL('/api/v1/spans', api).href,
      TRACE_OPS_PROJECT_KEY: projectKey, TRACE_OPS_SERVICE: 'quickstart-api', TRACE_OPS_ENVIRONMENT: 'dev' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { output = (output + data).slice(-16384); });
  child.stderr.on('data', data => { errorOutput = (errorOutput + data).slice(-16384); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Snippet deadline')); }, 10000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Snippet startup')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Snippet failed')); });
    child.stdin.end(moduleExports.NODE_QUICKSTART + '\nconsole.log(JSON.stringify({quickstartTraceId: traceId}));');
  });
  assert(!output.includes(projectKey) && !errorOutput.includes(projectKey));
  const match = output.match(/"quickstartTraceId":"(trace_v1_[a-f0-9-]{36})"/);
  assert(match);
  const traceId = match[1];
  let stored = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await ch.query({ query: 'SELECT trace_id,span_id,parent_span_id,service,operation,attributes FROM trace_spans WHERE project_id={id:String}',
      query_params: { id: projectId }, format: 'JSONEachRow' });
    stored = await result.json(); if (stored.length === 2) break; await delay(200);
  }
  assert.equal(stored.length, 2); assert(stored.every(row => row.trace_id === traceId && row.service === 'quickstart-api'));
  const parent = stored.find(row => row.operation === 'http.server');
  const work = stored.find(row => row.operation === 'quickstart.work');
  assert(parent && work); assert.equal(parent.parent_span_id, ''); assert.equal(work.parent_span_id, parent.span_id);
  assert(!JSON.stringify(stored).includes(projectKey));
  report.status = 'passed'; report.spans = 2;
  report.checks = ['real management API project/service/key creation', 'exact displayed Node snippet executes with HTTP 202',
    'Kafka/Collector/ClickHouse stores two related spans', 'no project key in output or stored spans'];
}
main().catch(() => { report.status = 'failed'; report.failure = 'Quickstart acceptance failed; private diagnostics withheld'; }).finally(async () => {
  const failures = [];
  const attempt = async (name, fn) => { try { await fn(); } catch { failures.push(name); } };
  if (child && child.exitCode === null && child.signalCode === null) await attempt('owned snippet process', async () => {
    child.kill(); await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(3000)]);
    assert(child.exitCode !== null || child.signalCode !== null);
  });
  if (projectId) {
    await attempt('owned rows', async () => {
      assert.equal((await pool.query('SELECT slug FROM projects WHERE id=$1', [projectId])).rows[0]?.slug, slug);
      await ch.command({ query: 'ALTER TABLE trace_spans DELETE WHERE project_id={id:String}', query_params: { id: projectId },
        clickhouse_settings: { mutations_sync: '1' } });
      const result = await ch.query({ query: 'SELECT count() AS count FROM trace_spans WHERE project_id={id:String}', query_params: { id: projectId }, format: 'JSONEachRow' });
      assert.equal(Number((await result.json())[0].count), 0);
    });
    await attempt('owned project', async () => { assert.equal((await pool.query('DELETE FROM projects WHERE id=$1 AND slug=$2', [projectId, slug])).rowCount, 1); });
  }
  if (pool) await attempt('PG close', () => pool.end());
  if (ch) await attempt('CH close', () => ch.close());
  report.cleanup = failures.length ? 'failed' : 'passed'; report.cleanupFailures = failures;
  fs.writeFileSync(path.join(root, 'output/acceptance/p2-quickstart-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); if (report.status !== 'passed' || failures.length) process.exitCode = 1;
});
