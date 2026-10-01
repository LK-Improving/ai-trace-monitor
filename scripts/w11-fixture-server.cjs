// Local protocol fixtures, not vendor inference and never imported by production API.
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const requireApi = createRequire(path.join(root, 'apps/api/package.json'));
requireApi('reflect-metadata');
const { NestFactory } = requireApi('@nestjs/core');
const { Module, Controller, Get, Inject, Param } = requireApi('@nestjs/common');
const { AppModule } = require(path.join(root, 'apps/api/dist/app.module.js'));
const { ObservabilityModule } = require(path.join(root, 'apps/api/dist/observability/observability.module.js'));
const { AiAdaptersService } = require(path.join(root, 'apps/api/dist/observability/ai-adapters.service.js'));
const { ApiExceptionFilter } = require(path.join(root, 'apps/api/dist/common/api-exception.filter.js'));
const canary = 'w11-private-content-canary';
const dummyKey = 'w11-protocol-fixture-key-not-a-real-credential';
const delay = ms => new Promise(r => setTimeout(r, ms));
const stats = { ragCalls: 0, llmCalls: 0 };
const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };

async function provider(request, response) {
  let body = '';
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 1024 * 1024) { response.writeHead(413).end(); return; }
  }
  let input;
  try { input = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
  if (request.url === '/collections/fixture/points/query') {
    assert.equal(request.headers['api-key'], dummyKey);
    assert.deepEqual(input.query, [1, 0]);
    assert.equal(input.limit, 3);
    assert.equal(input.with_payload, true);
    assert.equal(input.with_vector, false);
    stats.ragCalls++;
    await delay(10);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ result: { points: [
      { id: `doc-1-${canary}`, score: 0.9, payload: { content: canary, source: `https://private.example/${canary}` } },
      { id: `doc-2-${canary}`, score: 0.8, payload: { content: canary } },
      { id: `doc-3-${canary}`, score: 0.7, payload: { content: canary } },
    ] }, status: 'ok' }));
    return;
  }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  assert.equal(request.headers.authorization, `Bearer ${dummyKey}`);
  assert(input.messages.some(message => message.content.includes(canary)));
  stats.llmCalls++;
  if (input.model === 'fixture-rate-limit') {
    response.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: canary, code: 'rate_limit_exceeded' } }));
    return;
  }
  if (input.model === 'fixture-timeout') {
    await delay(400);
    if (response.destroyed) return;
  }
  if (!input.stream) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: input.model, choices: [{ index: 0, message: { role: 'assistant', content: canary }, finish_reason: 'stop' }],
      ...(input.model === 'fixture-no-usage' ? {} : { usage }) }));
    return;
  }
  assert.equal(input.stream_options.include_usage, true);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (delta, finish = null) => ({ model: input.model, choices: [{ index: 0, delta, finish_reason: finish }], usage: null });
  response.write(`data: ${JSON.stringify(event({ role: 'assistant' }))}\r\n\r\n`);
  await delay(80);
  if (response.destroyed) return;
  const contentEvent = `data: ${JSON.stringify(event({ content: canary }))}\r\n\r\n`;
  response.write(contentEvent.slice(0, 20));
  response.write(contentEvent.slice(20));
  await delay(20);
  if (response.destroyed) return;
  response.write(`data: ${JSON.stringify(event({}, 'stop'))}\r\n\r\n`);
  response.write(`data: ${JSON.stringify({ model: input.model, choices: [], usage })}\r\n\r\n`);
  response.end('data: [DONE]\r\n\r\n');
}

class FixtureController {
  constructor(clients) { this.clients = clients; }
  async chat(mode) {
    const models = { complete: 'fixture-complete', stream: 'fixture-stream', noUsage: 'fixture-no-usage', rateLimit: 'fixture-rate-limit', timeout: 'fixture-timeout', cancel: 'fixture-stream' };
    const model = models[mode];
    if (!model) throw new Error('Unknown fixture mode');
    const documents = await this.clients.rag().retrieve({ vector: [1, 0], topK: 3,
      rerank: async docs => { await delay(15); return [...docs].reverse().map((doc, index) => ({ ...doc, score: 0.95 - index * 0.1 })); },
    });
    const input = { model, messages: [{ role: 'user', content: `question-${canary}: ${documents[0].payload.content}` }] };
    if (mode === 'stream' || mode === 'cancel') {
      let count = 0;
      for await (const chunk of this.clients.llm().stream(input)) {
        if (chunk.content) { count++; if (mode === 'cancel') break; }
      }
      return { chunks: count, documents: documents.length };
    }
    const result = await this.clients.llm().complete(input);
    assert.equal(result.content, canary);
    return { documents: documents.length, usageAvailable: result.usage !== undefined };
  }
}
Inject(AiAdaptersService)(FixtureController, undefined, 0);
Controller('w11-fixture')(FixtureController);
Get('chat/:mode')(FixtureController.prototype, 'chat', Object.getOwnPropertyDescriptor(FixtureController.prototype, 'chat'));
Param('mode')(FixtureController.prototype, 'chat', 0);
class FixtureStatsController { stats() { return stats; } }
Controller('spans')(FixtureStatsController);
Get('fixture-stats')(FixtureStatsController.prototype, 'stats', Object.getOwnPropertyDescriptor(FixtureStatsController.prototype, 'stats'));
class FixtureModule {}
Module({ imports: [AppModule, ObservabilityModule], controllers: [FixtureController, FixtureStatsController] })(FixtureModule);

async function main() {
  const server = http.createServer((request, response) => {
    provider(request, response).catch(() => { if (!response.destroyed) response.writeHead(500).end(); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const providerPort = server.address().port;
  process.env.LLM_BASE_URL = `http://127.0.0.1:${providerPort}/v1`;
  process.env.LLM_API_KEY = dummyKey;
  process.env.LLM_TIMEOUT_MS = '200';
  process.env.RAG_QDRANT_URL = `http://127.0.0.1:${providerPort}`;
  process.env.RAG_QDRANT_COLLECTION = 'fixture';
  process.env.RAG_QDRANT_API_KEY = dummyKey;
  process.env.RAG_TIMEOUT_MS = '1000';
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT), '127.0.0.1');
  console.log('W11 fixture ready');
}
main().catch(() => { console.error('W11 fixture startup failed'); process.exitCode = 1; });
