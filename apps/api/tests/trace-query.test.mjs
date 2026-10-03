import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseTraceListQuery, parseTraceDetailQuery } = require('../dist/traces/trace-query.js');
const base = { projectId: '89ee24ab-a251-4498-8d54-3294f4c32811', environment: 'dev',
  from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00.000Z' };

test('trace list normalizes UTC bounds and bounded pagination without coercing array inputs', () => {
  const result = parseTraceListQuery(base);
  assert.equal(result.page, 1); assert.equal(result.pageSize, 20);
  assert.equal(result.toMs - result.fromMs, 86400000);
  for (const extra of [{ page: '0' }, { pageSize: '101' }, { page: '1000', pageSize: '100' },
    { page: ['1'] }, { projectId: 'not-uuid' }, { status: 'all' }, { from: '2026-02-30T00:00:00Z' },
    { to: base.from }, { from: '2026-08-01T00:00:00Z' }, { unknown: 'value' }, { environment: 'production' }]) {
    assert.throws(() => parseTraceListQuery({ ...base, ...extra }), error => error.getStatus() === 400);
  }
});
test('trace detail requires explicit project/environment and rejects content access', () => {
  assert.equal(parseTraceDetailQuery('trace-valid', { projectId: base.projectId, environment: 'dev' }).includeContent, false);
  for (const query of [{}, { projectId: base.projectId, environment: 'all' },
    { ...base, to: undefined }, { ...base, includeContent: ['false'] }]) {
    assert.throws(() => parseTraceDetailQuery('trace-valid', query), error => error.getStatus() === 400);
  }
  assert.throws(() => parseTraceDetailQuery('trace-valid', { ...base, includeContent: 'true' }), error => error.getStatus() === 403);
  assert.throws(() => parseTraceDetailQuery('unsafe/id', base), error => error.getStatus() === 400);
});
test('traces controller applies read-only project-key/admin guard to both read endpoints', () => {
  const { GUARDS_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
  const { TraceReadGuard } = require('../dist/traces/trace-read.guard.js');
  const { TracesController } = require('../dist/traces/traces.controller.js');
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, TracesController), [TraceReadGuard]);
  assert.equal(Reflect.getMetadata(PATH_METADATA, TracesController), 'traces');
  const controller = new TracesController({ list: q => q }, { detail: (id, q) => ({ id, q }) });
  assert.deepEqual(controller.list(base), base);
  assert.deepEqual(controller.detail('trace-valid', base), { id: 'trace-valid', q: base });
});
