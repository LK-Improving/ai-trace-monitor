// Isolated local pipeline + real HTTP read API. Never print private diagnostics.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const root = path.resolve(__dirname, '..');
const rootRequire = createRequire(path.join(root, 'package.json'));
createRequire(rootRequire.resolve('dotenv-cli/package.json'))('dotenv').config({ path: path.join(root, '.env') });
const apiRequire = createRequire(path.join(root, 'apps/api/package.json'));
const { Pool } = apiRequire('pg');
const { Kafka, logLevel } = apiRequire('kafkajs');
const { createClient, ClickHouseLogLevel } = apiRequire('@clickhouse/client');
const run = `w15-${randomUUID()}`, ids = [randomUUID(), randomUUID(), randomUUID()], children = [], created = [];
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
  assert(!JSON.stringify(body).includes('w13-private-content-canary')); return body;
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
    await pool.query('INSERT INTO projects(id,name,slug) VALUES($1,$2,$3)', [id, 'W13 isolated acceptance', `${run}-${i}`]); created.push(id);
    await pool.query('INSERT INTO services(project_id,name,environment) VALUES($1,$2,$3)', [id, 'w13-api', 'dev']);
  }
  const env = { ...process.env, KAFKA_TOPIC: run, KAFKA_GROUP_ID: run, SERVER_TRACE_ENABLED: 'true',
    SERVER_TRACE_PROJECT_ID: ids[0], SERVER_TRACE_SERVICE: 'w13-api', SERVER_TRACE_ENVIRONMENT: 'dev' };
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
    attributes: JSON.stringify({ prompt: 'w13-private-content-canary', custom: 'w13-private-content-canary', 'ai.error_category': 'timeout' }),
    error: 'w13-private-content-canary', input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  const anomalies = `${run}-anomalies`;
  const serviceTrace = `${run}-service-filter`;
  await ch.insert({ table: 'trace_spans', format: 'JSONEachRow', values: [
    row(ids[0], 'prod', completeId, 'prod-root', '', 'ok'), row(ids[1], 'dev', completeId, 'other-root', '', 'ok'),
    row(ids[0], 'dev', anomalies, 'orphan', 'missing', 'error'), row(ids[0], 'dev', anomalies, 'cycle-a', 'cycle-b', 'ok'),
    row(ids[0], 'dev', anomalies, 'cycle-b', 'cycle-a', 'ok'),
    row(ids[0], 'dev', serviceTrace, 'service-root', '', 'ok'),
    { ...row(ids[0], 'dev', serviceTrace, 'service-child', 'service-root', 'ok'), service: 'tool-only', operation: 'tool.execute' },
  ] });
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
  const service = await request(readPort, list('service=w13-api&traceId=' + completeId)); assert.equal(service.items[0].spanCount, 5);
  const childService = await request(readPort, list('service=tool-only')); assert.equal(childService.total, 1);
  assert.equal(childService.items[0].spanCount, 2); assert.deepEqual([...childService.items[0].services].sort(), ['tool-only', 'w13-api']);
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
  await metricsChecks(readPort, ids[0], completeId, bounds);
  await benchmark(readPort);
  await overflowCheck(readPort, bounds);
  const protectedValues = [process.env.PLATFORM_ADMIN_TOKEN, process.env.DATABASE_URL, process.env.CLICKHOUSE_PASSWORD,
    'w13-private-content-canary', 'w11-protocol-fixture-key-not-a-real-credential'].filter(v => typeof v === 'string' && v.length >= 8);
  assert(children.every(c => protectedValues.every(v => !c.output.includes(v))));
  report.checks = ['real six-request 30-span pipeline', 'list/detail HTTP', 'deduplication and token counts', 'child failure sets trace error',
    'stable pagination', 'whole trace service filter', 'project/environment isolation', 'orphan/cycle tree', 'safe attribute projection',
    'admin authorization', 'content denied', 'invalid bounds and missing resource', 'existing overview with shared query budgets']; report.status = 'passed'; report.pipelineSpans = 30;
}
async function metricsChecks(port, project, completeId, bounds) {
  report.stage = 'real pipeline metrics';
  const query = `projectId=${project}&environment=dev&${bounds}`;
  const overview = await request(port, `/metrics/overview?${query}`);
  assert.equal(overview.metrics.requestCount, 7); // Six pipeline requests + service-filter fixture; rootless anomalies excluded.
  assert.equal(overview.metrics.errorCount, 3); // Includes cancelled child with successful root.
  assert.equal(overview.metrics.totalTokens, 60); // Complete and stream; duplicate delivery ignored.
  assert.deepEqual(overview.summary, overview.metrics); assert.deepEqual(overview.timeseries, overview.series);
  const ai = await request(port, `/metrics/ai?${query}`);
  report.pipelineMetrics = { requests: overview.metrics.requestCount, errors: overview.metrics.errorCount,
    totalTokens: overview.metrics.totalTokens, llmCalls: ai.llm.callCount, ttftSamples: ai.llm.ttftSampleCount,
    ragCalls: ai.rag.callCount, recallSamples: ai.rag.recallSampleCount, rerankSamples: ai.rag.rerankSampleCount };
  assert.equal(ai.llm.callCount, 6); assert.equal(ai.llm.errorCount, 3);
  assert.equal(ai.llm.totalTokens, 60); assert.equal(ai.llm.inputTokens, 40); assert.equal(ai.llm.outputTokens, 20);
  assert.equal(ai.rag.callCount, 6); assert.equal(ai.rag.successCount, 6);
  assert.equal(ai.rag.observedRecallCount, 6); assert.equal(ai.rag.emptyRecallCount, 0);
  assert(ai.llm.ttftSampleCount >= 1 && ai.llm.ttftSampleCount <= 2);
  assert.equal(ai.rag.recallSampleCount, 6); assert.equal(ai.rag.rerankSampleCount, 6);
  assert.equal((await request(port, `/metrics/overview?${query}&service=tool-only`)).metrics.requestCount, 1);
  assert.equal((await request(port, `/metrics/ai?${query}&service=tool-only`)).llm.callCount, 0);
  assert.equal((await request(port, `/metrics/overview?projectId=${ids[1]}&environment=dev&${bounds}`)).metrics.requestCount, 1);
  assert.equal((await request(port, `/metrics/ai?projectId=${project}&environment=prod&${bounds}`)).llm.callCount, 0);
  for (const endpoint of ['overview', 'ai']) {
    await request(port, `/metrics/${endpoint}?${query}`, 401, false);
    await request(port, `/metrics/${endpoint}?${query}&includeContent=true`, 400);
    await request(port, `/metrics/${endpoint}?${query}&range=7d`, 400);
    await request(port, `/metrics/${endpoint}?projectId=${randomUUID()}`, 404);
  }
  const other = (await rows(ids[1]))[0];
  const makeAi = (operation, suffix, attributes, status = 'ok', model = '') => ({ ...other,
    operation, span_id: suffix, parent_span_id: other.span_id, status, model,
    input_tokens: 2, output_tokens: 1, total_tokens: 3,
    attributes: typeof attributes === 'string' ? attributes : JSON.stringify(attributes),
  });
  await ch.insert({ table: 'trace_spans', format: 'JSONEachRow', values: [
    makeAi('rag.retrieve', 'valid-empty', { 'rag.recalled_count': 0, 'rag.recall_ms': 0, 'rag.rerank_ms': 10 }),
    makeAi('rag.retrieve', 'valid-docs', { 'rag.recalled_count': 3 }),
    makeAi('rag.retrieve', 'string-count', { 'rag.recalled_count': '0', 'rag.recall_ms': '1' }),
    makeAi('rag.retrieve', 'negative-count', { 'rag.recalled_count': -1 }),
    makeAi('rag.retrieve', 'missing-count', {}),
    makeAi('rag.retrieve', 'failed-empty', { 'rag.recalled_count': 0 }, 'error'),
    makeAi('rag.retrieve', 'malformed-attrs', '{invalid'),
    makeAi('rag.retrieve', 'fraction-count', { 'rag.recalled_count': .5 }),
    makeAi('rag.retrieve', 'huge-count', { 'rag.recalled_count': 1e308 }),
    makeAi('llm.generate', 'valid-zero-ttft', { 'llm.ttft_ms': 0 }, 'ok', 'valid-model'),
    makeAi('llm.generate', 'invalid-string-ttft', { 'llm.ttft_ms': '99' }, 'ok', 'w13-private-content-canary with spaces'),
    makeAi('llm.generate', 'oversized-attrs', { 'llm.ttft_ms': 5, prompt: 'x'.repeat(17000) }, 'ok', 'valid-model'),
  ] });
  const edge = await request(port, `/metrics/ai?projectId=${ids[1]}&environment=dev&${bounds}`);
  assert.equal(edge.rag.callCount, 9); assert.equal(edge.rag.successCount, 8);
  assert.equal(edge.rag.observedRecallCount, 2); assert.equal(edge.rag.emptyRecallCount, 1);
  assert.equal(edge.rag.emptyRecallRate, .5); assert.equal(edge.rag.recallSampleCount, 1);
  assert.equal(edge.llm.ttftSampleCount, 1); assert.equal(edge.llm.p95TtftMs, 0);
  assert.equal(edge.llm.totalTokens, 9); assert(edge.llm.models.some(m => m.model === '(unknown)'));
  report.metricChecks = ['deduplicated trace counts', 'child failure included', 'LLM-only token sums',
    'TTFT/recall/rerank sample counts', 'rootless request exclusion', 'whole-trace overview service filter',
    'span-scoped AI service filter', 'project/environment isolation', 'bounded explicit windows', 'safe protected HTTP endpoints',
    'missing/invalid/oversized JSON attributes ignored', 'invalid model redaction', 'successful observed recall denominator'];
}

async function benchmark(port) {
  report.stage = 'benchmark seeding';
  const project = ids[2], count = 10000, anchor = Date.now() - 60000;
  const iso = ms => new Date(ms).toISOString();
  const all = [], roots = [];
  for (let i = 0; i < count; i++) {
    // Fixed proportions in the last hour/day/week, not an all-in-one bucket toy dataset.
    const age = i < 5000 ? (i % 3000) * 1000 : i < 7500 ? 7200000 + (i - 5000) * 20000 : 172800000 + (i - 7500) * 150000;
    const start = anchor - age, latency = 1000 + i % 1000, trace = `bench-${i}`, rootSpan = `root-${i}`;
    roots.push({ start, latency, error: i % 10 === 0 });
    const make = (operation, spanId, parent, offset, duration, attributes = {}, status = 'ok', model = '') => ({
      event_time: iso(start + offset), project_id: project, environment: 'dev', trace_id: trace, span_id: spanId,
      parent_span_id: parent, service: 'w15-bench', operation, status, start_time: iso(start + offset),
      end_time: iso(start + offset + duration), duration_ms: duration, input_tokens: 20, output_tokens: 10,
      total_tokens: 30, model, attributes: JSON.stringify(attributes), error: '',
    });
    all.push(make('http.server', rootSpan, '', 0, latency, {}, 'ok', 'root-aggregate-copy'));
    all.push(make('rag.retrieve', `rag-${i}`, rootSpan, 0, 100,
      { 'rag.recalled_count': i % 5 === 0 ? 0 : 3, 'rag.recall_ms': 60, 'rag.rerank_ms': 40 }, i % 10 === 0 ? 'error' : 'ok'));
    all.push(make('rag.recall', `recall-${i}`, `rag-${i}`, 0, 60));
    all.push(make('rag.rerank', `rerank-${i}`, `rag-${i}`, 60, 40));
    all.push(make('llm.generate', `llm-${i}`, rootSpan, 100, latency - 100,
      { 'llm.ttft_ms': i % 2 === 0 ? 80 : 'not-a-number' }, 'ok', `bench-model-${i % 3}`));
  }
  // Identical duplicates include root, RAG and LLM; exactly 1,000 stored extra rows.
  all.push(...all.slice(0, 1000));
  for (let i = 0; i < all.length; i += 1000) await ch.insert({ table: 'trace_spans', format: 'JSONEachRow', values: all.slice(i, i + 1000) });
  assert.equal((await rows(project)).length, 51000);
  const timings = [], durations = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };
  for (const [range, duration] of Object.entries(durations)) {
    report.stage = `benchmark ${range}`;
    const q = `projectId=${project}&environment=dev&range=${range}`;
    const overview = await request(port, `/metrics/overview?${q}`);
    const from = Date.parse(overview.range.from), to = Date.parse(overview.range.to);
    const selected = roots.filter(r => r.start >= from && r.start < to);
    assert.equal(overview.metrics.requestCount, selected.length);
    assert.equal(overview.metrics.errorCount, selected.filter(r => r.error).length);
    assert.equal(overview.metrics.totalTokens, selected.length * 30);
    assert(overview.metrics.p50LatencyMs <= overview.metrics.p95LatencyMs && overview.metrics.p95LatencyMs <= overview.metrics.p99LatencyMs);
    assert.equal(overview.series.reduce((n, b) => n + b.requestCount, 0), selected.length);
    assert.equal(overview.topModels.reduce((n, m) => n + m.totalTokens, 0), selected.length * 30);
    const ai = await request(port, `/metrics/ai?${q}`);
    assert.equal(ai.llm.callCount, selected.length); assert.equal(ai.llm.totalTokens, selected.length * 30);
    assert.equal(ai.rag.callCount, selected.length); assert.equal(ai.rag.errorCount, selected.filter(r => r.error).length);
    if (range === '7d') {
      assert.equal(ai.rag.successCount, 9000); assert.equal(ai.rag.observedRecallCount, 9000);
      assert.equal(ai.rag.emptyRecallCount, 1000); assert.equal(ai.rag.emptyRecallRate, 1000 / 9000);
      assert.equal(ai.llm.ttftSampleCount, 5000); assert.equal(ai.llm.p95TtftMs, 80);
    }
    const bounds = `from=${overview.range.from}&to=${overview.range.to}`;
    const endpoints = { overview: `/metrics/overview?${q}`, ai: `/metrics/ai?${q}`,
      list: `/traces?projectId=${project}&environment=dev&${bounds}&pageSize=20` };
    for (const [endpoint, route] of Object.entries(endpoints)) {
      await request(port, route); // One additional warm-up; application has no result cache.
      const samples = [];
      for (let i = 0; i < 20; i++) {
        const started = performance.now(); await request(port, route); samples.push(performance.now() - started);
      }
      const sorted = [...samples].sort((a, b) => a - b), p95 = sorted[Math.ceil(sorted.length * .95) - 1];
      timings.push({ range, endpoint, samples: 20, concurrency: 1, p50Ms: Math.round(sorted[9]), p95Ms: Math.round(p95), maxMs: Math.round(sorted.at(-1)) });
      assert(p95 < (endpoint === 'list' ? 2000 : 3000));
    }
  }
  report.benchmark = { traces: 10000, uniqueSpans: 50000, storedSpans: 51000,
    ranges: ['1h', '24h', '7d'], method: 'HTTP wall time; nearest-rank P95; 20 samples after warm-up; sequential; no application cache',
    runtime: process.version, platform: process.platform, environment: 'local Docker Compose; synthetic dataset; not production capacity certification', timings };
}

async function overflowCheck(port, bounds) {
  report.stage = 'safe integer overflow check';
  const base = (await rows(ids[1])).find(r => r.operation === 'http.server');
  await ch.insert({ table: 'trace_spans', format: 'JSONEachRow', values: [0, 1].map(index => ({
    ...base, span_id: `overflow-${index}`, parent_span_id: base.span_id, operation: 'llm.generate',
    model: 'overflow-model', attributes: '{}', input_tokens: '9223372036854775808', output_tokens: 0,
    total_tokens: '9223372036854775808',
  })) });
  for (const endpoint of ['overview', 'ai']) {
    await request(port, `/metrics/${endpoint}?projectId=${ids[1]}&environment=dev&${bounds}`, 503);
  }
  report.metricChecks.push('UInt64 sums widen before safe integer checks; oversized totals fail safely');
  report.stage = 'completed';
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
  report.failureLocation = String(error?.stack ?? '').split('\n').find(l => l.includes('w15-metrics-acceptance.cjs:'))?.trim();
  report.failureLocations = String(error?.stack ?? '').split('\n').filter(l => l.includes('w15-metrics-acceptance.cjs:')).slice(0, 4).map(l => l.trim());
}).finally(async () => { await cleanup(); fs.mkdirSync(path.join(root, 'output/acceptance'), { recursive: true });
  fs.writeFileSync(path.join(root, 'output/acceptance/w15-metrics-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  if (report.status !== 'passed' || report.cleanup !== 'passed') process.exitCode = 1;
});


