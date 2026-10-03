import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const enabled = process.env.TRACE_OPS_RUN_ALERTS_INTEGRATION === '1';

test('Collector alerts are idempotent in Postgres and exposed through the scoped API service', {
  skip: enabled ? false : 'Set TRACE_OPS_RUN_ALERTS_INTEGRATION=1 to use the configured local PostgreSQL database',
}, async () => {
  const { Pool } = require('pg');
  const { AlertEngine } = require('../../collector/dist/alert-engine.js');
  const { AlertsDatabase } = require('../dist/alerts/alerts.database.js');
  const { AlertsService } = require('../dist/alerts/alerts.service.js');
  const runId = randomUUID();
  const projectSlugs = [`alerts-w21-${runId}`, `alerts-w21-other-${runId}`];
  const config = { get: (name) => name === 'DATABASE_URL' ? process.env.DATABASE_URL : undefined };
  const database = new AlertsDatabase(config);
  const collectorPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const secondCollectorPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const engine = new AlertEngine(collectorPool);
  const secondEngine = new AlertEngine(secondCollectorPool);
  const alerts = new AlertsService(database);
  const projectIds = [];
  let primaryFailure;

  const createProject = async (slug) => {
    const result = await database.query(
      'INSERT INTO projects (name, slug) VALUES ($1, $2) RETURNING id',
      [`Alert acceptance ${runId.slice(0, 8)}`, slug],
    );
    const id = result.rows[0]?.id;
    assert.equal(typeof id, 'string');
    projectIds.push(id);
    return id;
  };

  const makeSpan = (projectId, overrides = {}) => ({
    schemaVersion: 1,
    projectId,
    environment: 'dev',
    traceId: `trace_v1_${runId}`,
    spanId: 'span-error',
    service: 'api',
    operation: 'http.server',
    startTime: Date.now() - 20_000,
    endTime: Date.now() - 19_000,
    status: 'error',
    attributes: {},
    ...overrides,
  });

  try {
    await Promise.all([
      database.onModuleInit(),
      engine.initialize(),
      secondEngine.initialize(),
    ]);
    const projectId = await createProject(projectSlugs[0]);
    const otherProjectId = await createProject(projectSlugs[1]);
    const spans = [
      makeSpan(projectId),
      makeSpan(projectId, {
        spanId: 'span-slow', status: 'ok', startTime: Date.now() - 10_000,
        endTime: Date.now() - 7_999,
      }),
      makeSpan(projectId, {
        spanId: 'span-tokens', status: 'ok', operation: 'llm.generate',
        tokenUsage: { input: 3_000, output: 2_001, total: 5_001 },
      }),
      makeSpan(projectId, {
        spanId: 'span-empty-rag', status: 'ok', operation: 'rag.retrieve',
        attributes: { sources: [], retrievedCount: 0 },
      }),
    ];

    const firstPass = await Promise.all([
      engine.processSpans(spans),
      secondEngine.processSpans(spans),
    ]);
    assert.equal(firstPass.reduce((sum, count) => sum + count, 0), 4);
    assert.equal(await engine.processSpans(spans), 0, 'A replay must not create or count alert occurrences again');

    const initial = await alerts.list({ projectId, environment: 'dev' });
    assert.equal(initial.total, 4);
    assert.deepEqual(initial.items.map(({ rule }) => rule).sort(), [
      'llm_token_threshold', 'rag_empty_recall', 'span_error', 'span_latency',
    ]);
    assert(initial.items.every(({ triggerCount, state }) => triggerCount === 1 && state === 'active'));

    const errorAlert = initial.items.find(({ rule }) => rule === 'span_error');
    assert.ok(errorAlert);
    const repeatedError = makeSpan(projectId, { spanId: 'span-error-2' });
    assert.equal(await engine.processSpans([repeatedError]), 1);
    const repeated = await alerts.list({ projectId, environment: 'dev', state: 'active' });
    assert.equal(repeated.items.find(({ rule }) => rule === 'span_error').triggerCount, 2);

    assert.equal((await alerts.updateState(errorAlert.id, { state: 'acknowledged' })).state, 'acknowledged');
    assert.equal(await engine.processSpans([makeSpan(projectId, { spanId: 'span-error-3' })]), 1);
    assert.equal((await alerts.list({ projectId, environment: 'dev', state: 'acknowledged' })).items[0].triggerCount, 3);
    assert.equal((await alerts.updateState(errorAlert.id, { state: 'resolved' })).state, 'resolved');
    assert.equal(await engine.processSpans([repeatedError]), 0, 'A replay after resolve must remain deduped');
    assert.equal(await engine.processSpans([makeSpan(projectId, { spanId: 'span-error-4' })]), 1);

    const conflict = await alerts.updateState(errorAlert.id, { state: 'active' }).then(() => false, (error) => error.getStatus() === 409);
    assert.equal(conflict, true, 'Reopening must not create a second open event for one rule scope');
    const activeError = (await alerts.list({ projectId, environment: 'dev', state: 'active' })).items
      .find(({ rule, spanId }) => rule === 'span_error' && spanId === 'span-error-4');
    assert.ok(activeError);
    await alerts.updateState(activeError.id, { state: 'resolved' });
    assert.equal((await alerts.updateState(errorAlert.id, { state: 'active' })).state, 'active');

    await engine.processSpans([makeSpan(projectId, { environment: 'staging' })]);
    await engine.processSpans([makeSpan(projectId, { service: 'worker' })]);
    await engine.processSpans([makeSpan(otherProjectId)]);
    const projectOne = await alerts.list({ projectId, environment: 'all' });
    const projectTwo = await alerts.list({ projectId: otherProjectId, environment: 'all' });
    assert.equal(projectOne.total, 7);
    assert.equal(projectTwo.total, 1);
    assert.equal((await alerts.list({ projectId, environment: 'staging' })).total, 1);
    assert.equal((await alerts.list({ projectId, environment: 'dev', level: 'critical' })).total, 3);
    assert.deepEqual(await alerts.summary({ projectId, environment: 'staging' }), {
      total: 1, active: 1, acknowledged: 0, resolved: 0, criticalActive: 1,
    });
  } catch (error) {
    primaryFailure = error?.name === 'AssertionError'
      ? error
      : new Error('Alert Postgres acceptance failed; storage errors are intentionally redacted');
  } finally {
    const cleanupFailures = [];
    const attempt = async (label, operation) => {
      try { await operation(); } catch { cleanupFailures.push(label); }
    };
    if (projectIds.length > 0) {
      await attempt('isolated test project cleanup', async () => {
        const deleted = await database.query(
          'DELETE FROM projects WHERE id = ANY($1::uuid[]) AND slug = ANY($2::text[]) RETURNING id',
          [projectIds, projectSlugs],
        );
        if (deleted.rows.length !== projectIds.length) throw new Error('Test project cleanup was incomplete');
        const remaining = await database.query('SELECT id FROM projects WHERE id = ANY($1::uuid[])', [projectIds]);
        if (remaining.rows.length !== 0) throw new Error('Test project cleanup verification failed');
      });
    }
    await attempt('first Collector pool shutdown', () => engine.close());
    await attempt('second Collector pool shutdown', () => secondEngine.close());
    await attempt('API alert pool shutdown', () => database.onModuleDestroy());
    if (cleanupFailures.length > 0) {
      throw new Error(`Alert integration cleanup failed: ${cleanupFailures.join(', ')}`);
    }
    if (primaryFailure) throw primaryFailure;
  }
});
