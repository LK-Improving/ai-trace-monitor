// Isolated local notification acceptance. Requires explicit opt-in and only
// creates/removes resources carrying this run's unique project slug/recipient.
// Run with `node --env-file=.env scripts/w24-27-notifications-acceptance.cjs`.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const apiRequire = createRequire(path.join(root, 'apps/api/package.json'));
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
const { Pool } = apiRequire('pg');
const { AlertEngine } = require(path.join(root, 'apps/collector/dist/alert-engine.js'));
const run = 'w24-' + randomUUID();
const projectSlug = run + '-notifications';
const recipient = run + '@example.test';
const webhookCanary = run + '-private-span-error';
const report = { status: 'running', cleanup: 'pending', checks: [] };
const children = [];
const projects = [];
const ownedEmailMessageIds = new Set();
const protectedValues = [process.env.PLATFORM_ADMIN_TOKEN, process.env.DATABASE_URL, webhookCanary]
  .filter(value => typeof value === 'string' && value.length >= 8);
let pool;
let api;
let apiPort;
let apiEnv;
let receiver;
let receiverServer;
let browserLineReader;
let enginePool;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    report.waitingFor = message;
    if (await check()) {
      delete report.waitingFor;
      return;
    }
    await delay(150);
  }
  throw new Error(message);
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout ?? 10000),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function apiRequest(route, options = {}) {
  const headers = { 'x-trace-id': run + '-' + randomUUID() };
  if (options.auth !== false) headers.authorization = 'Bearer ' + process.env.PLATFORM_ADMIN_TOKEN;
  return jsonRequest(`http://127.0.0.1:${apiPort}/api/v1${route}`, { ...options, headers });
}

async function startApi() {
  api = launch(path.join(root, 'apps/api/dist/main.js'), apiEnv, path.join(root, 'apps/api'));
  const healthUrl = `http://127.0.0.1:${apiPort}/api/v1/health`;
  await until(async () => {
    assert(!api.failed && api.exitCode === null && api.signalCode === null, 'API exited during startup');
    try { return (await fetch(healthUrl, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  }, 'API did not become ready', 60000);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || child.failed) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(8000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
  }
  assert(child.exitCode !== null || child.signalCode !== null, 'Owned process did not stop');
}

function startReceiver() {
  const state = { mode: new Map(), received: [] };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      state.received.push({ path: request.url, body, idempotencyKey: request.headers['idempotency-key'] });
      const mode = state.mode.get(request.url) ?? 'success';
      response.statusCode = mode === 'failure' ? 503 : 204;
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      state.baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve({ state, server });
    });
  });
}

async function waitForDelivery(projectId, id, status) {
  await until(async () => {
    const response = await apiRequest(`/alerts/deliveries?projectId=${projectId}&pageSize=100`);
    assert.equal(response.status, 200, 'Delivery list request failed');
    const row = response.body.items.find(item => item.id === id);
    if (row) report.lastObservedDelivery = {
      status: row.status, attemptCount: row.attemptCount, lastErrorCode: row.lastErrorCode,
    };
    return row?.status === status;
  }, `Delivery did not reach ${status}`, 30000);
  const response = await apiRequest(`/alerts/deliveries?projectId=${projectId}&pageSize=100`);
  return response.body.items.find(item => item.id === id);
}

async function findDelivery(projectId, predicate, previousIds = new Set()) {
  let row;
  await until(async () => {
    const response = await apiRequest(`/alerts/deliveries?projectId=${projectId}&pageSize=100`);
    assert.equal(response.status, 200, 'Delivery list request failed');
    row = response.body.items.find(item => !previousIds.has(item.id) && predicate(item));
    return Boolean(row);
  }, 'Expected delivery was not persisted');
  return row;
}

async function mailpitMessages() {
  const response = await jsonRequest('http://127.0.0.1:8025/api/v1/messages?start=0&limit=500');
  assert.equal(response.status, 200, 'Mailpit API is unavailable');
  assert(Array.isArray(response.body.messages), 'Mailpit message list has an unexpected shape');
  return response.body.messages;
}

async function removeOwnedMailpitMessages() {
  const response = await fetch('http://127.0.0.1:8025/api/v1/messages?start=0&limit=500', {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Mailpit API is unavailable during cleanup');
  const summary = await response.json();
  const ownedMessages = (summary.messages ?? []).filter(item =>
    (item.To ?? []).some(address => (typeof address === 'string' ? address : address.Address)?.toLowerCase() === recipient.toLowerCase())
      && ownedEmailMessageIds.has(normalizeMessageId(item.MessageID)));
  if (ownedMessages.length === 0) return;
  const deletion = await fetch('http://127.0.0.1:8025/api/v1/messages', {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ IDs: ownedMessages.map(item => item.ID) }),
    signal: AbortSignal.timeout(5000),
  });
  if (!deletion.ok) throw new Error('Could not remove this run\'s Mailpit messages');
  const verifyResponse = await fetch('http://127.0.0.1:8025/api/v1/messages?start=0&limit=500', {
    signal: AbortSignal.timeout(5000),
  });
  if (!verifyResponse.ok) throw new Error('Could not verify Mailpit cleanup');
  const remaining = await verifyResponse.json();
  assert(!(remaining.messages ?? []).some(item => ownedMessages.some(owned => owned.ID === item.ID)));
}

function normalizeMessageId(value) {
  return typeof value === 'string' ? value.replace(/^</, '').replace(/>$/, '') : '';
}

async function waitForMailpitMessage(deliveryId) {
  const messageId = `${deliveryId}@trace-ops.local`;
  ownedEmailMessageIds.add(messageId);
  let message;
  await until(async () => {
    const messages = await mailpitMessages();
    message = messages.find(item => normalizeMessageId(item.MessageID) === messageId
      && (item.To ?? []).some(address =>
        (typeof address === 'string' ? address : address.Address)?.toLowerCase() === recipient.toLowerCase()));
    return Boolean(message);
  }, 'SMTP delivery was not captured by Mailpit');
  return message;
}

async function createProject(name, slug) {
  const response = await apiRequest('/projects', { method: 'POST', body: { name, slug } });
  assert.equal(response.status, 201, 'Isolated project creation failed');
  assert.equal(typeof response.body?.id, 'string');
  projects.push(response.body.id);
  return response.body.id;
}

async function createChannel(projectId, { name, type, webhookUrl, recipient: email }) {
  const response = await apiRequest('/alerts/channels', {
    method: 'POST',
    body: {
      projectId, name, type, environment: 'all', minLevel: 'warning', enabled: true,
      ...(type === 'webhook' ? { webhookUrl } : { recipient: email }),
    },
  });
  assert.equal(response.status, 201, `Channel creation failed (${type})`);
  assert.equal(response.body.hasSecret, true);
  assert(!('targetCiphertext' in response.body) && !('webhookUrl' in response.body) && !('recipient' in response.body));
  return response.body;
}

async function enqueueTest(projectId, channelId) {
  const response = await apiRequest(`/alerts/channels/${channelId}/test`, {
    method: 'POST', body: { projectId },
  });
  assert.equal(response.status, 201, 'Test delivery was not queued');
}

async function startWeb(apiPortValue) {
  const webPort = await freePort();
  const viteRuntime = webRequire.resolve('vite');
  const viteEntry = path.resolve(path.dirname(viteRuntime), '..', '..', 'bin', 'vite.js');
  assert(fs.existsSync(viteEntry), 'Vite CLI entry is unavailable');
  const child = launch(viteEntry, { ...apiEnv, WEB_DEV_PORT: String(webPort) },
    path.join(root, 'apps/web'), ['--host', '127.0.0.1', '--port', String(webPort), '--strictPort']);
  await until(async () => {
    assert(!child.failed && child.exitCode === null && child.signalCode === null, 'Vite exited during startup');
    try { return (await fetch(`http://127.0.0.1:${webPort}/`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  }, 'Vite did not become ready');
  return { child, port: webPort };
}

async function holdForBrowser(url, projectId, retryDeliveryId) {
  const sessionPath = path.join(root, 'output', 'acceptance', 'w24-27-notifications-session.json');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify({ run, url, projectId, retryDeliveryId }, null, 2));
  console.log(JSON.stringify({ browserReady: true, url, projectId }));
  await new Promise((resolve, reject) => {
    const reader = readline.createInterface({ input: process.stdin });
    browserLineReader = reader;
    let timer;
    const finish = error => {
      if (!browserLineReader) return;
      browserLineReader = undefined;
      clearTimeout(timer);
      reader.close();
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(() => finish(new Error('Browser acceptance wait expired')), 15 * 60 * 1000);
    reader.on('line', line => {
      if (line.trim() !== 'finish') return;
      finish();
    });
    reader.on('close', () => finish(new Error('Browser acceptance input closed before finish')));
  });
}

async function main() {
  assert.equal(process.env.TRACE_OPS_RUN_NOTIFICATIONS_INTEGRATION, '1',
    'Set TRACE_OPS_RUN_NOTIFICATIONS_INTEGRATION=1 to opt in');
  assert(process.env.DATABASE_URL && ['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname),
    'Acceptance is restricted to local PostgreSQL');
  assert(process.env.PLATFORM_ADMIN_TOKEN, 'PLATFORM_ADMIN_TOKEN is required');
  assert(await fetch('http://127.0.0.1:8025/api/v1/info').then(response => response.ok).catch(() => false),
    'Local Mailpit is not available at 127.0.0.1:8025');

  apiPort = await freePort();
  const key = randomBytes(32).toString('base64');
  apiEnv = {
    ...process.env,
    NODE_ENV: 'test',
    API_PORT: String(apiPort),
    ALERT_NOTIFICATION_ENCRYPTION_KEY: key,
    ALERT_NOTIFICATIONS_ALLOW_PRIVATE_TARGETS: 'true',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
    SMTP_SECURE: 'false',
    SMTP_FROM: 'Trace Ops Acceptance <no-reply@trace-ops.local>',
    SMTP_USER: '',
    SMTP_PASSWORD: '',
    SERVER_TRACE_ENABLED: 'false',
  };
  pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  const receiverStarted = await startReceiver();
  receiver = receiverStarted.state;
  receiverServer = receiverStarted.server;
  await startApi();

  const projectId = await createProject('W24 isolated notifications acceptance', projectSlug);
  const otherProjectId = await createProject('W24 isolated notifications scope probe', run + '-other');
  const hookUrl = receiver.baseUrl + '/success';
  const failUrl = receiver.baseUrl + '/fail';
  const webhook = await createChannel(projectId, { name: 'Acceptance webhook', type: 'webhook', webhookUrl: hookUrl });
  const email = await createChannel(projectId, { name: 'Acceptance email', type: 'email', recipient });
  const failing = await createChannel(projectId, { name: 'Acceptance retry', type: 'webhook', webhookUrl: failUrl });

  const stored = await pool.query(
    `SELECT id, target_ciphertext, destination_hint FROM alert_notification_channels
     WHERE project_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`,
    [projectId, [webhook.id, email.id, failing.id]],
  );
  assert.equal(stored.rowCount, 3);
  assert(stored.rows.every(row => !row.target_ciphertext.includes(hookUrl)
    && !row.target_ciphertext.includes(recipient)));
  assert(stored.rows.every(row => !row.destination_hint.includes(recipient.split('@')[0])));
  const listedChannels = await apiRequest(`/alerts/channels?projectId=${projectId}`);
  assert.equal(listedChannels.status, 200);
  assert(!JSON.stringify(listedChannels.body).includes(hookUrl));
  assert(!JSON.stringify(listedChannels.body).includes(recipient));
  const otherChannels = await apiRequest(`/alerts/channels?projectId=${otherProjectId}`);
  assert.equal(otherChannels.status, 200);
  assert.equal(otherChannels.body.items.length, 0);

  const unauthorized = await apiRequest(`/alerts/channels?projectId=${projectId}`, { auth: false });
  assert.equal(unauthorized.status, 401);
  report.checks.push('authenticated, project-scoped channel API and encrypted/masked targets');

  const firstPage = await apiRequest(`/alerts/deliveries?projectId=${projectId}&pageSize=100`);
  const previousIds = new Set(firstPage.body.items.map(item => item.id));
  await enqueueTest(projectId, webhook.id);
  await enqueueTest(projectId, email.id);
  const webhookTest = await findDelivery(projectId,
    item => item.channelId === webhook.id && item.eventType === 'test', previousIds);
  const emailTest = await findDelivery(projectId,
    item => item.channelId === email.id && item.eventType === 'test', new Set([...previousIds, webhookTest.id]));
  await waitForDelivery(projectId, webhookTest.id, 'sent');
  await waitForDelivery(projectId, emailTest.id, 'sent');
  assert(receiver.received.some(item => item.path === '/success' && item.idempotencyKey === webhookTest.id));
  const testMail = await waitForMailpitMessage(emailTest.id);
  const fullMail = await jsonRequest(`http://127.0.0.1:8025/api/v1/message/${encodeURIComponent(testMail.ID)}`);
  assert.equal(fullMail.status, 200);
  assert((fullMail.body.Text ?? '').includes(emailTest.id));
  report.checks.push('asynchronous webhook and real SMTP-to-Mailpit test delivery');

  receiver.mode.set('/fail', 'failure');
  const beforeFail = await apiRequest(`/alerts/deliveries?projectId=${projectId}&pageSize=100`);
  const beforeFailIds = new Set(beforeFail.body.items.map(item => item.id));
  await enqueueTest(projectId, failing.id);
  const failedCandidate = await findDelivery(projectId,
    item => item.channelId === failing.id && item.eventType === 'test', beforeFailIds);
  await pool.query(
    `UPDATE alert_notification_deliveries
     SET max_attempts = 1,
         next_attempt_at = CASE WHEN status IN ('queued', 'retrying') THEN now() ELSE next_attempt_at END
     WHERE id = $1 AND project_id = $2`,
    [failedCandidate.id, projectId],
  );
  await waitForDelivery(projectId, failedCandidate.id, 'failed');
  const retryResponse = await apiRequest(`/alerts/deliveries/${failedCandidate.id}/retry`, {
    method: 'POST', body: { projectId },
  });
  assert.equal(retryResponse.status, 201);
  receiver.mode.set('/fail', 'success');
  await waitForDelivery(projectId, failedCandidate.id, 'sent');
  const crossProjectRetry = await apiRequest(`/alerts/deliveries/${failedCandidate.id}/retry`, {
    method: 'POST', body: { projectId: otherProjectId },
  });
  assert.equal(crossProjectRetry.status, 404);

  receiver.mode.set('/delete-retry', 'failure');
  const deletedRetryChannel = await createChannel(projectId, {
    name: 'Acceptance deleted retry', type: 'webhook', webhookUrl: receiver.baseUrl + '/delete-retry',
  });
  const beforeDeletedRetry = await apiRequest(`/alerts/deliveries?projectId=${projectId}&pageSize=100`);
  const beforeDeletedRetryIds = new Set(beforeDeletedRetry.body.items.map(item => item.id));
  await enqueueTest(projectId, deletedRetryChannel.id);
  const deletedCandidate = await findDelivery(projectId,
    item => item.channelId === deletedRetryChannel.id && item.eventType === 'test', beforeDeletedRetryIds);
  await pool.query(
    `UPDATE alert_notification_deliveries SET max_attempts = 1,
       next_attempt_at = CASE WHEN status IN ('queued', 'retrying') THEN now() ELSE next_attempt_at END
     WHERE id = $1 AND project_id = $2`,
    [deletedCandidate.id, projectId],
  );
  await waitForDelivery(projectId, deletedCandidate.id, 'failed');
  const deleteChannel = await apiRequest(`/alerts/channels/${deletedRetryChannel.id}?projectId=${projectId}`, {
    method: 'DELETE',
  });
  assert.equal(deleteChannel.status, 200);
  const retryDeleted = await apiRequest(`/alerts/deliveries/${deletedCandidate.id}/retry`, {
    method: 'POST', body: { projectId },
  });
  assert.equal(retryDeleted.status, 409);
  report.checks.push('bounded retry, project isolation, and deleted-channel retry rejection');

  enginePool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  const engine = new AlertEngine(enginePool);
  await engine.initialize();
  const now = Date.now();
  const span = {
    traceId: 'trace_v1_' + randomUUID(),
    spanId: randomUUID().replaceAll('-', ''),
    service: run + '-api',
    operation: 'http.server',
    startTime: now,
    endTime: now + 8,
    status: 'error',
    error: webhookCanary,
    attributes: {},
    projectId,
    environment: 'dev',
    schemaVersion: 1,
  };
  const alertQueued = await engine.processSpans([span]);
  assert.equal(alertQueued, 1);
  const incident = await pool.query(
    'SELECT id FROM alert_incidents WHERE project_id = $1 AND trace_id = $2 AND rule = $3',
    [projectId, span.traceId, 'span_error'],
  );
  assert.equal(incident.rowCount, 1);
  const outbox = await pool.query(
    `SELECT id, channel_type, safe_payload, status FROM alert_notification_deliveries
     WHERE project_id = $1 AND alert_id = $2 ORDER BY channel_name`,
    [projectId, incident.rows[0].id],
  );
  assert.equal(outbox.rowCount, 3, 'One notification per matching enabled channel');
  assert(!JSON.stringify(outbox.rows).includes(webhookCanary));
  const duplicate = await engine.processSpans([span]);
  assert.equal(duplicate, 0);
  const duplicateCount = await pool.query(
    'SELECT count(*)::int AS count FROM alert_notification_deliveries WHERE alert_id = $1',
    [incident.rows[0].id],
  );
  assert.equal(duplicateCount.rows[0].count, 3);
  for (const row of outbox.rows) {
    await waitForDelivery(projectId, row.id, 'sent');
    if (row.channel_type === 'email') await waitForMailpitMessage(row.id);
  }
  assert(receiver.received.some(item => item.body?.traceId === span.traceId));
  assert(receiver.received.every(item => !JSON.stringify(item.body).includes(webhookCanary)));
  await engine.close();
  enginePool = undefined;
  report.checks.push('incident/outbox transaction, sanitized payload, and duplicate Span idempotency');

  const leaseEmail = await createChannel(projectId, {
    name: 'Acceptance restart recovery', type: 'email', recipient,
  });
  await stopChild(api);
  const recoveredId = randomUUID();
  await pool.query(
    `INSERT INTO alert_notification_deliveries (
       id, project_id, channel_id, channel_name, channel_type, event_type, safe_payload,
       status, attempts_in_cycle, next_attempt_at
     ) VALUES ($1, $2, $3, $4, 'email', 'test', $5::jsonb, 'queued', 0, now())`,
    [recoveredId, projectId, leaseEmail.id, 'Acceptance restart recovery',
      JSON.stringify({ title: 'Trace Ops restart recovery', service: run, traceId: null })],
  );
  await startApi();
  await waitForDelivery(projectId, recoveredId, 'sent');
  await waitForMailpitMessage(recoveredId);
  report.checks.push('durable queued delivery recovered and sent after API process restart');

  receiver.mode.set('/ui-retry', 'failure');
  const uiRetryChannel = await createChannel(projectId, {
    name: 'Acceptance UI retry', type: 'webhook', webhookUrl: receiver.baseUrl + '/ui-retry',
  });
  const beforeUiRetry = await apiRequest(`/alerts/deliveries?projectId=${projectId}&pageSize=100`);
  const beforeUiRetryIds = new Set(beforeUiRetry.body.items.map(item => item.id));
  await enqueueTest(projectId, uiRetryChannel.id);
  const uiRetryDelivery = await findDelivery(projectId,
    item => item.channelId === uiRetryChannel.id && item.eventType === 'test', beforeUiRetryIds);
  await pool.query(
    `UPDATE alert_notification_deliveries SET max_attempts = 1,
       next_attempt_at = CASE WHEN status IN ('queued', 'retrying') THEN now() ELSE next_attempt_at END
     WHERE id = $1 AND project_id = $2`,
    [uiRetryDelivery.id, projectId],
  );
  await waitForDelivery(projectId, uiRetryDelivery.id, 'failed');
  receiver.mode.set('/ui-retry', 'success');
  report.checks.push('failed UI retry fixture prepared');

  const web = await startWeb(apiPort);
  report.status = 'passed';
  await holdForBrowser(`http://127.0.0.1:${web.port}`, projectId, uiRetryDelivery.id);
}

async function cleanup() {
  const failures = [];
  const attempt = async (name, operation) => { try { await operation(); } catch { failures.push(name); } };
  if (browserLineReader) {
    browserLineReader.close();
    browserLineReader = undefined;
  }
  if (receiverServer) await attempt('owned webhook receiver', () => new Promise(resolve => receiverServer.close(resolve)));
  for (const child of children.reverse()) await attempt('owned process', () => stopChild(child));
  if (await fetch('http://127.0.0.1:8025/api/v1/info').then(response => response.ok).catch(() => false)) {
    await attempt('owned Mailpit messages', removeOwnedMailpitMessages);
    if (report.status === 'passed' && !failures.includes('owned Mailpit messages')) {
      report.checks.push('precise cleanup of uniquely addressed acceptance emails');
    }
  }
  if (enginePool) await attempt('AlertEngine Postgres disconnect', () => enginePool.end());
  if (pool) {
    for (const projectId of projects) {
      await attempt('isolated project rows', async () => {
        const result = await pool.query('DELETE FROM projects WHERE id = $1 AND slug LIKE $2', [projectId, run + '-%']);
        assert.equal(result.rowCount, 1);
      });
    }
    await attempt('Postgres disconnect', () => pool.end());
  }
  report.cleanup = failures.length === 0 ? 'passed' : 'failed';
  report.cleanupFailures = failures;
}

main().catch(error => {
  report.status = 'failed';
  report.failure = 'Acceptance failed; private diagnostics withheld';
  report.failureCheck = report.waitingFor;
  report.failureCode = /^[A-Z_0-9]+$/.test(error?.code ?? '') ? error.code : undefined;
  report.failureLocation = String(error?.stack ?? '').split('\n')
    .find(line => line.includes('w24-27-notifications-acceptance.cjs:'))?.trim();
}).finally(async () => {
  await cleanup();
  report.noSensitiveProcessOutput = children.every(child => protectedValues.every(value => !child.output.includes(value)));
  report.workerDiagnostics = [...new Set(children.flatMap(child =>
    child.output.match(/Notification (?:claim|delivery|completion) failed: [A-Z0-9_]+/g) ?? []))];
  if (!report.noSensitiveProcessOutput) {
    report.status = 'failed';
    report.failure = 'Protected data was found in child process output';
  }
  const reportPath = path.join(root, 'output', 'acceptance', 'w24-27-notifications-result.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (report.status !== 'passed' || report.cleanup !== 'passed') process.exitCode = 1;
});
