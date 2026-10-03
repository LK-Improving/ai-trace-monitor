/*
 * Isolated W30 G3 integration fixture. It creates a temporary project, binds a
 * separately launched API process to it, then waits for an operator to drive
 * the real browser SDK with Playwright CLI. Credentials stay in this process.
 */
'use strict';

const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');

const root = path.resolve(__dirname, '..');
const rootRequire = createRequire(path.join(root, 'package.json'));
createRequire(rootRequire.resolve('dotenv-cli/package.json'))('dotenv').config({ path: path.join(root, '.env') });
const apiRequire = createRequire(path.join(root, 'apps/api/package.json'));
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
const { Pool } = apiRequire('pg');
const { createClient, ClickHouseLogLevel } = apiRequire('@clickhouse/client');
const { Kafka, logLevel } = apiRequire('kafkajs');

const runId = `w30-${randomUUID()}`;
const slug = runId;
const children = [];
const outputDir = path.join(root, 'output/playwright');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const isLoopback = (hostname) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
let apiPort;
let webPort;
let collectorHealthPort;
let projectId;
let apiChild;
let collectorChild;
let pool;
let clickhouse;
let kafkaAdmin;
let kafkaConnected = false;
let topicCreated = false;
let finishing;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function launch(label, entry, args, cwd, env) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.label = label;
  child.output = '';
  const remember = (data) => { child.output = (child.output + data.toString()).slice(-24_000); };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  child.on('error', () => { child.startFailed = true; });
  children.push(child);
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(1_000),
  ]);
  assert(child.exitCode !== null || child.signalCode !== null, `${child.label} did not stop`);
}

async function until(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (children.some((child) => child.exitCode !== null || child.signalCode !== null || child.startFailed)) {
      throw new Error(`${label}: fixture process exited`);
    }
    try {
      if (await predicate()) return;
    } catch {
      // Retry readiness only; final assertions run outside this helper.
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function adminRequest(route, body) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/v1${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    signal: AbortSignal.timeout(5_000),
    headers: {
      authorization: `Bearer ${process.env.PLATFORM_ADMIN_TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, `Admin fixture request failed with status ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}

async function queryRows() {
  const result = await clickhouse.query({
    query: `SELECT trace_id, span_id, parent_span_id, service, operation, status, attributes, error
            FROM trace_spans WHERE project_id = {id:String} AND environment = 'dev'`,
    query_params: { id: projectId },
    format: 'JSONEachRow',
  });
  return result.json();
}

async function verify() {
  let rows = [];
  await until(async () => {
    rows = await queryRows();
    const operations = new Set(rows.map((row) => row.operation));
    return [
      'browser.navigation',
      'browser.web_vital',
      'browser.javascript_error',
      'browser.unhandled_rejection',
      'browser.network_error',
      'http.server',
    ].every((operation) => operations.has(operation));
  }, 'browser + API spans persisted to ClickHouse', 60_000);

  const byOperation = (operation) => rows.filter((row) => row.operation === operation);
  const navigation = byOperation('browser.navigation')[0];
  assert(navigation, 'navigation root is missing');
  assert.equal(navigation.parent_span_id, '', 'navigation Span should be the sole trace root');
  const traceId = navigation.trace_id;
  const matching = rows.filter((row) => row.trace_id === traceId);
  assert.equal(matching.length, rows.length, 'isolated project should contain only one test Trace');

  for (const operation of [
    'browser.web_vital', 'browser.javascript_error', 'browser.unhandled_rejection', 'browser.network_error',
  ]) {
    assert(byOperation(operation).length > 0, `${operation} was not persisted`);
    assert(byOperation(operation).every((row) => row.trace_id === traceId && row.parent_span_id === navigation.span_id),
      `${operation} is not attached to the navigation Span`);
  }

  const serverRoots = byOperation('http.server').filter((row) => row.trace_id === traceId);
  assert(serverRoots.length > 0, 'no API http.server Span was persisted');
  assert(serverRoots.every((row) => row.parent_span_id === navigation.span_id),
    'API root did not retain x-parent-span-id from the browser page context');
  assert(serverRoots.every((row) => row.service === 'api-gateway'), 'API Span is bound to an unexpected service');
  assert(matching.every((row) => row.error === '' && !String(row.attributes).includes('sdk_local_fixture_not_collected')),
    'synthetic private data or raw error reached persisted Span rows');

  const detailResponse = await fetch(
    `http://127.0.0.1:${apiPort}/api/v1/traces/${encodeURIComponent(traceId)}?projectId=${projectId}&environment=dev`,
    { headers: { authorization: `Bearer ${process.env.PLATFORM_ADMIN_TOKEN}` }, signal: AbortSignal.timeout(5_000) },
  );
  assert.equal(detailResponse.status, 200, 'Trace Detail API should query the combined trace');
  const detail = await detailResponse.json();
  assert.equal(detail.rootSpan?.spanId, navigation.span_id);
  assert.equal(detail.tree.multipleRoots, false, 'combined Trace should have one navigation root');
  assert.deepEqual(detail.tree.orphanSpanIds, [], 'combined Trace should not contain orphan spans');
  assert(detail.spans.some((span) => span.operation === 'http.server'
    && span.parentSpanId === navigation.span_id), 'Trace Detail response lost the API parent relation');

  const report = {
    status: 'passed',
    traceId,
    projectId,
    spanCount: matching.length,
    browserOperations: matching.filter((row) => row.service === 'web-sdk-demo').map((row) => row.operation).sort(),
    apiParentLinks: serverRoots.length,
    clickHousePersistence: 'passed',
    traceDetailTree: 'one root, no orphans',
    privacyCanary: 'absent',
    externalStaging: 'not exercised',
  };
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'w30-g3-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

async function finish() {
  if (finishing) return finishing;
  finishing = (async () => {
    const failures = [];
    for (const child of [...children].reverse()) {
      try { await stop(child); } catch { failures.push(`${child.label} shutdown`); }
    }
    if (projectId && clickhouse) {
      try {
        await clickhouse.command({
          query: 'ALTER TABLE trace_spans DELETE WHERE project_id = {id:String}',
          query_params: { id: projectId },
          clickhouse_settings: { mutations_sync: '1' },
        });
        assert.equal((await queryRows()).length, 0, 'isolated ClickHouse rows remain after cleanup');
      } catch { failures.push('isolated ClickHouse rows'); }
      try {
        const deleted = await pool.query('DELETE FROM projects WHERE id=$1 AND slug=$2', [projectId, slug]);
        assert.equal(deleted.rowCount, 1, 'isolated PostgreSQL project was not deleted');
        const found = await pool.query('SELECT id FROM projects WHERE id=$1', [projectId]);
        assert.equal(found.rowCount, 0, 'isolated PostgreSQL project remains after cleanup');
      } catch { failures.push('isolated PostgreSQL project'); }
    }
    if (kafkaConnected && topicCreated) {
      try {
        for (let attempt = 0; attempt < 90; attempt += 1) {
          const groups = (await kafkaAdmin.listGroups()).groups;
          if (!groups.some((group) => group.groupId === runId)) break;
          try { await kafkaAdmin.deleteGroups([runId]); } catch { /* retry until the consumer group releases */ }
          if (attempt === 89) throw new Error('Consumer group remains');
          await delay(500);
        }
      } catch { failures.push('isolated Kafka consumer group'); }
      try {
        await kafkaAdmin.deleteTopics({ topics: [runId], timeout: 10_000 });
        for (let attempt = 0; attempt < 30; attempt += 1) {
          if (!(await kafkaAdmin.listTopics()).includes(runId)) break;
          if (attempt === 29) throw new Error('Topic remains');
          await delay(300);
        }
      } catch { failures.push('isolated Kafka topic'); }
    }
    if (kafkaConnected) {
      try { await kafkaAdmin.disconnect(); } catch { failures.push('Kafka admin connection'); }
    }
    try { await pool?.end(); } catch { failures.push('PostgreSQL connection'); }
    try { await clickhouse?.close(); } catch { failures.push('ClickHouse connection'); }
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'w30-g3-cleanup-result.json'), JSON.stringify({
      status: failures.length ? 'failed' : 'passed',
      failures,
    }, null, 2));
    console.log(JSON.stringify({ cleanup: failures.length ? 'failed' : 'passed', failures }));
    if (failures.length) process.exitCode = 1;
  })();
  return finishing;
}

async function main() {
  assert.equal(process.env.TRACE_OPS_RUN_INTEGRATION, '1', 'Explicit local integration opt-in required');
  assert(process.env.PLATFORM_ADMIN_TOKEN, 'PLATFORM_ADMIN_TOKEN must be configured only in the local server environment');
  assert(process.env.DATABASE_URL && isLoopback(new URL(process.env.DATABASE_URL).hostname), 'DATABASE_URL must use loopback');
  assert(process.env.CLICKHOUSE_URL && isLoopback(new URL(process.env.CLICKHOUSE_URL).hostname), 'CLICKHOUSE_URL must use loopback');
  assert.equal(process.env.CLICKHOUSE_TABLE ?? 'trace_spans', 'trace_spans');
  const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map((broker) => broker.trim());
  assert(brokers.length > 0 && brokers.every((broker) => /^(localhost|127\.0\.0\.1):\d+$/.test(broker)),
    'KAFKA_BROKERS must contain loopback brokers only');

  apiPort = await freePort();
  webPort = await freePort();
  collectorHealthPort = await freePort();
  pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
  clickhouse = createClient({
    url: process.env.CLICKHOUSE_URL,
    username: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
    database: process.env.CLICKHOUSE_DATABASE,
    request_timeout: 5_000,
    log: { level: ClickHouseLogLevel.OFF },
  });

  kafkaAdmin = new Kafka({
    clientId: `${runId}-admin`,
    brokers,
    logLevel: logLevel.NOTHING,
    retry: { retries: 1 },
    requestTimeout: 5_000,
  }).admin();
  await kafkaAdmin.connect();
  kafkaConnected = true;
  assert(!(await kafkaAdmin.listTopics()).includes(runId), 'isolated Kafka topic already exists');
  assert(await kafkaAdmin.createTopics({
    waitForLeaders: true,
    topics: [{ topic: runId, numPartitions: 1, replicationFactor: 1 }],
  }), 'isolated Kafka topic was not created');
  topicCreated = true;

  const collectorEntry = path.join(root, 'apps/collector/dist/main.js');
  collectorChild = launch('isolated Collector', collectorEntry, [], path.join(root, 'apps/collector'), {
    ...process.env,
    KAFKA_TOPIC: runId,
    KAFKA_GROUP_ID: runId,
    COLLECTOR_OPS_HEALTH_PORT: String(collectorHealthPort),
  });
  await until(() => collectorChild.output.includes('Collector subscribed to'), 'isolated Collector subscription', 60_000);
  await until(async () => {
    const response = await fetch(`http://127.0.0.1:${collectorHealthPort}/internal/ops/health`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const health = await response.json();
    return health.status === 'running' && health.topic === runId;
  }, 'isolated Collector health endpoint');

  const apiEntry = path.join(root, 'apps/api/dist/main.js');
  const apiCwd = path.join(root, 'apps/api');
  const initialApiEnv = {
    ...process.env,
    API_PORT: String(apiPort),
    KAFKA_TOPIC: runId,
    SERVER_TRACE_ENABLED: 'false',
  };
  apiChild = launch('API setup process', apiEntry, [], apiCwd, initialApiEnv);
  await until(async () => {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/v1/health`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  }, 'isolated setup API health');

  const project = await adminRequest('/projects', { name: `W30 G3 ${runId}`, slug });
  projectId = project.id;
  await adminRequest(`/projects/${projectId}/services`, { name: 'api-gateway', environment: 'dev' });
  await adminRequest(`/projects/${projectId}/services`, { name: 'web-sdk-demo', environment: 'dev' });
  const key = await adminRequest(`/projects/${projectId}/keys`, { name: 'W30 isolated browser relay' });

  await stop(apiChild);
  children.splice(children.indexOf(apiChild), 1);
  apiChild = launch('API Trace process', apiEntry, [], apiCwd, {
    ...process.env,
    API_PORT: String(apiPort),
    KAFKA_TOPIC: runId,
    SERVER_TRACE_ENABLED: 'true',
    SERVER_TRACE_PROJECT_ID: projectId,
    SERVER_TRACE_SERVICE: 'api-gateway',
    SERVER_TRACE_ENVIRONMENT: 'dev',
  });
  await until(async () => {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/v1/health`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const health = await response.json();
    return health.tracing?.state === 'ready';
  }, 'isolated API Trace binding', 30_000);

  const viteEntry = path.join(path.dirname(webRequire.resolve('vite/package.json')), 'bin/vite.js');
  launch('Vite SDK fixture', viteEntry, ['--host', '127.0.0.1', '--strictPort'], path.join(root, 'apps/web'), {
    ...process.env,
    API_PORT: String(apiPort),
    WEB_DEV_PORT: String(webPort),
    SDK_TEST_PROJECT_KEY: key.key,
  });
  await until(async () => (await fetch(`http://127.0.0.1:${webPort}/sdk-test.html`)).ok, 'SDK acceptance page');

  const session = {
    webUrl: `http://127.0.0.1:${webPort}/sdk-test.html`,
    apiPort,
    projectId,
    environment: 'dev',
    collectorTopic: runId,
  };
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'w30-g3-session.json'), JSON.stringify(session, null, 2));
  console.log(JSON.stringify({ ready: true, ...session, projectKey: 'withheld' }));

  const input = readline.createInterface({ input: process.stdin });
  let pending = Promise.resolve();
  input.on('line', (line) => {
    pending = pending.then(async () => {
      if (line.trim() === 'verify') {
        try { await verify(); } catch {
          console.error('G3 verification failed; credentials withheld');
          process.exitCode = 1;
        }
      }
      if (line.trim() === 'finish') {
        input.close();
        await finish();
      }
    }).catch(async () => {
      process.exitCode = 1;
      await finish();
    });
  });
  input.on('close', () => { void pending.then(finish); });
  const limit = setTimeout(() => { input.close(); void finish(); }, 10 * 60_000);
  limit.unref();
}

main().catch(async () => {
  console.error('G3 fixture startup failed; credentials withheld');
  process.exitCode = 1;
  await finish();
});
