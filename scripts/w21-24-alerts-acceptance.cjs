// Isolated local Phase 3 alert acceptance. Requires an explicit opt-in and only
// creates/removes resources carrying this run's UUID.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

// Run with `node --env-file=.env scripts/w21-24-alerts-acceptance.cjs`.
const root = path.resolve(__dirname, '..');
const apiRequire = createRequire(path.join(root, 'apps/api/package.json'));
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
const { Pool } = apiRequire('pg');
const { Kafka, logLevel } = apiRequire('kafkajs');
const { createClient, ClickHouseLogLevel } = apiRequire('@clickhouse/client');
const run = 'w21-' + randomUUID();
const service = run + '-api';
const report = { status: 'running', cleanup: 'pending', checks: [] };
const children = [];
const projects = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let pool, clickhouse, kafkaAdmin, kafkaConnected = false, topicCreated = false;
let browserLineReader;

function rememberChild(child) {
  child.output = '';
  const capture = chunk => { child.output = (child.output + chunk.toString()).slice(-32768); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', () => { child.failed = true; });
  children.push(child);
  return child;
}

function launch(entry, env, cwd, args = []) {
  return rememberChild(spawn(process.execPath, [entry, ...args], {
    cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(check, message, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(message);
}

function localHost(host) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
}

async function apiRequest(baseUrl, route, options = {}) {
  const headers = { 'x-trace-id': 'w21-test-' + randomUUID() };
  if (options.auth !== false) headers.authorization = 'Bearer ' + process.env.PLATFORM_ADMIN_TOKEN;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(baseUrl + '/api/v1' + route, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout ?? 12000),
  });
  const body = await response.json().catch(() => null);
  if (options.expected !== undefined) assert.equal(response.status, options.expected, 'Unexpected HTTP response status');
  return { status: response.status, body };
}

async function createProject(baseUrl, suffix) {
  const result = await apiRequest(baseUrl, '/projects', {
    body: { name: 'W21 isolated alert test', slug: run + '-' + suffix },
    expected: 201,
  });
  assert.equal(typeof result.body?.id, 'string');
  projects.push(result.body.id);
  return result.body.id;
}

function makeSpan({ operation, status = 'ok', durationMs = 50, totalTokens, attributes = {}, error }) {
  const startTime = Date.now();
  return {
    traceId: 'trace_v1_' + randomUUID(),
    spanId: randomUUID().replaceAll('-', ''),
    service,
    operation,
    startTime,
    endTime: startTime + durationMs,
    status,
    attributes,
    ...(totalTokens === undefined ? {} : {
      tokenUsage: {
        input: Math.floor(totalTokens / 2),
        output: totalTokens - Math.floor(totalTokens / 2),
        total: totalTokens,
      },
    }),
    ...(error === undefined ? {} : { error }),
  };
}

async function countClickHouse(projectId) {
  const result = await clickhouse.query({
    query: 'SELECT count() AS count FROM trace_spans WHERE project_id={id:String}',
    query_params: { id: projectId },
    format: 'JSONEachRow',
  });
  const rows = await result.json();
  return Number(rows[0]?.count ?? 0);
}

async function startWeb(apiPort) {
  const port = await freePort();
  const viteRuntime = webRequire.resolve('vite');
  const viteEntry = path.resolve(path.dirname(viteRuntime), '..', '..', 'bin', 'vite.js');
  assert(fs.existsSync(viteEntry), 'Vite CLI entry is unavailable');
  const web = launch(viteEntry, {
    ...process.env,
    API_PORT: String(apiPort),
    WEB_DEV_PORT: String(port),
  }, path.join(root, 'apps/web'), ['--host', '127.0.0.1', '--port', String(port), '--strictPort']);
  await until(async () => {
    assert(!web.failed && web.exitCode === null && web.signalCode === null, 'Vite exited during startup');
    try {
      return (await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }, 'Vite did not become ready');
  return { port, web };
}

async function holdForBrowser(url, session) {
  const directory = path.join(root, 'output', 'acceptance');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'w21-24-alerts-session.json'), JSON.stringify({
    run, url, projectId: session.projectId, apiPort: session.apiPort,
  }, null, 2));
  console.log(JSON.stringify({ browserReady: true, url, projectId: session.projectId }));

  await new Promise((resolve, reject) => {
    browserLineReader = readline.createInterface({ input: process.stdin });
    const timer = setTimeout(() => reject(new Error('Browser acceptance wait expired')), 15 * 60 * 1000);
    browserLineReader.on('line', line => {
      if (line.trim() !== 'finish') return;
      clearTimeout(timer);
      browserLineReader.close();
      resolve();
    });
    browserLineReader.on('close', () => {
      if (browserLineReader) {
        clearTimeout(timer);
        browserLineReader = undefined;
        resolve();
      }
    });
  });
}

async function main() {
  assert.equal(process.env.TRACE_OPS_RUN_INTEGRATION, '1', 'Set TRACE_OPS_RUN_INTEGRATION=1 to opt in');
  assert(process.env.DATABASE_URL && localHost(new URL(process.env.DATABASE_URL).hostname));
  assert(process.env.CLICKHOUSE_URL && localHost(new URL(process.env.CLICKHOUSE_URL).hostname));
  assert(process.env.PLATFORM_ADMIN_TOKEN, 'PLATFORM_ADMIN_TOKEN is required');
  assert.equal(process.env.CLICKHOUSE_TABLE ?? 'trace_spans', 'trace_spans');
  const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map(value => value.trim());
  assert(brokers.length > 0 && brokers.every(value => /^(localhost|127\.0\.0\.1):\d+$/.test(value)));

  pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  clickhouse = createClient({
    url: process.env.CLICKHOUSE_URL,
    database: process.env.CLICKHOUSE_DATABASE,
    username: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
    request_timeout: 10000,
    log: { level: ClickHouseLogLevel.OFF },
  });
  kafkaAdmin = new Kafka({
    clientId: run,
    brokers,
    logLevel: logLevel.NOTHING,
    retry: { retries: 1 },
    requestTimeout: 5000,
  }).admin();
  await kafkaAdmin.connect();
  kafkaConnected = true;
  assert(!(await kafkaAdmin.listTopics()).includes(run), 'Random Kafka topic already exists');
  assert(!(await kafkaAdmin.listGroups()).groups.some(group => group.groupId === run), 'Random Kafka group already exists');
  assert(await kafkaAdmin.createTopics({
    waitForLeaders: true,
    topics: [{ topic: run, numPartitions: 1, replicationFactor: 1 }],
  }));
  topicCreated = true;

  const apiPort = await freePort();
  const commonEnv = {
    ...process.env,
    API_PORT: String(apiPort),
    KAFKA_TOPIC: run,
    KAFKA_GROUP_ID: run,
    SERVER_TRACE_ENABLED: 'false',
  };
  const apiEntry = path.join(root, 'apps/api/dist/main.js');
  const api = launch(apiEntry, commonEnv, path.join(root, 'apps/api'));
  const apiUrl = 'http://127.0.0.1:' + apiPort;
  await until(async () => {
    assert(!api.failed && api.exitCode === null && api.signalCode === null, 'API exited during startup');
    try {
      return (await fetch(apiUrl + '/api/v1/health', { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }, 'API did not become ready');

  const projectId = await createProject(apiUrl, 'alerts');
  const otherProjectId = await createProject(apiUrl, 'other');
  await apiRequest(apiUrl, '/projects/' + projectId + '/services', {
    body: { name: service, environment: 'dev' }, expected: 201,
  });
  const key = await apiRequest(apiUrl, '/projects/' + projectId + '/keys', {
    body: { name: 'W21 isolated acceptance' }, expected: 201,
  });
  assert.equal(typeof key.body?.key, 'string');

  const collector = launch(path.join(root, 'apps/collector/dist/main.js'), commonEnv, path.join(root, 'apps/collector'));
  await until(async () => {
    assert(!collector.failed && collector.exitCode === null && collector.signalCode === null, 'Collector exited during startup');
    return collector.output.includes('Collector subscribed to ' + run);
  }, 'Collector did not subscribe to its isolated topic');

  const spans = [
    makeSpan({ operation: 'http.server', status: 'error', error: 'w21-private-content-canary' }),
    makeSpan({ operation: 'http.server', durationMs: 2001 }),
    makeSpan({ operation: 'http.server', durationMs: 2000 }),
    makeSpan({ operation: 'llm.generate', totalTokens: 5001, attributes: { model: 'test-model' } }),
    makeSpan({ operation: 'llm.generate', totalTokens: 5000, attributes: { model: 'test-model' } }),
    makeSpan({ operation: 'rag.retrieve', attributes: { 'rag.recalled_count': 0 } }),
    makeSpan({ operation: 'rag.retrieve', attributes: { 'rag.recalled_count': 3 } }),
    makeSpan({ operation: 'rag.retrieve', attributes: {} }),
  ];
  const ingest = await fetch(apiUrl + '/api/v1/spans', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trace-id': 'w21-ingest-' + randomUUID() },
    body: JSON.stringify({ projectKey: key.body.key, environment: 'dev', spans }),
    signal: AbortSignal.timeout(12000),
  });
  assert.equal(ingest.status, 202, 'Span ingest must be accepted');
  const ingestBody = await ingest.json();
  assert.equal(ingestBody.acceptedSpans, spans.length);
  assert(!JSON.stringify(ingestBody).includes('w21-private-content-canary'));
  await until(async () => (await countClickHouse(projectId)) === spans.length, 'Collector did not persist initial test spans');

  const alertsPath = '/alerts?projectId=' + projectId + '&environment=all&state=all&level=all&page=1&pageSize=100';
  const getAlerts = async () => (await apiRequest(apiUrl, alertsPath, { expected: 200 })).body;
  await until(async () => (await getAlerts()).items?.length === 4, 'Expected four distinct built-in alerts');
  const initial = await getAlerts();
  assert.equal(initial.total, 4);
  assert(initial.items.every(item => item.state === 'active'));
  assert(initial.items.every(item => item.traceId && item.spanId && item.environment === 'dev' && item.service === service));
  assert(initial.items.every(item => item.triggerCount === 1));
  assert(!JSON.stringify(initial).includes('w21-private-content-canary'));

  const duplicate = spans.find(span => span.operation === 'llm.generate' && span.tokenUsage.total === 5001);
  const duplicateResponse = await fetch(apiUrl + '/api/v1/spans', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trace-id': 'w21-replay-' + randomUUID() },
    body: JSON.stringify({ projectKey: key.body.key, environment: 'dev', spans: [duplicate] }),
    signal: AbortSignal.timeout(12000),
  });
  assert.equal(duplicateResponse.status, 202);
  await until(async () => (await countClickHouse(projectId)) === spans.length + 1, 'Collector did not receive replay fixture');
  await delay(500);
  const afterReplay = await getAlerts();
  assert.equal(afterReplay.total, 4, 'Replay must not create a duplicate incident');
  assert(afterReplay.items.every(item => item.triggerCount === 1), 'Replay must not inflate triggerCount');

  const now = new Date();
  const retryRow = {
    event_time: now.toISOString(),
    project_id: projectId,
    environment: 'dev',
    trace_id: 'trace_v1_' + randomUUID(),
    span_id: randomUUID().replaceAll('-', ''),
    parent_span_id: '',
    service,
    operation: 'w21.deduplication_probe',
    status: 'ok',
    start_time: now.toISOString(),
    end_time: new Date(now.getTime() + 1).toISOString(),
    duration_ms: 1,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    model: '',
    attributes: '{}',
    error: '',
  };
  const retryToken = 'w21-same-batch-' + randomUUID();
  const retryInsert = () => clickhouse.insert({
    table: 'trace_spans',
    values: [retryRow],
    format: 'JSONEachRow',
    clickhouse_settings: { insert_deduplication_token: retryToken },
  });
  await retryInsert();
  await retryInsert();
  assert.equal(await countClickHouse(projectId), spans.length + 2,
    'The same ClickHouse insert token must deduplicate an identical write retry');

  const summary = (await apiRequest(apiUrl, '/alerts/summary?projectId=' + projectId + '&environment=all', { expected: 200 })).body;
  assert.equal(summary.total, 4);
  assert.equal(summary.active, 4);
  assert.equal(summary.criticalActive, 1);
  const production = (await apiRequest(apiUrl,
    '/alerts?projectId=' + projectId + '&environment=prod&state=all&level=all&page=1&pageSize=100',
    { expected: 200 })).body;
  assert.equal(production.total, 0);
  const isolated = (await apiRequest(apiUrl,
    '/alerts?projectId=' + otherProjectId + '&environment=all&state=all&level=all&page=1&pageSize=100',
    { expected: 200 })).body;
  assert.equal(isolated.total, 0);
  await apiRequest(apiUrl, alertsPath, { expected: 401, auth: false });

  const alertId = initial.items[0].id;
  for (const state of ['acknowledged', 'resolved', 'active']) {
    await apiRequest(apiUrl, '/alerts/' + alertId + '/state', {
      method: 'PATCH', body: { state }, expected: 200,
    });
    const current = (await getAlerts()).items.find(item => item.id === alertId);
    assert.equal(current.state, state);
  }
  await apiRequest(apiUrl, '/alerts/' + alertId + '/state', {
    method: 'PATCH', body: { state: 'muted' }, expected: 400,
  });
  report.checks = [
    'old Postgres volume/API startup',
    'four fixed rules and exact threshold boundaries',
    'explicit empty-RAG evidence; absent metadata is not treated as empty',
    'duplicate business Span ingest at a new Kafka offset does not duplicate alerts or inflate triggerCount',
    'ClickHouse insert_deduplication_token suppresses a same-batch write retry',
    'project and environment filtering',
    'admin authentication and state validation',
    'active -> acknowledged -> resolved -> reopened lifecycle',
    'unstructured Span error content is not returned',
  ];
  report.status = 'passed';

  const web = await startWeb(apiPort);
  await holdForBrowser('http://127.0.0.1:' + web.port, { projectId, apiPort });
}

async function stopOwnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.failed) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
  }
  assert(child.exitCode !== null || child.signalCode !== null, 'Owned child process did not stop');
}

async function cleanup() {
  const failures = [];
  const attempt = async (name, operation) => {
    try { await operation(); } catch { failures.push(name); }
  };
  if (browserLineReader) {
    browserLineReader.close();
    browserLineReader = undefined;
  }
  for (const child of children.reverse()) await attempt('owned process', () => stopOwnedChild(child));
  if (clickhouse && pool) {
    for (const projectId of projects) {
      await attempt('isolated ClickHouse rows', async () => {
        await clickhouse.command({
          query: 'ALTER TABLE trace_spans DELETE WHERE project_id={id:String}',
          query_params: { id: projectId },
          clickhouse_settings: { mutations_sync: '1' },
        });
        assert.equal(await countClickHouse(projectId), 0);
      });
    }
  }
  if (pool) {
    for (const projectId of projects) {
      await attempt('isolated project rows', async () => {
        const result = await pool.query('DELETE FROM projects WHERE id=$1 AND slug LIKE $2', [projectId, run + '-%']);
        assert.equal(result.rowCount, 1);
      });
    }
  }
  if (kafkaConnected && topicCreated) {
    await attempt('isolated group', async () => {
      await until(async () => {
        if (!(await kafkaAdmin.listGroups()).groups.some(group => group.groupId === run)) return true;
        try { await kafkaAdmin.deleteGroups([run]); } catch {}
        return false;
      }, 'Kafka consumer group did not disappear', 50000);
    });
    await attempt('isolated topic', async () => {
      await kafkaAdmin.deleteTopics({ topics: [run], timeout: 10000 });
      await until(async () => !(await kafkaAdmin.listTopics()).includes(run), 'Kafka topic was not removed');
    });
  }
  if (kafkaConnected) await attempt('Kafka admin disconnect', () => kafkaAdmin.disconnect());
  if (pool) await attempt('Postgres disconnect', () => pool.end());
  if (clickhouse) await attempt('ClickHouse disconnect', () => clickhouse.close());
  report.cleanup = failures.length === 0 ? 'passed' : 'failed';
  report.cleanupFailures = failures;
}

main().catch(error => {
  report.status = 'failed';
  report.failure = 'Acceptance failed; private diagnostics withheld';
  report.failureCode = /^[A-Z_0-9]+$/.test(error?.code ?? '') ? error.code : undefined;
  report.failureLocation = String(error?.stack ?? '').split('\n')
    .find(line => line.includes('w21-24-alerts-acceptance.cjs:'))?.trim();
}).finally(async () => {
  await cleanup();
  const protectedValues = [
    process.env.PLATFORM_ADMIN_TOKEN,
    process.env.DATABASE_URL,
    process.env.CLICKHOUSE_PASSWORD,
    process.env.POSTGRES_PASSWORD,
    'w21-private-content-canary',
  ].filter(value => typeof value === 'string' && value.length >= 8);
  report.noSensitiveProcessOutput = children.every(child => protectedValues.every(value => !child.output.includes(value)));
  if (!report.noSensitiveProcessOutput) {
    report.status = 'failed';
    report.failure = 'Protected data was found in child process output';
  }
  const directory = path.join(root, 'output', 'acceptance');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'w21-24-alerts-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (report.status !== 'passed' || report.cleanup !== 'passed') process.exitCode = 1;
});
