import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const contracts = require('../dist/index.js');

const validSpan = {
  traceId: 'trace_v1_00000000-0000-4000-8000-000000000001',
  spanId: 'span-1',
  service: 'api',
  operation: 'http.server',
  startTime: Date.parse('2026-09-25T00:00:00.000Z'),
  endTime: Date.parse('2026-09-25T00:00:00.125Z'),
  status: 'ok',
  attributes: { model: 'gpt-example' },
  tokenUsage: { input: 12, output: 8, total: 20 },
};

const projectId = '00000000-0000-4000-8000-000000000002';
const projectKey = `tr_${'A'.repeat(43)}`;

test('canonical environments accept dev/staging/prod only', () => {
  for (const environment of ['dev', 'staging', 'prod']) {
    assert.equal(contracts.EnvironmentSchema.parse(environment), environment);
  }
  for (const environment of ['development', 'production', 'test', '']) {
    assert.equal(contracts.EnvironmentSchema.safeParse(environment).success, false);
  }
});

test('Trace ID generator uses trace_v1 UUID form and validates generated values', () => {
  assert.equal(
    contracts.generateTraceId(() => '00000000-0000-4000-8000-000000000001'),
    'trace_v1_00000000-0000-4000-8000-000000000001',
  );
  assert.throws(() => contracts.generateTraceId(() => 'invalid id'));
});

test('valid inbound x-trace-id wins; absent, invalid, or duplicate values are replaced', () => {
  let generationCount = 0;
  const generate = () => {
    generationCount += 1;
    return 'trace_v1_generated';
  };

  assert.equal(contracts.resolveTraceId('caller-id:42', generate), 'caller-id:42');
  assert.equal(generationCount, 0);
  assert.equal(contracts.resolveTraceId(undefined, generate), 'trace_v1_generated');
  assert.equal(contracts.resolveTraceId('not a valid id', generate), 'trace_v1_generated');
  assert.equal(contracts.resolveTraceId(['one', 'two'], generate), 'trace_v1_generated');
  assert.equal(generationCount, 3);
});

test('resolved Trace ID is propagated through the x-trace-id response header', () => {
  assert.deepEqual(contracts.traceIdResponseHeaders('trace_v1_response'), {
    'x-trace-id': 'trace_v1_response',
  });
  assert.throws(() => contracts.traceIdResponseHeaders('unsafe id'));
});

test('SpanEvent accepts legacy v1 without schemaVersion and rejects unsupported versions', () => {
  const legacy = contracts.SpanEventSchema.parse({
    ...validSpan,
    projectId,
    environment: 'prod',
  });
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(contracts.SpanEventSchema.parse({ ...legacy, schemaVersion: 1 }).schemaVersion, 1);
  assert.equal(
    contracts.SpanEventSchema.safeParse({ ...legacy, schemaVersion: 2 }).success,
    false,
  );
  assert.equal(
    contracts.SpanEventSchema.safeParse({ ...legacy, environment: 'production' }).success,
    false,
  );
});

test('public ingest contract carries the project key but rejects caller-supplied project identity', () => {
  const request = contracts.SpanIngestRequestSchema.parse({
    projectKey,
    environment: 'staging',
    spans: [validSpan],
  });
  assert.equal(request.environment, 'staging');
  assert.equal(request.projectKey, projectKey);
  assert.equal(contracts.ProjectKeySchema.safeParse('too-short').success, false);
  assert.equal(
    contracts.SpanIngestRequestSchema.safeParse({
      projectKey,
      projectId,
      environment: 'staging',
      spans: [validSpan],
    }).success,
    false,
  );
  assert.equal(contracts.ProjectKeyScopeSchema.parse('spans:write'), 'spans:write');
  assert.equal(contracts.ProjectKeyScopeSchema.parse('trace:read'), 'trace:read');
  assert.equal(contracts.ProjectKeyScopeSchema.safeParse('traces:read').success, false);
  assert.deepEqual(contracts.ProjectKeyScopesSchema.parse(['spans:write']), ['spans:write']);
  assert.deepEqual(contracts.ProjectKeyScopesSchema.parse(['trace:read']), ['trace:read']);
  assert.equal(contracts.ProjectKeyScopesSchema.safeParse(['spans:write', 'trace:read']).success, false);
});

test('Span schemas reject inverted time ranges and oversized ingest batches', () => {
  assert.equal(
    contracts.TraceSpanSchema.safeParse({ ...validSpan, endTime: validSpan.startTime - 1 }).success,
    false,
  );
  assert.equal(
    contracts.SpanIngestRequestSchema.safeParse({
      projectKey,
      environment: 'dev',
      spans: Array.from({ length: 501 }, (_, index) => ({ ...validSpan, spanId: `span-${index}` })),
    }).success,
    false,
  );
});

test('attribute redaction removes prompt, response, and credential fields recursively', () => {
  const redacted = contracts.redactSpanAttributes({
    model: 'gpt-example',
    prompt: 'private prompt',
    projectKey: 'secret',
    nested: {
      response: 'private answer',
      access_token: 'secret-token',
      'http.status_code': 200,
    },
  });

  assert.deepEqual(redacted, {
    model: 'gpt-example',
    nested: { 'http.status_code': 200 },
  });
});

test('project-specific additional fields are recursively redacted and policy input is bounded', () => {
  const redacted = contracts.redactSpanAttributes({
    accountEmail: 'private@example.test',
    nested: { accountEmail: 'nested-private@example.test', safe: 'kept' },
    entries: [{ accountemail: 'array-private@example.test', visible: true }],
  }, ['accountemail']);
  assert.deepEqual(redacted, { nested: { safe: 'kept' }, entries: [{ visible: true }] });

  assert.deepEqual(contracts.ProjectPrivacyPolicyPatchSchema.parse({
    additionalRedactedFields: ['AccountEmail', 'customer_id'],
    capturePromptResponse: false,
  }), { additionalRedactedFields: ['accountemail', 'customer_id'], capturePromptResponse: false });
  for (const invalid of [
    { additionalRedactedFields: Array.from({ length: 65 }, (_, index) => `field${index}`) },
    { additionalRedactedFields: ['a'.repeat(65)] },
    { additionalRedactedFields: ['customer.email'] },
    { additionalRedactedFields: ['Email', 'email'] },
    { capturePromptResponse: true },
    {},
  ]) {
    assert.equal(contracts.ProjectPrivacyPolicyPatchSchema.safeParse(invalid).success, false);
  }
});

test('ClickHouse row mapping matches trace_spans columns and never persists project keys', () => {
  const event = contracts.SpanEventSchema.parse({
    ...validSpan,
    projectId,
    environment: 'prod',
    schemaVersion: 1,
    parentSpanId: 'span-root',
    attributes: { model: 'gpt-example', projectKey: 'must-not-persist' },
  });
  const row = contracts.toClickHouseRow(event);

  assert.deepEqual(Object.keys(row), [
    'event_time', 'project_id', 'environment', 'trace_id', 'span_id', 'parent_span_id',
    'service', 'operation', 'status', 'start_time', 'end_time', 'duration_ms',
    'input_tokens', 'output_tokens', 'total_tokens', 'model', 'attributes', 'error',
  ]);
  assert.equal(row.project_id, projectId);
  assert.equal(row.environment, 'prod');
  assert.equal(row.trace_id, validSpan.traceId);
  assert.equal(row.parent_span_id, 'span-root');
  assert.equal(row.event_time, '2026-09-25 00:00:00.000');
  assert.equal(row.start_time, '2026-09-25 00:00:00.000');
  assert.equal(row.end_time, '2026-09-25 00:00:00.125');
  assert.equal(row.duration_ms, 125);
  assert.equal(row.input_tokens, 12);
  assert.equal(row.output_tokens, 8);
  assert.equal(row.total_tokens, 20);
  assert.equal(row.model, 'gpt-example');
  assert.deepEqual(JSON.parse(row.attributes), { model: 'gpt-example' });
  assert.equal('schemaVersion' in row, false);
  assert.equal('projectKey' in row, false);
});
