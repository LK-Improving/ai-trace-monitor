// Explicitly opted-in, localhost-only, isolated HTTP -> Kafka -> Collector -> ClickHouse acceptance.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const rootRequire = createRequire(path.join(root, 'package.json'));
createRequire(rootRequire.resolve('dotenv-cli/package.json'))('dotenv').config({ path: path.join(root, '.env') });
const requireApi = createRequire(path.join(root, 'apps/api/package.json'));
const { Pool } = requireApi('pg');
const { Kafka, logLevel } = requireApi('kafkajs');
const { createClient, ClickHouseLogLevel } = requireApi('@clickhouse/client');
const run = `w9-${randomUUID()}`;
const projectId = randomUUID();
const children = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
let pool, ch, admin, projectCreated = false, topicCreated = false, connected = false;
const report = { status: 'running', checks: [], cleanup: 'pending' };
async function freePort() {
  const server = net.createServer();
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port;
  await new Promise(ok => server.close(ok));
  return port;
}
async function until(predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(200);
  }
  throw new Error('Readiness deadline exceeded');
}
function launch(entry, env, cwd) {
  const child = spawn(process.execPath, [entry], { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', x => { child.output = (child.output + x.toString()).slice(-32768); });
  child.stderr.on('data', x => { child.output = (child.output + x.toString()).slice(-32768); });
  child.on('error', () => { child.failed = true; });
  children.push(child);
  return child;
}
async function request(port, route, traceId, extra = {}) {
  return fetch(`http://127.0.0.1:${port}/api/v1${route}`, {
    signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${process.env.PLATFORM_ADMIN_TOKEN}`, 'x-trace-id': traceId, ...extra },
  });
}
async function rows() {
  const result = await ch.query({
    query: 'SELECT trace_id, span_id, parent_span_id, operation, service, environment, status, attributes, error, total_tokens FROM trace_spans WHERE project_id={id:String}',
    query_params: { id: projectId }, format: 'JSONEachRow',
  });
  return result.json();
}
async function startApi(env) {
  const port = await freePort();
  const child = launch(path.join(root, 'scripts/w9-fixture-server.cjs'), { ...env, API_PORT: String(port) }, path.join(root, 'apps/api'));
  await until(async () => {
    assert(!child.failed && child.exitCode === null && child.signalCode === null);
    try { return (await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  });
  return port;
}
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.failed) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(r => child.once('exit', r)), delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([new Promise(r => child.once('exit', r)), delay(3000)]);
  }
  assert(child.exitCode !== null || child.signalCode !== null);
}
async function main() {
  assert.equal(process.env.TRACE_OPS_RUN_INTEGRATION, '1', 'Explicit opt-in required');
  const local = host => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
  assert(local(new URL(process.env.DATABASE_URL).hostname));
  assert(local(new URL(process.env.CLICKHOUSE_URL).hostname));
  assert(process.env.PLATFORM_ADMIN_TOKEN);
  assert.equal(process.env.CLICKHOUSE_TABLE ?? 'trace_spans', 'trace_spans');
  const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map(s => s.trim());
  assert(brokers.every(b => /^(localhost|127\.0\.0\.1):\d+$/.test(b)));
  pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  ch = createClient({ url: process.env.CLICKHOUSE_URL, username: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD, database: process.env.CLICKHOUSE_DATABASE,
    request_timeout: 5000, log: { level: ClickHouseLogLevel.OFF } });
  admin = new Kafka({ clientId: run, brokers, logLevel: logLevel.NOTHING, requestTimeout: 5000, retry: { retries: 1 } }).admin();
  await admin.connect(); connected = true;
  assert(!(await admin.listTopics()).includes(run));
  assert(!(await admin.listGroups()).groups.some(g => g.groupId === run));
  assert(await admin.createTopics({ waitForLeaders: true, topics: [{ topic: run, numPartitions: 1, replicationFactor: 1 }] }));
  topicCreated = true;
  await pool.query('INSERT INTO projects(id,name,slug) VALUES($1,$2,$3)', [projectId, 'W9 isolated acceptance', run]);
  projectCreated = true;
  await pool.query('INSERT INTO services(project_id,name,environment) VALUES($1,$2,$3)', [projectId, 'w9-api', 'dev']);
  const env = { ...process.env, KAFKA_TOPIC: run, KAFKA_GROUP_ID: run,
    SERVER_TRACE_ENABLED: 'true', SERVER_TRACE_PROJECT_ID: projectId, SERVER_TRACE_SERVICE: 'w9-api', SERVER_TRACE_ENVIRONMENT: 'dev' };
  const collector = launch(path.join(root, 'apps/collector/dist/main.js'), env, path.join(root, 'apps/collector'));
  await until(async () => { assert(!collector.failed && collector.exitCode === null); return collector.output.includes('Collector subscribed to'); });
  const port = await startApi(env);
  const health = await (await request(port, '/health', 'w9-health-excluded')).json();
  assert.equal(health.tracing.state, 'ready');
  await request(port, '/spans/status', 'w9-ingest-excluded');
  const ids = Array.from({ length: 6 }, (_, i) => `w9-concurrent-${i}-${run}`);
  const responses = await Promise.all(ids.map(id => request(port, '/w9-fixture/success?prompt=w9-private-canary', id, { 'x-project-id': randomUUID() })));
  for (let i = 0; i < responses.length; i++) {
    assert.equal(responses[i].status, 200);
    assert.equal(responses[i].headers.get('x-trace-id'), ids[i]);
    assert.equal((await responses[i].json()).traced, true);
  }
  const errorId = `w9-error-${run}`;
  assert.equal((await request(port, '/w9-fixture/failure', errorId)).status, 500);
  const badId = `w9-bad-${run}`;
  assert.equal((await request(port, '/w9-fixture/badRequest', badId)).status, 400);
  const invalid = await request(port, '/w9-fixture/success', 'bad trace id');
  assert.equal(invalid.status, 200);
  assert.match(invalid.headers.get('x-trace-id'), /^trace_v1_/);
  const apiTraceId = `w9-real-api-${run}`;
  assert.equal((await request(port, `/projects/${projectId}/services`, apiTraceId)).status, 200);
  let stored;
  await until(async () => { stored = await rows(); return stored.length >= 32; });
  assert.equal(stored.length, 32);
  assert(stored.every(r => r.service === 'w9-api' && r.environment === 'dev'));
  assert(!JSON.stringify(stored).includes('w9-private-canary'));
  assert(stored.every(r => r.error === ''));
  assert(!stored.some(r => ['w9-health-excluded', 'w9-ingest-excluded'].includes(r.trace_id)));
  for (const id of ids) {
    const spans = stored.filter(r => r.trace_id === id);
    assert.equal(spans.length, 4);
    const rootSpan = spans.find(r => r.operation === 'http.server');
    const rag = spans.find(r => r.operation === 'rag.retrieve');
    const llm = spans.find(r => r.operation === 'llm.generate');
    const tool = spans.find(r => r.operation === 'tool.search');
    assert.equal(rootSpan.parent_span_id, '');
    assert.equal(rag.parent_span_id, rootSpan.span_id);
    assert.equal(llm.parent_span_id, rootSpan.span_id);
    assert.equal(tool.parent_span_id, rag.span_id);
    assert.equal(Number(llm.total_tokens), 30);
    assert.equal(rootSpan.status, 'ok');
    assert.equal(JSON.parse(rootSpan.attributes)['http.status_code'], 200);
  }
  for (const [id, status] of [[errorId, 500], [badId, 400]]) {
    const span = stored.find(r => r.trace_id === id && r.operation === 'http.server');
    assert.equal(span.status, 'error');
    assert.equal(JSON.parse(span.attributes)['http.status_code'], status);
  }
  const apiSpan = stored.find(r => r.trace_id === apiTraceId && r.operation === 'http.server');
  const route = JSON.parse(apiSpan.attributes)['http.route'];
  assert(route.includes(':projectId') && !route.includes(projectId));
  report.spanCount = stored.length;
  report.checks.push('real HTTP/Kafka/Collector/ClickHouse', 'six concurrent trace trees', 'nested parent IDs', 'status 200/400/500', 'invalid ID replacement', 'privacy', 'health/ingest exclusions', 'trusted tenant binding');
  // Disable tracing for analytical reads so acceptance does not count its own query.
  const readPort = await startApi({ ...env, SERVER_TRACE_ENABLED: 'false' });
  const overview = await (await request(readPort, `/overview?projectId=${projectId}&environment=dev&range=24h`, 'w9-read')).json();
  assert.equal(overview.metrics.requestCount, 10);
  assert.equal(overview.metrics.errorCount, 2);
  assert.equal(overview.metrics.totalTokens, 210);
  const prod = await (await request(readPort, `/overview?projectId=${projectId}&environment=prod&range=24h`, 'w9-prod')).json();
  assert.equal(prod.metrics.requestCount, 0);
  report.checks.push('root-only overview counts', 'token counts without root duplication', 'environment isolation');
  const unreachable = await freePort();
  const outagePort = await startApi({ ...env, KAFKA_BROKERS: `127.0.0.1:${unreachable}`, SPAN_QUEUE_MAX_SPANS: '1', SPAN_QUEUE_MAX_RETRIES: '0' });
  const started = Date.now();
  const outageResponse = await request(outagePort, '/w9-fixture/success', `w9-outage-${run}`);
  assert.equal(outageResponse.status, 200);
  report.outageResponseMs = Date.now() - started;
  assert(report.outageResponseMs < 1000);
  let queue;
  await until(async () => {
    queue = await (await request(outagePort, '/spans/status', 'w9-outage-status')).json();
    return queue.droppedSpans >= 4 && queue.publishErrorCount > 0 && queue.queueDepth === 0;
  });
  assert.equal(queue.publishedSpans, 0);
  report.checks.push('Kafka outage and full queue preserve HTTP 200', 'observable queue drops');
  const protectedValues = [process.env.DATABASE_URL, process.env.PLATFORM_ADMIN_TOKEN,
    process.env.CLICKHOUSE_PASSWORD, process.env.POSTGRES_PASSWORD, 'w9-private-canary']
    .filter(value => typeof value === 'string' && value.length >= 8);
  assert(children.every(child => protectedValues.every(value => !child.output.includes(value))));
  report.checks.push('child logs contain no private canary or configured credentials');
  report.status = 'passed';
}
async function cleanup() {
  const failures = [];
  const attempt = async (name, fn) => { try { await fn(); } catch { failures.push(name); } };
  for (const child of children.reverse()) await attempt('owned child', () => stopChild(child));
  if (projectCreated) {
    await attempt('ClickHouse rows', async () => {
      await ch.command({ query: 'ALTER TABLE trace_spans DELETE WHERE project_id={id:String}', query_params: { id: projectId }, clickhouse_settings: { mutations_sync: '1' } });
      assert.equal((await rows()).length, 0);
    });
    await attempt('PostgreSQL project', async () => {
      assert.equal((await pool.query('DELETE FROM projects WHERE id=$1 AND slug=$2', [projectId, run])).rowCount, 1);
      assert.equal((await pool.query('SELECT id FROM projects WHERE id=$1', [projectId])).rowCount, 0);
    });
  }
  if (connected && topicCreated) {
    await attempt('Kafka group', async () => {
      await until(async () => {
        if (!(await admin.listGroups()).groups.some(g => g.groupId === run)) return true;
        try { await admin.deleteGroups([run]); } catch { /* Owned stopped group's session may expire. */ }
        return false;
      }, 50000);
    });
    await attempt('Kafka topic', async () => {
      await admin.deleteTopics({ topics: [run], timeout: 10000 });
      await until(async () => !(await admin.listTopics()).includes(run));
    });
  }
  if (connected) await attempt('Kafka close', () => admin.disconnect());
  if (pool) await attempt('PostgreSQL close', () => pool.end());
  if (ch) await attempt('ClickHouse close', () => ch.close());
  report.cleanup = failures.length ? 'failed' : 'passed';
  report.cleanupFailures = failures;
}
main().catch(error => {
  report.status = 'failed';
  report.failure = 'Acceptance assertion or dependency failed; credentials withheld';
  // Include only our source location, never exception messages or dependency logs.
  report.failureLocation = String(error?.stack ?? '').split('\n')
    .find(line => line.includes('w9-chain-acceptance.cjs:'))?.trim();
})
  .finally(async () => {
    await cleanup();
    fs.mkdirSync(path.join(root, 'output/acceptance'), { recursive: true });
    fs.writeFileSync(path.join(root, 'output/acceptance/w9-chain-result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (report.status !== 'passed' || report.cleanup !== 'passed') process.exitCode = 1;
  });
