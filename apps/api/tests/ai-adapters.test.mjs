import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AiAdaptersService } = require('../dist/observability/ai-adapters.service.js');
const { TraceContext } = require('../dist/observability/trace-context.js');

function service(values = {}) {
  return new AiAdaptersService({ get: key => values[key] }, new TraceContext());
}
test('provider clients require explicit server configuration but do not affect module startup', () => {
  const clients = service();
  assert.throws(() => clients.llm(), e => e.category === 'invalid_request');
  assert.throws(() => clients.rag(), e => e.category === 'invalid_request');
});
test('clients are lazy/cached, constructors do not call providers', () => {
  const clients = service({ LLM_BASE_URL: 'http://127.0.0.1:1234/v1', LLM_API_KEY: 'local-fixture-only',
    RAG_QDRANT_URL: 'http://127.0.0.1:1234', RAG_QDRANT_COLLECTION: 'fixture' });
  assert.equal(clients.llm(), clients.llm());
  assert.equal(clients.rag(), clients.rag());
});
test('invalid timeouts are rejected rather than silently making provider deadlines unbounded', () => {
  for (const timeout of ['NaN', '0', '99', '120001', '1.5']) {
    const clients = service({ LLM_BASE_URL: 'http://127.0.0.1:1234/v1', LLM_API_KEY: 'fixture', LLM_TIMEOUT_MS: timeout });
    assert.throws(() => clients.llm(), e => e.category === 'invalid_request');
  }
});
