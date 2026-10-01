import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { beginObservation, AiAdapterError, providerEndpoint, httpError, readProviderJson } = require('../dist/observability/ai-observation.js');
const { TraceContext } = require('../dist/observability/trace-context.js');
const { TraceRecorder } = require('../dist/observability/trace-recorder.js');
const binding = { projectId: '89ee24ab-a251-4498-8d54-3294f4c32811', service: 'api', environment: 'dev' };

test('AI observation is a no-op when tracing is disabled and still runs business code', () => {
  const context = new TraceContext();
  const observation = beginObservation(context, 'llm.generate');
  assert.equal(observation.run(() => 42), 42);
  observation.set('bad', {});
  observation.finish();
});
test('child context inherits root and telemetry errors cannot override provider result', async () => {
  const context = new TraceContext(), events = [];
  const recorder = new TraceRecorder(binding, e => events.push(e));
  const root = recorder.start('http.server', 'ai-observation-test');
  await context.run(recorder, root, async () => {
    const observation = beginObservation(context, 'llm.generate');
    assert.notEqual(observation.run(() => context.current().span.id), root.id);
    observation.set('prompt', 'private-canary');
    observation.setUsage(-1, 2);
    observation.finish(new AiAdapterError('rate_limit', 429));
    observation.finish();
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].parentSpanId, root.id);
  assert.equal(events[0].attributes['ai.error_category'], 'rate_limit');
  assert(!JSON.stringify(events).includes('private-canary'));
});
test('server endpoint validation rejects URL credentials, query, redirects and insecure nonlocal URLs', () => {
  for (const url of ['bad', 'http://remote.example/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?key=x', 'https://example.com/v1#secret']) {
    assert.throws(() => providerEndpoint(url), e => e.category === 'invalid_request');
  }
  assert.equal(providerEndpoint('http://127.0.0.1:1234/v1').href, 'http://127.0.0.1:1234/v1/');
  assert.equal(providerEndpoint('https://provider.example/v1/').href, 'https://provider.example/v1/');
});
test('HTTP errors use fixed categories and no provider payload', () => {
  for (const [status, category] of [[429, 'rate_limit'], [401, 'authentication'], [403, 'authentication'], [504, 'timeout'], [500, 'provider_error'], [400, 'invalid_request']]) {
    assert.equal(httpError(status).category, category);
    assert.equal(httpError(status).httpStatus, status);
    assert.equal(httpError(status).cause, undefined);
  }
});
test('provider JSON parsing is bounded and invalid content is not reflected', async () => {
  assert.deepEqual(await readProviderJson(new Response('{"ok":true}')), { ok: true });
  await assert.rejects(readProviderJson(new Response('private-invalid-json')), e => e.category === 'invalid_response' && !e.message.includes('private'));
  await assert.rejects(readProviderJson(new Response('x'.repeat(100)), 10), e => e.category === 'invalid_response');
});
