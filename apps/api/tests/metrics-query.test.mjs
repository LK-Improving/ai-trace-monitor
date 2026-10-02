import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseMetricsQuery } = require('../dist/metrics/metrics-query.js');
const { MetricsController } = require('../dist/metrics/metrics.controller.js');
const { metricsSpansSql } = require('../dist/metrics/metrics-sql.js');
const { AdminTokenGuard } = require('../dist/admin/admin-token.guard.js');
const { GUARDS_METADATA, PATH_METADATA, METHOD_METADATA } = require('@nestjs/common/constants');
const { RequestMethod } = require('@nestjs/common');
const projectId = 'b35a64bb-8a12-4806-9e77-8831870a5dd0', now = Date.parse('2026-10-02T12:00:00Z');

test('metrics scope is strict, canonical, and uses fixed bounded ranges', () => {
  for (const [range, hours] of [['1h', 1], ['24h', 24], ['7d', 168]]) {
    const parsed = parseMetricsQuery({ projectId: projectId.toUpperCase(), range, service: 'rag-retriever' }, now);
    assert.equal(parsed.projectId, projectId); assert.equal(parsed.environment, 'all');
    assert.equal(parsed.service, 'rag-retriever'); assert.equal(parsed.toMs, now);
    assert.equal(parsed.toMs - parsed.fromMs, hours * 3600000);
  }
  assert.equal(parseMetricsQuery({ projectId }, now).range, '24h');
  for (const raw of [null, [], {}, { projectId: [projectId] }, { projectId, range: '30d' },
    { projectId, environment: 'production' }, { projectId, from: '2026-10-02' },
    { projectId, service: ['api'] }, { projectId, service: ' api' }, { projectId, service: 'a\n' },
    { projectId, service: 'a'.repeat(121) }, { projectId, includeContent: 'true' }]) {
    assert.throws(() => parseMetricsQuery(raw, now), error => error.getStatus() === 400);
  }
});

test('explicit UTC windows follow requirement 6.4 and remain bounded', () => {
  const result = parseMetricsQuery({ projectId, from: '2026-10-01T12:00:00Z', to: '2026-10-02T12:00:00.000Z', groupBy: 'service' }, now);
  assert.equal(result.range, 'custom'); assert.equal(result.fromMs, now - 86400000); assert.equal(result.toMs, now);
  assert.equal(result.bucketMs, 900000);
  for (const query of [
    { from: '2026-10-01T12:00:00Z' }, { to: '2026-10-02T12:00:00Z' },
    { from: '2026-09-01T12:00:00Z', to: '2026-10-02T12:00:00Z' },
    { from: '2026-10-02T12:00:00Z', to: '2026-10-02T12:00:00Z' },
    { from: '2026-02-30T12:00:00Z', to: '2026-03-01T12:00:00Z' },
    { from: '2026-10-01T12:00:00+00:00', to: '2026-10-02T12:00:00Z' },
    { from: '2026-10-01T12:00:00Z', to: '2026-10-02T12:00:00Z', range: '24h' }, { groupBy: 'prompt' },
  ]) assert.throws(() => parseMetricsQuery({ projectId, ...query }, now), error => error.getStatus() === 400);
});

test('both metrics endpoints are GET and admin protected', () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, MetricsController), 'metrics');
  assert(Reflect.getMetadata(GUARDS_METADATA, MetricsController).includes(AdminTokenGuard));
  for (const [method, route] of [['getOverview', 'overview'], ['getAiMetrics', 'ai']]) {
    assert.equal(Reflect.getMetadata(PATH_METADATA, MetricsController.prototype[method]), route);
    assert.equal(Reflect.getMetadata(METHOD_METADATA, MetricsController.prototype[method]), RequestMethod.GET);
  }
});

test('token columns widen before aggregate sums, retaining scoped deterministic deduplication', () => {
  const sql = metricsSpansSql();
  for (const [index, name] of [[8, 'total_tokens'], [9, 'input_tokens'], [10, 'output_tokens']]) {
    assert(sql.includes(`toUInt128(tupleElement(span, ${index})) AS ${name}`));
  }
  assert.match(sql, /GROUP BY project_id, environment, trace_id, span_id/);
  assert.doesNotMatch(sql.slice(sql.indexOf('FROM trace_spans'), sql.indexOf('GROUP BY')), /\{service:String\}/);
});
