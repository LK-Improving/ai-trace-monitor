// Opt-in localhost protocol transport + real Kafka/Collector/ClickHouse; no paid inference.
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
const apiRequire = createRequire(path.join(root, 'apps/api/package.json'));
const { Pool } = apiRequire('pg');
const { Kafka, logLevel } = apiRequire('kafkajs');
const { createClient, ClickHouseLogLevel } = apiRequire('@clickhouse/client');
const run = `w11-${randomUUID()}`, projectId = randomUUID();
const children = [], cases = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
const report = { status: 'running', inference: 'local-protocol-fixtures-only', cleanup: 'pending', checks: [] };
let pool, ch, admin, projectCreated = false, topicCreated = false, connected = false;
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(r => server.close(r));
  return port;
}
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(200); }
  throw new Error('Acceptance deadline exceeded');
}
function launch(entry, env, cwd) {
  const child = spawn(process.execPath, [entry], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  const capture = bytes => { child.output = (child.output + bytes.toString()).slice(-32768); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.on('error', () => { child.failed = true; });
  children.push(child);
  return child;
}
async function startApi(env) {
  const port = await freePort();
  const child = launch(path.join(root, 'scripts/w11-fixture-server.cjs'), { ...env, API_PORT: String(port) }, path.join(root, 'apps/api'));
  await until(async () => {
    assert(!child.failed && child.exitCode === null && child.signalCode === null);
    try { return (await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  });
  return port;
}
async function request(port, route, traceId) {
  return fetch(`http://127.0.0.1:${port}/api/v1${route}`, { signal: AbortSignal.timeout(5000), headers: {
    'x-trace-id': traceId, authorization: `Bearer ${process.env.PLATFORM_ADMIN_TOKEN}`,
  } });
}
async function rows() {
  const result = await ch.query({ query: 'SELECT trace_id,span_id,parent_span_id,operation,service,environment,status,attributes,error,total_tokens,model FROM trace_spans WHERE project_id={id:String}',
    query_params: { id: projectId }, format: 'JSONEachRow' });
  return result.json();
}
async function scenario(port, mode, expectedStatus) {
  const traceId = `trace-${mode}-${randomUUID()}`;
  const response = await request(port, `/w11-fixture/chat/${mode}`, traceId);
  assert.equal(response.status, expectedStatus);
  assert.equal(response.headers.get('x-trace-id'), traceId);
  const body = await response.json();
  assert(!JSON.stringify(body).includes('w11-private-content-canary'));
  cases.push({ mode, traceId, expectedStatus });
}
async function main() {
  assert.equal(process.env.TRACE_OPS_RUN_INTEGRATION, '1');
  const local = host => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
  assert(local(new URL(process.env.DATABASE_URL).hostname));
  assert(local(new URL(process.env.CLICKHOUSE_URL).hostname));
  assert(process.env.PLATFORM_ADMIN_TOKEN);
  assert.equal(process.env.CLICKHOUSE_TABLE ?? 'trace_spans', 'trace_spans');
  const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map(s => s.trim());
  assert(brokers.every(b => /^(localhost|127\.0\.0\.1):\d+$/.test(b)));
  pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  ch = createClient({ url: process.env.CLICKHOUSE_URL, username: process.env.CLICKHOUSE_USER, password: process.env.CLICKHOUSE_PASSWORD,
    database: process.env.CLICKHOUSE_DATABASE, request_timeout: 5000, log: { level: ClickHouseLogLevel.OFF } });
  admin = new Kafka({ clientId: run, brokers, logLevel: logLevel.NOTHING, retry: { retries: 1 }, requestTimeout: 5000 }).admin();
  await admin.connect(); connected = true;
  assert(!(await admin.listTopics()).includes(run));
  assert(!(await admin.listGroups()).groups.some(g => g.groupId === run));
  assert(await admin.createTopics({ waitForLeaders: true, topics: [{ topic: run, numPartitions: 1, replicationFactor: 1 }] }));
  topicCreated = true;
  await pool.query('INSERT INTO projects(id,name,slug) VALUES($1,$2,$3)', [projectId, 'W11 adapter acceptance', run]);
  projectCreated = true;
  await pool.query('INSERT INTO services(project_id,name,environment) VALUES($1,$2,$3)', [projectId, 'w11-api', 'dev']);
  const env = { ...process.env, KAFKA_TOPIC: run, KAFKA_GROUP_ID: run, SERVER_TRACE_ENABLED: 'true',
    SERVER_TRACE_PROJECT_ID: projectId, SERVER_TRACE_SERVICE: 'w11-api', SERVER_TRACE_ENVIRONMENT: 'dev' };
  const collector = launch(path.join(root, 'apps/collector/dist/main.js'), env, path.join(root, 'apps/collector'));
  await until(async () => { assert(!collector.failed && collector.exitCode === null); return collector.output.includes('Collector subscribed to'); });
  const port = await startApi(env);
  assert.equal((await (await request(port, '/health', 'excluded-health')).json()).tracing.state, 'ready');
  await Promise.all(Array.from({ length: 6 }, (_, i) => scenario(port, i % 2 ? 'stream' : 'complete', 200)));
  await scenario(port, 'noUsage', 200);
  await scenario(port, 'rateLimit', 500);
  await scenario(port, 'timeout', 500);
  await scenario(port, 'cancel', 200);
  let stored;
  await until(async () => { stored = await rows(); return stored.length >= cases.length * 5; });
  assert.equal(stored.length, 50);
  assert(stored.every(r => r.service === 'w11-api' && r.environment === 'dev' && r.error === ''));
  assert(!JSON.stringify(stored).includes('w11-private-content-canary'));
  const stats = await (await request(port, '/spans/fixture-stats', 'excluded-stats')).json();
  assert.deepEqual(stats, { ragCalls: 10, llmCalls: 10 });
  report.providerCalls = stats;
  for (const item of cases) {
    const spans = stored.filter(row => row.trace_id === item.traceId);
    assert.equal(spans.length, 5);
    const rootSpan = spans.find(r => r.operation === 'http.server');
    const rag = spans.find(r => r.operation === 'rag.retrieve');
    const recall = spans.find(r => r.operation === 'rag.recall');
    const rerank = spans.find(r => r.operation === 'rag.rerank');
    const llm = spans.find(r => r.operation === 'llm.generate');
    assert.equal(rag.parent_span_id, rootSpan.span_id);
    assert.equal(llm.parent_span_id, rootSpan.span_id);
    assert.equal(recall.parent_span_id, rag.span_id);
    assert.equal(rerank.parent_span_id, rag.span_id);
    const ragAttrs = JSON.parse(rag.attributes), llmAttrs = JSON.parse(llm.attributes);
    assert.equal(llm.model, { complete: 'fixture-complete', stream: 'fixture-stream', noUsage: 'fixture-no-usage', rateLimit: 'fixture-rate-limit', timeout: 'fixture-timeout', cancel: 'fixture-stream' }[item.mode]);
    assert.equal(ragAttrs.topK, 3);
    assert.equal(ragAttrs['rag.recalled_count'], 3);
    assert.equal(ragAttrs['rag.empty'], false);
    assert.equal(ragAttrs.sources.length, 3);
    assert(ragAttrs.sources.every(id => /^[a-f0-9]{64}$/.test(id)));
    assert(ragAttrs['rag.recall_ms'] >= 0 && ragAttrs['rag.rerank_ms'] >= 0);
    if (item.mode === 'stream') {
      assert(llmAttrs['llm.ttft_ms'] >= 50);
      assert(llmAttrs['llm.total_latency_ms'] >= llmAttrs['llm.ttft_ms']);
      assert.equal(Number(llm.total_tokens), 30);
    } else if (item.mode === 'complete') {
      assert.equal(llmAttrs['llm.ttft_ms'], undefined);
      assert.equal(Number(llm.total_tokens), 30);
    } else if (item.mode === 'noUsage') {
      assert.equal(llmAttrs['llm.usage_available'], false);
    } else {
      assert.equal(llm.status, 'error');
      const category = { rateLimit: 'rate_limit', timeout: 'timeout', cancel: 'cancelled' }[item.mode];
      assert.equal(llmAttrs['ai.error_category'], category);
      assert.equal(llmAttrs['llm.usage_available'], false);
    }
  }
  report.spanCount = stored.length;
  report.checks.push('six concurrent complete/stream calls', 'real local protocol HTTP requests', 'five-span nested trees', 'model and usage persisted',
    'TTFT measures first content not role chunk', 'missing usage stays unavailable', 'safe rate-limit/timeout/cancellation categories', 'hashed RAG sources', 'content canary absent');
  const readPort = await startApi({ ...env, SERVER_TRACE_ENABLED: 'false' });
  const metrics = await (await request(readPort, `/overview?projectId=${projectId}&environment=dev&range=24h`, 'read-excluded')).json();
  assert.equal(metrics.metrics.requestCount, 10);
  assert.equal(metrics.metrics.errorCount, 2);
  assert.equal(metrics.metrics.totalTokens, 180);
  report.metrics = metrics.metrics;
  await scenario(readPort, 'complete', 200);
  await delay(300);
  assert.equal((await rows()).length, 50);
  report.checks.push('overview root/token counts', 'disabled tracing preserves provider calls without spans');
  const protectedValues = [process.env.PLATFORM_ADMIN_TOKEN, process.env.DATABASE_URL, process.env.CLICKHOUSE_PASSWORD, process.env.POSTGRES_PASSWORD,
    'w11-private-content-canary', 'w11-protocol-fixture-key-not-a-real-credential'].filter(s => typeof s === 'string' && s.length >= 8);
  assert(children.every(child => protectedValues.every(value => !child.output.includes(value))));
  report.checks.push('no payload or credentials in child logs');
  report.status = 'passed';
}
async function cleanup() {
  const failures = [], attempt = async (name, fn) => { try { await fn(); } catch { failures.push(name); } };
  for (const child of children.reverse()) await attempt('owned process', async () => {
    if (child.exitCode !== null || child.signalCode !== null || child.failed) return;
    child.kill('SIGTERM');
    await Promise.race([new Promise(r => child.once('exit', r)), delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([new Promise(r => child.once('exit', r)), delay(3000)]); }
    assert(child.exitCode !== null || child.signalCode !== null);
  });
  if (projectCreated) {
    await attempt('isolated ClickHouse rows', async () => {
      await ch.command({ query: 'ALTER TABLE trace_spans DELETE WHERE project_id={id:String}', query_params: { id: projectId }, clickhouse_settings: { mutations_sync: '1' } });
      assert.equal((await rows()).length, 0);
    });
    await attempt('isolated project', async () => {
      assert.equal((await pool.query('DELETE FROM projects WHERE id=$1 AND slug=$2', [projectId, run])).rowCount, 1);
      assert.equal((await pool.query('SELECT id FROM projects WHERE id=$1', [projectId])).rowCount, 0);
    });
  }
  if (connected && topicCreated) {
    await attempt('isolated group', () => until(async () => {
      if (!(await admin.listGroups()).groups.some(g => g.groupId === run)) return true;
      try { await admin.deleteGroups([run]); } catch { /* stopped member expires shortly */ }
      return false;
    }, 50000));
    await attempt('isolated topic', async () => {
      await admin.deleteTopics({ topics: [run], timeout: 10000 });
      await until(async () => !(await admin.listTopics()).includes(run));
    });
  }
  if (connected) await attempt('Kafka close', () => admin.disconnect());
  if (pool) await attempt('PostgreSQL close', () => pool.end());
  if (ch) await attempt('ClickHouse close', () => ch.close());
  report.cleanup = failures.length ? 'failed' : 'passed'; report.cleanupFailures = failures;
}
main().catch(error => {
  report.status = 'failed'; report.failure = 'Acceptance failed; sensitive diagnostics withheld';
  report.failureLocation = String(error?.stack ?? '').split('\n').find(line => line.includes('w11-chain-acceptance.cjs:'))?.trim();
}).finally(async () => {
  await cleanup();
  fs.mkdirSync(path.join(root, 'output/acceptance'), { recursive: true });
  fs.writeFileSync(path.join(root, 'output/acceptance/w11-chain-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (report.status !== 'passed' || report.cleanup !== 'passed') process.exitCode = 1;
});
