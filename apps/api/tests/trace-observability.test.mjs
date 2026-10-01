import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TraceObservabilityService } = require('../dist/observability/trace-observability.service.js');
const projectId = 'cfa2eb20-cf10-4b72-a3b2-e948d6c4c692';

function harness(overrides = {}, rows = [{ id: 'service' }], fail = false) {
  const values = { SERVER_TRACE_ENABLED: 'true', SERVER_TRACE_PROJECT_ID: projectId,
    SERVER_TRACE_SERVICE: 'api', SERVER_TRACE_ENVIRONMENT: 'dev', ...overrides };
  const calls = [], events = [];
  const service = new TraceObservabilityService({ get: k => values[k] }, {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (fail) throw new Error('credential-canary');
      return { rows };
    },
  }, { enqueue: batch => { events.push(...batch); return { accepted: true }; } });
  return { service, calls, events };
}

test('server binding is disabled by default without database/queue I/O', async () => {
  const h = harness({ SERVER_TRACE_ENABLED: undefined });
  await h.service.onModuleInit();
  assert.deepEqual(h.service.status(), { state: 'disabled' });
  assert.equal(h.service.recorder(), undefined);
  assert.equal(h.calls.length, 0);
});
test('invalid/unregistered/offline binding fails open without exposing configuration', async () => {
  for (const [h, state] of [
    [harness({ SERVER_TRACE_PROJECT_ID: 'bad' }), 'invalid_configuration'],
    [harness({}, []), 'unregistered_binding'],
    [harness({}, [], true), 'dependency_unavailable'],
  ]) {
    await h.service.onModuleInit();
    assert.deepEqual(h.service.status(), { state });
    assert.equal(h.service.recorder(), undefined);
    assert(!JSON.stringify(h.service.status()).includes('canary'));
  }
});
test('registered binding is parameterized, trusted, and shares the bounded queue', async () => {
  const h = harness();
  await h.service.onModuleInit();
  assert.deepEqual(h.service.status(), { state: 'ready' });
  assert.deepEqual(h.calls[0].params, [projectId, 'api', 'dev']);
  assert(!h.calls[0].sql.includes(projectId));
  assert(h.calls[0].sql.includes("p.status = 'active'"));
  h.service.recorder().start('http.server', 'trusted-trace').end();
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].projectId, projectId);
  assert.equal(h.events[0].service, 'api');
  assert.equal(h.events[0].environment, 'dev');
  assert.equal(h.calls.length, 1);
});
test('binding check has a bounded startup deadline', async () => {
  const h = harness();
  h.service.database = { query: () => new Promise(() => {}) };
  const started = Date.now();
  await h.service.onModuleInit();
  assert.equal(h.service.status().state, 'dependency_unavailable');
  assert(Date.now() - started < 2500);
});
