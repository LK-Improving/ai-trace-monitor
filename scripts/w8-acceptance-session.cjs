/* Opt-in local integration fixture. No credential is written to browser-visible artifacts. */
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const rootRequire = createRequire(path.join(root, 'package.json'));
createRequire(rootRequire.resolve('dotenv-cli/package.json'))('dotenv').config({ path: path.join(root, '.env') });
const apiRequire = createRequire(path.join(root, 'apps/api/package.json'));
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
const { Pool } = apiRequire('pg');
const { Kafka, logLevel } = apiRequire('kafkajs');
const { createClient, ClickHouseLogLevel } = apiRequire('@clickhouse/client');
const local = hostname => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
const run = `w8-${randomUUID()}`;
const children = [];
let projectId, topicCreated = false, connected = false, stopping;
let admin, pool, ch, apiPort;
const outputDir = path.join(root, 'output/playwright');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function freePort(port = 0) {
  const server = net.createServer();
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok); });
  const found = server.address().port;
  await new Promise(r => server.close(r));
  return found;
}
async function until(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (children.some(c => c.exitCode !== null || c.signalCode !== null || c.startFailed)) throw new Error('Fixture process stopped');
    try { if (await predicate()) return; } catch { /* retry readiness only */ }
    await delay(300);
  }
  throw new Error(`Timed out: ${label}`);
}
function launch(entry, args, cwd, env) {
  const child = spawn(process.execPath, [entry, ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  const remember = data => { child.output = (child.output + data.toString()).slice(-32768); };
  child.stdout.on('data', remember); child.stderr.on('data', remember);
  child.on('error', () => { child.startFailed = true; });
  children.push(child); return child;
}
async function request(route, body) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/v1${route}`, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.PLATFORM_ADMIN_TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert(response.ok, `Fixture API status ${response.status}`); return response.json();
}
async function verify() {
  let rows;
  await until(async () => {
    const result = await ch.query({ query: 'SELECT trace_id, span_id, service, operation, status, attributes, error FROM trace_spans WHERE project_id={id:String}', query_params: { id: projectId }, format: 'JSONEachRow' });
    rows = await result.json();
    return ['browser.javascript_error', 'browser.unhandled_rejection', 'browser.network_error', 'browser.web_vital'].every(op => rows.some(r => r.operation === op));
  }, 'browser SDK rows');
  assert(rows.every(r => r.error === '' && !r.attributes.includes('sdk_local_fixture_not_collected')));
  assert(rows.every(r => r.service === 'web-sdk-demo' && /^trace_web_/.test(r.trace_id)));
  const overview = await request(`/overview?projectId=${projectId}&environment=dev&range=24h`);
  assert.equal(overview.metrics.totalTokens, 0);
  assert.equal(overview.metrics.requestCount, rows.filter(r => r.operation === 'browser.network_error').length);
  assert.equal(overview.metrics.errorCount, overview.metrics.requestCount);
  assert(overview.recentErrors.length >= 3);
  assert(overview.services.some(s => s.name === 'web-sdk-demo' && s.requestCount >= 4));
  assert.equal((await request(`/overview?projectId=${projectId}&environment=prod&range=24h`)).metrics.requestCount, 0);
  const schema = await ch.query({ query: 'SHOW CREATE TABLE trace_spans', format: 'JSONEachRow' });
  assert.match(JSON.stringify(await schema.json()), /TTL event_time \+ toIntervalDay\(30\)/);
  const report = { status: 'passed', sdkOperations: [...new Set(rows.map(r => r.operation))], spanCount: rows.length, metrics: overview.metrics, ttlDays: 30, environmentIsolation: 'passed', privacyCanary: 'absent' };
  fs.writeFileSync(path.join(outputDir, 'w8-integration-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
async function finish() {
  if (stopping) return stopping;
  stopping = (async () => {
    const failures = [];
    const attempt = async (name, fn) => { try { await fn(); } catch { failures.push(name); } };
    for (const child of children.reverse()) await attempt('child shutdown', async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await Promise.race([new Promise(r => child.once('exit', r)), delay(4000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      assert(child.exitCode !== null || child.signalCode !== null);
    });
    if (projectId) {
      await attempt('ClickHouse isolated rows', async () => {
        await ch.command({ query: 'ALTER TABLE trace_spans DELETE WHERE project_id={id:String}', query_params: { id: projectId }, clickhouse_settings: { mutations_sync: '1' } });
        const q = await ch.query({ query: 'SELECT count() AS n FROM trace_spans WHERE project_id={id:String}', query_params: { id: projectId }, format: 'JSONEachRow' });
        assert.equal(Number((await q.json())[0].n), 0);
      });
      await attempt('PostgreSQL isolated project', async () => {
        assert.equal((await pool.query('DELETE FROM projects WHERE id=$1 AND slug=$2', [projectId, run])).rowCount, 1);
        assert.equal((await pool.query('SELECT id FROM projects WHERE id=$1', [projectId])).rowCount, 0);
      });
    }
    if (connected && topicCreated) {
      await attempt('Kafka isolated group', async () => {
        for (let i = 0; i < 90; i++) {
          if (!(await admin.listGroups()).groups.some(g => g.groupId === run)) return;
          try { await admin.deleteGroups([run]); } catch { /* Windows broker session expires shortly */ }
          await delay(500);
        }
        throw new Error('Group remains');
      });
      await attempt('Kafka isolated topic', async () => {
        await admin.deleteTopics({ topics: [run], timeout: 10000 });
        for (let i=0;i<30;i++) { if (!(await admin.listTopics()).includes(run)) return; await delay(300); }
        throw new Error('Topic remains');
      });
    }
    if (connected) await attempt('Kafka disconnect', () => admin.disconnect());
    if (pool) await attempt('PostgreSQL close', () => pool.end());
    if (ch) await attempt('ClickHouse close', () => ch.close());
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'w8-cleanup-result.json'), JSON.stringify({ status: failures.length ? 'failed' : 'passed', failures }, null, 2));
    console.log(JSON.stringify({ cleanup: failures.length ? 'failed' : 'passed', failures }));
    if (failures.length) process.exitCode = 1;
  })();
  return stopping;
}
async function main() {
  assert.equal(process.env.TRACE_OPS_RUN_INTEGRATION, '1', 'Explicit local integration opt-in required');
  assert(process.env.PLATFORM_ADMIN_TOKEN);
  assert(local(new URL(process.env.DATABASE_URL).hostname));
  assert(local(new URL(process.env.CLICKHOUSE_URL).hostname));
  const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map(s=>s.trim());
  assert(brokers.every(s=>/^(localhost|127\.0\.0\.1):\d+$/.test(s)));
  assert.equal(process.env.CLICKHOUSE_TABLE ?? 'trace_spans', 'trace_spans');
  apiPort = await freePort(); const webPort = await freePort(5188);
  pool = new Pool({connectionString:process.env.DATABASE_URL, connectionTimeoutMillis:5000});
  ch = createClient({url:process.env.CLICKHOUSE_URL, username:process.env.CLICKHOUSE_USER, password:process.env.CLICKHOUSE_PASSWORD, database:process.env.CLICKHOUSE_DATABASE, request_timeout:5000, log:{level:ClickHouseLogLevel.OFF}});
  admin = new Kafka({clientId:run, brokers, logLevel:logLevel.NOTHING, retry:{retries:1}, requestTimeout:5000}).admin();
  await admin.connect(); connected = true;
  assert(!(await admin.listTopics()).includes(run));
  assert(!(await admin.listGroups()).groups.some(g=>g.groupId===run));
  assert(await admin.createTopics({waitForLeaders:true,topics:[{topic:run,numPartitions:1,replicationFactor:1}]})); topicCreated = true;
  const env = {...process.env, API_PORT:String(apiPort), KAFKA_TOPIC:run, KAFKA_GROUP_ID:run};
  launch(path.join(root,'apps/api/dist/main.js'), [], path.join(root,'apps/api'), env);
  await until(async () => (await request('/health')).dependencies.postgres === 'ok', 'API health');
  const project = await request('/projects', {name:`W8 SDK 验收 ${run.slice(-8)}`,slug:run}); projectId = project.id;
  await request(`/projects/${projectId}/services`, {name:'web-sdk-demo',environment:'dev'});
  const key = await request(`/projects/${projectId}/keys`, {name:'W8 isolated fixture'});
  const collector = launch(path.join(root,'apps/collector/dist/main.js'), [], path.join(root,'apps/collector'), env);
  await until(()=>collector.output.includes('Collector subscribed to'), 'Collector subscription');
  const viteEntry = path.join(path.dirname(webRequire.resolve('vite/package.json')), 'bin/vite.js');
  launch(viteEntry, ['--host','127.0.0.1','--port',String(webPort),'--strictPort'], path.join(root,'apps/web'), {...env,SDK_TEST_PROJECT_KEY:key.key});
  await until(async()=> (await fetch(`http://127.0.0.1:${webPort}/sdk-test.html`)).ok, 'SDK page');
  fs.mkdirSync(outputDir,{recursive:true});
  const session = {projectId, projectName:project.name, webUrl:`http://127.0.0.1:${webPort}`,apiPort,topic:run};
  fs.writeFileSync(path.join(outputDir,'w8-session.json'),JSON.stringify(session,null,2));
  console.log(JSON.stringify({ready:true,...session}));
  const input = readline.createInterface({input:process.stdin});
  let pending = Promise.resolve();
  input.on('line', line => {
    pending = pending.then(async()=> {
      if(line.trim()==='verify') { try {await verify();} catch {console.error('Verification failed; credentials withheld');process.exitCode=1;} }
      if(line.trim()==='finish') {input.close();await finish();}
    }).catch(async()=> {process.exitCode=1;await finish();});
  });
  input.on('close',()=>void pending.then(finish));
  const limit=setTimeout(()=>{input.close();void finish();},10*60*1000); limit.unref();
}
main().catch(async()=>{console.error('Fixture startup failed; credentials withheld');process.exitCode=1;await finish();});
