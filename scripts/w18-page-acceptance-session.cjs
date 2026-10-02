// Isolated local pipeline + real HTTP read API. Never print private diagnostics.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const root = path.resolve(__dirname, '..');
const rootRequire = createRequire(path.join(root, 'package.json'));
createRequire(rootRequire.resolve('dotenv-cli/package.json'))('dotenv').config({ path: path.join(root, '.env') });
const apiRequire = createRequire(path.join(root, 'apps/api/package.json'));
const { Pool } = apiRequire('pg');
const { Kafka, logLevel } = apiRequire('kafkajs');
const { createClient, ClickHouseLogLevel } = apiRequire('@clickhouse/client');
const run = `w18-${randomUUID()}`, ids = [randomUUID(), randomUUID()], children = [], created = [];
const report = { status: 'running', cleanup: 'pending', checks: [] }, delay = ms => new Promise(r => setTimeout(r, ms));
let pool, ch, admin, connected = false, topicCreated = false;
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(200); }
  throw new Error('Acceptance deadline exceeded');
}
async function freePort() {
  const s = net.createServer(); await new Promise((r, j) => { s.once('error', j); s.listen(0, '127.0.0.1', r); });
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}
function launch(entry, env, cwd) {
  const c = spawn(process.execPath, [entry], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  c.output = ''; const capture = b => { c.output = (c.output + b.toString()).slice(-32768); };
  c.stdout.on('data', capture); c.stderr.on('data', capture); c.on('error', () => { c.failed = true; });
  children.push(c); return c;
}
async function start(env) {
  const port = await freePort();
  const child = launch(path.join(root, 'scripts/w11-fixture-server.cjs'), { ...env, API_PORT: String(port) }, path.join(root, 'apps/api'));
  await until(async () => {
    assert(!child.failed && child.exitCode === null && child.signalCode === null);
    try { return (await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  }); return port;
}
async function request(port, route, expected = 200, auth = true, traceId = `read-${randomUUID()}`) {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1${route}`, { signal: AbortSignal.timeout(12000), headers: {
    'x-trace-id': traceId, ...(auth ? { authorization: `Bearer ${process.env.PLATFORM_ADMIN_TOKEN}` } : {}),
  } });
  assert.equal(r.status, expected); const body = await r.json();
  assert(!JSON.stringify(body).includes('w18-private-content-canary')); return body;
}
async function rows(projectId) {
  const r = await ch.query({ query: 'SELECT * FROM trace_spans WHERE project_id={id:String}', query_params: { id: projectId }, format: 'JSONEachRow' });
  return r.json();
}
async function main() {
  assert.equal(process.env.TRACE_OPS_RUN_INTEGRATION, '1');
  const local = h => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h);
  assert(local(new URL(process.env.DATABASE_URL).hostname) && local(new URL(process.env.CLICKHOUSE_URL).hostname));
  assert(process.env.PLATFORM_ADMIN_TOKEN); assert.equal(process.env.CLICKHOUSE_TABLE ?? 'trace_spans', 'trace_spans');
  const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map(s => s.trim());
  assert(brokers.every(b => /^(localhost|127\.0\.0\.1):\d+$/.test(b)));
  pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  ch = createClient({ url: process.env.CLICKHOUSE_URL, database: process.env.CLICKHOUSE_DATABASE, username: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD, request_timeout: 10000, log: { level: ClickHouseLogLevel.OFF } });
  admin = new Kafka({ clientId: run, brokers, logLevel: logLevel.NOTHING, retry: { retries: 1 }, requestTimeout: 5000 }).admin();
  await admin.connect(); connected = true;
  assert(!(await admin.listTopics()).includes(run)); assert(!(await admin.listGroups()).groups.some(g => g.groupId === run));
  assert(await admin.createTopics({ waitForLeaders: true, topics: [{ topic: run, numPartitions: 1, replicationFactor: 1 }] })); topicCreated = true;
  for (const [i, id] of ids.entries()) {
    await pool.query('INSERT INTO projects(id,name,slug) VALUES($1,$2,$3)', [id, 'W18 isolated acceptance', `${run}-${i}`]); created.push(id);
    await pool.query('INSERT INTO services(project_id,name,environment) VALUES($1,$2,$3)', [id, 'w18-api', 'dev']);
  }
  const env = { ...process.env, KAFKA_TOPIC: run, KAFKA_GROUP_ID: run, SERVER_TRACE_ENABLED: 'true',
    SERVER_TRACE_PROJECT_ID: ids[0], SERVER_TRACE_SERVICE: 'w18-api', SERVER_TRACE_ENVIRONMENT: 'dev' };
  const collector = launch(path.join(root, 'apps/collector/dist/main.js'), env, path.join(root, 'apps/collector'));
  await until(async () => { assert(!collector.failed && collector.exitCode === null); return collector.output.includes('Collector subscribed to'); });
  const port = await start(env), cases = [];
  await Promise.all(['complete', 'stream', 'noUsage', 'rateLimit', 'timeout', 'cancel'].map(async mode => {
    const traceId = `trace-${mode}-${randomUUID()}`; cases.push({ mode, traceId });
    await request(port, `/w11-fixture/chat/${mode}`, ['rateLimit', 'timeout'].includes(mode) ? 500 : 200, true, traceId);
  }));
  let stored; await until(async () => { stored = await rows(ids[0]); return stored.length >= 30; }); assert.equal(stored.length, 30);
  const completeId = cases.find(c => c.mode === 'complete').traceId, original = stored.filter(r => r.trace_id === completeId);
  await ch.insert({ table: 'trace_spans', format: 'JSONEachRow', values: original });
  const template = original.find(r => r.operation === 'http.server');
  const row = (projectId, environment, traceId, spanId, parentSpanId, status) => ({ ...template,
    project_id: projectId, environment, trace_id: traceId, span_id: spanId, parent_span_id: parentSpanId, status,
    attributes: JSON.stringify({ prompt: 'w18-private-content-canary', custom: 'w18-private-content-canary', 'ai.error_category': 'timeout' }),
    error: 'w18-private-content-canary', input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  const anomalies = `${run}-anomalies`;
  const serviceTrace = `${run}-service-filter`;
  await ch.insert({ table: 'trace_spans', format: 'JSONEachRow', values: [
    row(ids[0], 'prod', completeId, 'prod-root', '', 'ok'), row(ids[1], 'dev', completeId, 'other-root', '', 'ok'),
    row(ids[0], 'dev', anomalies, 'orphan', 'missing', 'error'), row(ids[0], 'dev', anomalies, 'cycle-a', 'cycle-b', 'ok'),
    row(ids[0], 'dev', anomalies, 'cycle-b', 'cycle-a', 'ok'),
    row(ids[0], 'dev', serviceTrace, 'service-root', '', 'ok'),
    { ...row(ids[0], 'dev', serviceTrace, 'service-child', 'service-root', 'ok'), service: 'tool-only', operation: 'tool.execute' },
  ] });
  const largeTraceId = `${run}-large-tree`;
  await ch.insert({ table: 'trace_spans', format: 'JSONEachRow', values: Array.from({ length: 2001 }, (_, index) =>
    row(ids[1], 'dev', largeTraceId, `deep-${String(index).padStart(4, '0')}`,
      index ? `deep-${String(index - 1).padStart(4, '0')}` : '', 'ok')) });
  await ch.insert({ table: 'trace_spans', format: 'JSONEachRow', values: Array.from({ length: 26 }, (_, index) =>
    row(ids[1], 'dev', `${run}-page-${index}`, `page-root-${index}`, '', 'ok')) });
  const readPort = await start({ ...env, SERVER_TRACE_ENABLED: 'false' });
  const bounds = `from=${new Date(Date.now() - 3600000).toISOString()}&to=${new Date(Date.now() + 60000).toISOString()}`;
  const list = q => `/traces?projectId=${ids[0]}&environment=dev&${bounds}${q ? '&' + q : ''}`;
  const detail = (id, project = ids[0], environment = 'dev') => `/traces/${id}?projectId=${project}&environment=${environment}&${bounds}`;
  const all = await request(readPort, list('pageSize=100')); assert.equal(all.total, 8); assert.equal(all.items.length, 8);
  const allEnvironments = await request(readPort, `/traces?projectId=${ids[0]}&environment=all&${bounds}`);
  assert.equal(allEnvironments.total, 9); assert.equal(allEnvironments.items.filter(i => i.traceId === completeId).length, 2);
  const item = all.items.find(i => i.traceId === completeId); assert.equal(item.totalTokens, 30); assert.equal(item.spanCount, 5);
  const full = await request(readPort, detail(completeId)); assert.equal(full.spans.length, 5); assert.equal(full.summary.totalTokens, 30);
  assert.equal(full.rootSpan.operation, 'http.server'); assert.equal(full.tree.orphanSpanIds.length, 0); assert.equal(full.tree.cycleSpanIds.length, 0);
  const cancelled = await request(readPort, list('status=error'));
  assert.equal(cancelled.total, 4); assert(cancelled.items.some(i => i.traceId === cases.find(c => c.mode === 'cancel').traceId));
  const service = await request(readPort, list('service=w18-api&traceId=' + completeId)); assert.equal(service.items[0].spanCount, 5);
  const childService = await request(readPort, list('service=tool-only')); assert.equal(childService.total, 1);
  assert.equal(childService.items[0].spanCount, 2); assert.deepEqual([...childService.items[0].services].sort(), ['tool-only', 'w18-api']);
  assert.equal((await request(readPort, list('service=not-registered'))).total, 0);
  const p1 = await request(readPort, list('page=1&pageSize=2')), p2 = await request(readPort, list('page=2&pageSize=2'));
  assert.equal(p1.total, 8); assert.equal(p2.total, 8); assert(!p1.items.some(a => p2.items.some(b => a.traceId === b.traceId)));
  const prod = await request(readPort, detail(completeId, ids[0], 'prod')); assert.equal(prod.spans[0].spanId, 'prod-root');
  const other = await request(readPort, detail(completeId, ids[1])); assert.equal(other.spans[0].spanId, 'other-root');
  const broken = await request(readPort, detail(anomalies)); assert.equal(broken.rootSpan, null);
  assert.deepEqual(broken.tree.orphanSpanIds, ['orphan']); assert.deepEqual([...broken.tree.cycleSpanIds].sort(), ['cycle-a', 'cycle-b']);
  await request(readPort, list(), 401, false); await request(readPort, detail(completeId), 401, false);
  await request(readPort, detail(completeId) + '&includeContent=true', 403);
  await request(readPort, `/traces/${completeId}`, 400); await request(readPort, detail('missing-trace'), 404);
  await request(readPort, list('pageSize=101'), 400); await request(readPort, list('unknown=private'), 400);
  await request(readPort, `/traces?projectId=${randomUUID()}&environment=dev&${bounds}`, 404);
  const overview = await request(readPort, `/overview?projectId=${ids[0]}&environment=dev&range=24h`);
  // Legacy Overview intentionally counts stored rows, while traces deduplicate reads.
  assert.equal(overview.metrics.requestCount, 8); assert.equal(overview.metrics.errorCount, 2);
  assert.equal(overview.metrics.totalTokens, 90);

  // Hold isolated services alive for an independently driven real browser run.
  const webPort = await freePort();
  const viteEntry = path.join(root, 'scripts/w18-vite-server.mjs');
  const web = spawn(process.execPath, [viteEntry],
    { cwd: path.join(root, 'apps/web'), env: { ...env, API_PORT: String(readPort), W18_WEB_PORT: String(webPort), W18_FIXTURE_URL: `http://127.0.0.1:${port}` }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  web.output = ''; const capture = b => { web.output = (web.output + b.toString()).slice(-32768); };
  web.stdout.on('data', capture); web.stderr.on('data', capture); web.on('error', () => { web.failed = true; }); children.push(web);
  await until(async () => { assert(!web.failed && web.exitCode === null);
    try { return (await fetch(`http://127.0.0.1:${webPort}/`)).ok; } catch { return false; }
  });
  const session = { run, projectId: ids[0], otherProjectId: ids[1], webUrl: `http://127.0.0.1:${webPort}`,
    fixtureUrl: `http://127.0.0.1:${port}`, completeId, anomalies, largeTraceId, cases };
  fs.mkdirSync(path.join(root, 'output/acceptance'), { recursive: true });
  fs.writeFileSync(path.join(root, 'output/acceptance/w18-session.json'), JSON.stringify(session, null, 2));
  console.log(JSON.stringify({ ready: true, ...session }));
  await new Promise((resolve, reject) => {
    const input = readline.createInterface({ input: process.stdin });
    const timer = setTimeout(() => { reject(new Error('Browser acceptance deadline exceeded')); input.close(); }, 30 * 60 * 1000);
    input.on('line', line => {
      if (line.trim() === 'finish') { reject(new Error('Acceptance stopped before verification')); input.close(); return; }
      if (line.trim() !== 'verify') return;
      try {
        const evidence = JSON.parse(fs.readFileSync(path.join(root, 'output/acceptance/w18-browser-result.json'), 'utf8'));
        assert.equal(evidence.run, run); assert.equal(evidence.status, 'passed'); assert(evidence.checks.length >= 10);
        assert.equal(evidence.browserTraceIds.length, 2);
        assert(evidence.browserTraceIds.every(id => /^trace_web_[0-9a-f-]{36}$/.test(id)));
        report.browser = evidence; clearTimeout(timer); resolve(); input.close();
      } catch { clearTimeout(timer); input.close(); reject(new Error('Browser evidence missing or failed')); }
    });
    input.on('close', () => { clearTimeout(timer); reject(new Error('Browser session ended')); });
  });

  for (const traceId of report.browser.browserTraceIds) {
    await until(async () => (await rows(ids[0])).filter(row => row.trace_id === traceId).length === 5);
    // The browser can run for up to 30 minutes after the initial fixture window.
    // Do not reuse its fixed upper bound for traces generated later by the browser.
    const browserBounds = `from=${new Date(Date.now() - 3600000).toISOString()}&to=${new Date(Date.now() + 60000).toISOString()}`;
    const detailResponse = await request(readPort, `/traces/${traceId}?projectId=${ids[0]}&environment=dev&${browserBounds}`);
    assert.equal(detailResponse.spans.length, 5);
    assert.equal(detailResponse.rootSpan.operation, 'http.server');
    assert(detailResponse.spans.some(span => span.operation === 'rag.retrieve'));
    assert(detailResponse.spans.some(span => span.operation === 'llm.generate'));
    assert.equal(detailResponse.tree.orphanSpanIds.length, 0);
  }

  const protectedValues = [process.env.PLATFORM_ADMIN_TOKEN, process.env.DATABASE_URL, process.env.CLICKHOUSE_PASSWORD,
    'w18-private-content-canary', 'w11-private-content-canary', 'w11-protocol-fixture-key-not-a-real-credential'].filter(v => typeof v === 'string' && v.length >= 8);
  assert(children.every(c => protectedValues.every(v => !c.output.includes(v))));
  const assetDir = path.join(root, 'apps/web/dist/assets');
  for (const filename of fs.readdirSync(assetDir).filter(name => /\.(js|css)$/.test(name))) {
    const contents = fs.readFileSync(path.join(assetDir, filename), 'utf8');
    assert(protectedValues.every(value => !contents.includes(value)), 'Browser asset credential scan failed');
  }
  report.checks = ['real six-request 30-span pipeline', 'list/detail HTTP', 'deduplication and token counts', 'child failure sets trace error',
    'stable pagination', 'whole trace service filter', 'project/environment isolation', 'orphan/cycle tree', 'safe attribute projection',
    'admin authorization', 'content denied', 'invalid bounds and missing resource', 'existing overview with shared query budgets',
    'real browser-generated Trace IDs correlate with RAG/LLM and stored five-span trees']; report.status = 'passed'; report.pipelineSpans = 40;
}
async function cleanup() {
  const failures = [], attempt = async (name, fn) => { try { await fn(); } catch { failures.push(name); } };
  for (const c of children.reverse()) await attempt('owned process', async () => {
    if (c.exitCode !== null || c.signalCode !== null || c.failed) return; c.kill('SIGTERM');
    await Promise.race([new Promise(r => c.once('exit', r)), delay(5000)]);
    if (c.exitCode === null && c.signalCode === null) { c.kill('SIGKILL'); await Promise.race([new Promise(r => c.once('exit', r)), delay(3000)]); }
    assert(c.exitCode !== null || c.signalCode !== null);
  });
  for (const id of created) {
    await attempt('isolated rows', async () => { await ch.command({ query: 'ALTER TABLE trace_spans DELETE WHERE project_id={id:String}',
      query_params: { id }, clickhouse_settings: { mutations_sync: '1' } }); assert.equal((await rows(id)).length, 0); });
    await attempt('isolated project', async () => { assert.equal((await pool.query('DELETE FROM projects WHERE id=$1 AND slug=$2', [id, `${run}-${ids.indexOf(id)}`])).rowCount, 1); });
  }
  if (connected && topicCreated) {
    await attempt('isolated group', () => until(async () => { if (!(await admin.listGroups()).groups.some(g => g.groupId === run)) return true;
      try { await admin.deleteGroups([run]); } catch {} return false; }, 50000));
    await attempt('isolated topic', async () => { await admin.deleteTopics({ topics: [run], timeout: 10000 }); await until(async () => !(await admin.listTopics()).includes(run)); });
  }
  if (connected) await attempt('Kafka close', () => admin.disconnect()); if (pool) await attempt('PG close', () => pool.end()); if (ch) await attempt('CH close', () => ch.close());
  report.cleanup = failures.length ? 'failed' : 'passed'; report.cleanupFailures = failures;
}
main().catch(error => { report.status = 'failed'; report.failure = 'Acceptance failed; sensitive diagnostics withheld';
  report.failureLocation = String(error?.stack ?? '').split('\n').find(l => l.includes('w18-page-acceptance-session.cjs:'))?.trim();
  report.failureCode = /^[A-Z_0-9]+$/.test(error?.code ?? '') ? error.code : undefined;
}).finally(async () => { await cleanup(); fs.mkdirSync(path.join(root, 'output/acceptance'), { recursive: true });
  fs.writeFileSync(path.join(root, 'output/acceptance/w18-page-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  if (report.status !== 'passed' || report.cleanup !== 'passed') process.exitCode = 1;
});
