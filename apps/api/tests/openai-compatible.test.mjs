import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AiAdapterError } = require('../dist/observability/ai-observation.js');
const { OpenAiCompatibleClient } = require('../dist/observability/openai-compatible.client.js');
const { TraceContext } = require('../dist/observability/trace-context.js');

class RecordingSpan {
  constructor(operation, traceId, id, parentSpanId) {
    this.operation = operation;
    this.traceId = traceId;
    this.id = id;
    this.parentSpanId = parentSpanId;
    this.attributes = {};
    this.ended = false;
  }

  set(key, value) {
    this.attributes[key] = value;
    return this;
  }

  setUsage(input, output) {
    this.tokenUsage = { input, output, total: input + output };
    return this;
  }

  end(error) {
    this.error = error;
    this.status = error === undefined ? 'ok' : 'error';
    this.ended = true;
    return this;
  }
}

class RecordingRecorder {
  spans = [];
  sequence = 0;

  start(operation, traceId, parentSpanId) {
    const span = new RecordingSpan(operation, traceId, `span-${++this.sequence}`, parentSpanId);
    this.spans.push(span);
    return span;
  }
}

async function createProvider(t, handler) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request);
    Promise.resolve(handler(request, response, requests.length)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      if (!response.destroyed) response.end('fixture failure');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function clientFor(context, baseUrl, timeoutMs) {
  return new OpenAiCompatibleClient(context, {
    baseUrl,
    apiKey: 'server-api-key-canary',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function runInTrace(context, recorder, traceId, fn) {
  const root = recorder.start('http.server', traceId);
  return context.run(recorder, root, fn);
}

function aiSpan(recorder, traceId) {
  return recorder.spans.find((span) => span.operation === 'llm.generate' && span.traceId === traceId);
}

function event(data, lineEnding = '\n') {
  return `data: ${JSON.stringify(data)}${lineEnding}${lineEnding}`;
}

test('complete sends a bounded chat request and records only safe metadata plus real usage', async (t) => {
  let received;
  const provider = await createProvider(t, async (request, response) => {
    received = { request, body: await readJson(request) };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      model: 'gpt-4.1-mini',
      choices: [{ message: { role: 'assistant', content: 'private-generated-answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }));
  });
  const context = new TraceContext();
  const recorder = new RecordingRecorder();
  const client = clientFor(context, provider.baseUrl);
  const result = await runInTrace(context, recorder, 'trace-complete', () => client.complete({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'private-request-canary' }],
  }));

  assert.deepEqual(result, {
    model: 'gpt-4.1-mini',
    content: 'private-generated-answer',
    usage: { input: 7, output: 3, total: 10 },
    finishReason: 'stop',
  });
  assert.equal(received.request.method, 'POST');
  assert.equal(received.request.url, '/v1/chat/completions');
  assert.equal(received.request.headers.authorization, 'Bearer server-api-key-canary');
  assert.deepEqual(received.body, {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'private-request-canary' }],
  });

  const span = aiSpan(recorder, 'trace-complete');
  assert.equal(span.status, 'ok');
  assert.equal(span.attributes.model, 'gpt-4.1-mini');
  assert.equal(span.attributes.requested_model, 'gpt-4o-mini');
  assert.equal(span.attributes['llm.model'], 'gpt-4o-mini');
  assert.equal(span.attributes['llm.response_model'], 'gpt-4.1-mini');
  assert.equal(span.attributes['llm.streaming'], false);
  assert.equal(span.attributes['llm.usage_available'], true);
  assert.equal(span.attributes['llm.finish_reason'], 'stop');
  assert.equal(typeof span.attributes['llm.total_latency_ms'], 'number');
  assert.equal(span.attributes['llm.ttft_ms'], undefined);
  assert.deepEqual(span.tokenUsage, { input: 7, output: 3, total: 10 });
  assert(!JSON.stringify(span.attributes).includes('private-'));
  assert(!JSON.stringify(span.attributes).includes('server-api-key-canary'));
});

test('missing or null usage remains unavailable instead of becoming zero tokens', async (t) => {
  const provider = await createProvider(t, async (_request, response, index) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      ...(index === 1 ? {} : { usage: null }),
    }));
  });
  const context = new TraceContext();
  const recorder = new RecordingRecorder();
  const client = clientFor(context, provider.baseUrl);
  for (const [index, traceId] of ['trace-no-usage', 'trace-null-usage'].entries()) {
    const result = await runInTrace(context, recorder, traceId, () => client.complete({
      model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }],
    }));
    assert.equal(Object.hasOwn(result, 'usage'), false);
    const span = aiSpan(recorder, traceId);
    assert.equal(span.attributes['llm.usage_available'], false);
    assert.equal(span.tokenUsage, undefined);
  }
  assert.equal(provider.requests.length, 2);
});

test('present total_tokens must be a safe integer equal to input plus output', async (t) => {
  const usages = [
    { prompt_tokens: 2, completion_tokens: 3, total_tokens: 6 },
    { prompt_tokens: 2, completion_tokens: 3, total_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ];
  const provider = await createProvider(t, async (_request, response) => {
    const usage = usages.shift();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage,
    }));
  });
  const context = new TraceContext();
  const recorder = new RecordingRecorder();
  const client = clientFor(context, provider.baseUrl);

  for (const traceId of ['trace-total-mismatch', 'trace-total-unsafe']) {
    await assert.rejects(runInTrace(context, recorder, traceId, () => client.complete({
      model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'go' }],
    })), (error) => error instanceof AiAdapterError && error.category === 'invalid_response');
    assert.equal(aiSpan(recorder, traceId).error.category, 'invalid_response');
  }
});

test('monitoring off still performs the provider request and returns the business result', async (t) => {
  const provider = await createProvider(t, async (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ message: { role: 'assistant', content: 'business-result' }, finish_reason: 'stop' }],
    }));
  });
  const client = clientFor(new TraceContext(), provider.baseUrl);
  const result = await client.complete({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'go' }] });

  assert.equal(provider.requests.length, 1);
  assert.equal(result.content, 'business-result');
  assert.equal(result.usage, undefined);
});

test('complete preserves content filtered by the provider while marking the span safely', async (t) => {
  const provider = await createProvider(t, async (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ message: { role: 'assistant', content: 'filtered-partial-canary' }, finish_reason: 'content_filter' }],
      usage: null,
    }));
  });
  const context = new TraceContext();
  const recorder = new RecordingRecorder();
  const result = await runInTrace(context, recorder, 'trace-filtered', () => clientFor(context, provider.baseUrl).complete({
    model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'private-prompt-canary' }],
  }));

  assert.equal(result.content, 'filtered-partial-canary');
  assert.equal(result.usage, undefined);
  const span = aiSpan(recorder, 'trace-filtered');
  assert.equal(span.status, 'error');
  assert.equal(span.error.category, 'content_filter');
  assert.equal(span.attributes['llm.finish_reason'], 'content_filter');
  assert.equal(span.attributes['llm.usage_available'], false);
  assert(!JSON.stringify(span.attributes).includes('canary'));
});

test('stream handles split CRLF and multiline SSE, role delay, finish choice, and trailing choices-empty usage', async (t) => {
  let receivedBody;
  const provider = await createProvider(t, async (request, response) => {
    receivedBody = await readJson(request);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const role = 'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\r\n\r\n';
    const split = role.indexOf('\r\n') + 1;
    response.write(role.slice(0, split));
    setTimeout(() => {
      if (response.destroyed) return;
      response.write(role.slice(split));
      setTimeout(() => {
        if (response.destroyed) return;
        response.write('data: {"choices":[{"delta":{"content":"hel"},\r\n');
        response.write('data: "finish_reason":null}]}\r\n\r\n');
        response.write('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n');
        response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        response.write('data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n');
        response.end('data: [DONE]\r\n\r\n');
      }, 80);
    }, 10);
  });
  const context = new TraceContext();
  const recorder = new RecordingRecorder();
  const client = clientFor(context, provider.baseUrl);
  const chunks = [];
  await runInTrace(context, recorder, 'trace-stream', async () => {
    for await (const chunk of client.stream({
      model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'stream-private-canary' }],
    })) chunks.push(chunk);
  });

  assert.deepEqual(receivedBody, {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'stream-private-canary' }],
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.deepEqual(chunks.map((chunk) => chunk.content).filter(Boolean), ['hel', 'lo']);
  assert(chunks.some((chunk) => chunk.finishReason === 'stop'));
  assert(chunks.some((chunk) => chunk.usage?.input === 4 && chunk.usage.output === 2 && chunk.usage.total === 6));
  assert.equal(chunks.some((chunk) => Object.hasOwn(chunk, 'content') && chunk.content === undefined), false);
  const span = aiSpan(recorder, 'trace-stream');
  assert.equal(span.attributes['llm.streaming'], true);
  assert.equal(span.attributes['llm.ttft_ms'] >= 50, true);
  assert.equal(span.attributes['llm.finish_reason'], 'stop');
  assert.equal(span.attributes['llm.usage_available'], true);
  assert.deepEqual(span.tokenUsage, { input: 4, output: 2, total: 6 });
  assert.equal(span.status, 'ok');
});

test('concurrent streams keep their trace context and model metadata isolated', async (t) => {
  const provider = await createProvider(t, async (request, response) => {
    const body = await readJson(request);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    setTimeout(() => {
      if (response.destroyed) return;
      response.end(
        event({ model: 'provider-model', choices: [{ delta: { content: body.model }, finish_reason: null }] })
        + event({ choices: [{ delta: {}, finish_reason: 'stop' }] })
        + 'data: [DONE]\n\n',
      );
    }, body.model === 'model-a' ? 50 : 10);
  });
  const context = new TraceContext();
  const recorder = new RecordingRecorder();
  const client = clientFor(context, provider.baseUrl);
  const roots = new Map();

  const consume = (model, traceId) => {
    const root = recorder.start('http.server', traceId);
    roots.set(traceId, root);
    return context.run(recorder, root, async () => {
      let content = '';
      for await (const chunk of client.stream({ model, messages: [{ role: 'user', content: 'go' }] })) {
        content += chunk.content ?? '';
      }
      return content;
    });
  };
  assert.deepEqual(await Promise.all([consume('model-a', 'trace-a'), consume('model-b', 'trace-b')]), ['model-a', 'model-b']);

  for (const [model, traceId] of [['model-a', 'trace-a'], ['model-b', 'trace-b']]) {
    const span = aiSpan(recorder, traceId);
    assert.equal(span.attributes.model, 'provider-model');
    assert.equal(span.attributes.requested_model, model);
    assert.equal(span.attributes['llm.model'], model);
    assert.equal(span.attributes['llm.response_model'], 'provider-model');
    assert.equal(span.parentSpanId, roots.get(traceId).id);
    assert.equal(span.status, 'ok');
  }
});

test('stream content filtered at finish preserves yielded text and consumes trailing usage', async (t) => {
  const provider = await createProvider(t, async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      event({ choices: [{ delta: { content: 'filtered-stream-canary' }, finish_reason: null }] })
      + event({ choices: [{ delta: {}, finish_reason: 'content_filter' }] })
      + event({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } })
      + 'data: [DONE]\n\n',
    );
  });
  const context = new TraceContext();
  const recorder = new RecordingRecorder();
  let content = '';
  const chunks = [];
  await runInTrace(context, recorder, 'trace-stream-filter', async () => {
    for await (const chunk of clientFor(context, provider.baseUrl).stream({
      model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'private' }],
    })) {
      chunks.push(chunk);
      content += chunk.content ?? '';
    }
  });

  assert.equal(content, 'filtered-stream-canary');
  assert(chunks.some((chunk) => chunk.usage?.total === 3));
  const span = aiSpan(recorder, 'trace-stream-filter');
  assert.equal(span.status, 'error');
  assert.equal(span.error.category, 'content_filter');
  assert.equal(span.attributes['llm.usage_available'], true);
  assert.deepEqual(span.tokenUsage, { input: 2, output: 1, total: 3 });
});

test('breaking stream iteration cancels the response and ends its span as cancelled', async (t) => {
  let responseClosedResolve;
  const responseClosed = new Promise((resolve) => { responseClosedResolve = resolve; });
  const provider = await createProvider(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.once('close', responseClosedResolve);
    response.write(event({ choices: [{ delta: { content: 'first' }, finish_reason: null }] }));
  });
  const context = new TraceContext();
  const recorder = new RecordingRecorder();
  await runInTrace(context, recorder, 'trace-break', async () => {
    for await (const _chunk of clientFor(context, provider.baseUrl).stream({
      model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'go' }],
    })) break;
  });
  await Promise.race([
    responseClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('response body was not closed')), 1000)),
  ]);

  const span = aiSpan(recorder, 'trace-break');
  assert.equal(span.status, 'error');
  assert.equal(span.error.category, 'cancelled');
});

test('stream EOF without [DONE] is invalid even when content was already yielded', async (t) => {
  const provider = await createProvider(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(event({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] }));
  });
  const context = new TraceContext();
  const recorder = new RecordingRecorder();
  const yielded = [];

  await assert.rejects(runInTrace(context, recorder, 'trace-no-done', async () => {
    for await (const chunk of clientFor(context, provider.baseUrl).stream({
      model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'go' }],
    })) yielded.push(chunk);
  }), (error) => error instanceof AiAdapterError && error.category === 'invalid_response');

  assert.equal(yielded[0].content, 'partial');
  assert.equal(aiSpan(recorder, 'trace-no-done').error.category, 'invalid_response');
});

test('usage received before an EOF without [DONE] remains known on a failed partial span', async (t) => {
  const provider = await createProvider(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      event({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] })
      + event({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
    );
  });
  const context = new TraceContext();
  const recorder = new RecordingRecorder();
  const chunks = [];

  await assert.rejects(runInTrace(context, recorder, 'trace-usage-no-done', async () => {
    for await (const chunk of clientFor(context, provider.baseUrl).stream({
      model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'go' }],
    })) chunks.push(chunk);
  }), (error) => error instanceof AiAdapterError && error.category === 'invalid_response');

  assert.equal(chunks[0].content, 'partial');
  assert.deepEqual(chunks.find((chunk) => chunk.usage)?.usage, { input: 5, output: 2, total: 7 });
  const span = aiSpan(recorder, 'trace-usage-no-done');
  assert.equal(span.attributes['llm.usage_available'], true);
  assert.deepEqual(span.tokenUsage, { input: 5, output: 2, total: 7 });
  assert.equal(span.error.category, 'invalid_response');
  assert.equal(span.status, 'error');
});

test('HTTP status mapping and fixed content policy code never retain provider messages', async (t) => {
  const responses = [
    [401, { error: { code: 'invalid_api_key', message: 'provider-secret-401' } }, 'authentication'],
    [429, { error: { code: 'rate_limit_exceeded', message: 'provider-secret-429' } }, 'rate_limit'],
    [500, { error: { code: 'internal_error', message: 'provider-secret-500' } }, 'provider_error'],
    [400, { error: { code: 'content_policy_violation', message: 'provider-secret-filter' } }, 'content_filter'],
  ];
  const provider = await createProvider(t, async (_request, response, index) => {
    const [status, payload] = responses[index - 1];
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  const context = new TraceContext();
  const recorder = new RecordingRecorder();
  const client = clientFor(context, provider.baseUrl);

  for (const [index, [status, _payload, category]] of responses.entries()) {
    const traceId = `trace-http-${index}`;
    await assert.rejects(runInTrace(context, recorder, traceId, () => client.complete({
      model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'private-prompt-canary' }],
    })), (error) => error instanceof AiAdapterError
      && error.category === category && error.httpStatus === status
      && !error.message.includes('provider-secret') && error.cause === undefined);
    const span = aiSpan(recorder, traceId);
    assert.equal(span.error.category, category);
    assert(!JSON.stringify(span.attributes).includes('provider-secret'));
    assert(!JSON.stringify(span.attributes).includes('private-prompt-canary'));
  }
  assert.equal(provider.requests.length, responses.length);
});

test('provider SSE errors, malformed JSON, and invalid response shapes use safe fixed categories', async (t) => {
  const provider = await createProvider(t, async (_request, response, index) => {
    response.writeHead(200, { 'content-type': index === 1 ? 'text/event-stream' : 'application/json' });
    if (index === 1) response.end(event({ error: { message: 'sse-provider-secret' } }));
    else if (index === 2) response.end('{"choices":');
    else response.end(JSON.stringify({ model: 'gpt-4o-mini', choices: [] }));
  });
  const context = new TraceContext();
  const recorder = new RecordingRecorder();
  const client = clientFor(context, provider.baseUrl);

  for (const [index, streaming, category] of [
    [0, true, 'provider_error'],
    [1, false, 'invalid_response'],
    [2, false, 'invalid_response'],
  ]) {
    const traceId = `trace-malformed-${index}`;
    const operation = () => streaming
      ? (async () => { for await (const _chunk of client.stream({
        model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'secret-input' }],
      })) { /* consume */ } })()
      : client.complete({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'secret-input' }] });
    await assert.rejects(runInTrace(context, recorder, traceId, operation),
      (error) => error instanceof AiAdapterError && error.category === category
        && !error.message.includes('sse-provider-secret') && error.cause === undefined);
    const span = aiSpan(recorder, traceId);
    assert.equal(span.error.category, category);
    assert(!JSON.stringify(span.attributes).includes('secret'));
  }
});

test('timeout covers response body reads, and caller abort maps to cancelled', async (t) => {
  const slowProvider = await createProvider(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"choices":');
    setTimeout(() => { if (!response.destroyed) response.end('[]'); }, 350);
  });
  const timeoutContext = new TraceContext();
  const timeoutRecorder = new RecordingRecorder();
  const timedClient = clientFor(timeoutContext, slowProvider.baseUrl, 100);
  await assert.rejects(runInTrace(timeoutContext, timeoutRecorder, 'trace-timeout', () => timedClient.complete({
    model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'go' }],
  })), (error) => error instanceof AiAdapterError && error.category === 'timeout');
  assert.equal(aiSpan(timeoutRecorder, 'trace-timeout').error.category, 'timeout');

  const abortProvider = await createProvider(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"choices":');
    setTimeout(() => { if (!response.destroyed) response.end('[]'); }, 350);
  });
  const abortContext = new TraceContext();
  const abortRecorder = new RecordingRecorder();
  const controller = new AbortController();
  const pending = runInTrace(abortContext, abortRecorder, 'trace-abort', () => clientFor(
    abortContext, abortProvider.baseUrl, 2000,
  ).complete({
    model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'go' }], signal: controller.signal,
  }));
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, (error) => error instanceof AiAdapterError && error.category === 'cancelled');
  assert.equal(aiSpan(abortRecorder, 'trace-abort').error.category, 'cancelled');
});

test('deadline is checked after a yielded chunk and its first abort cause stays locked', async (t) => {
  const provider = await createProvider(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      event({ choices: [{ delta: { content: 'first' }, finish_reason: null }] })
      + 'data: [DONE]\n\n',
    );
  });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const timeoutContext = new TraceContext();
  const timeoutRecorder = new RecordingRecorder();
  await assert.rejects(runInTrace(timeoutContext, timeoutRecorder, 'trace-paused-timeout', async () => {
    for await (const _chunk of clientFor(timeoutContext, provider.baseUrl, 100).stream({
      model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'go' }],
    })) await wait(150);
  }), (error) => error instanceof AiAdapterError && error.category === 'timeout');
  assert.equal(aiSpan(timeoutRecorder, 'trace-paused-timeout').error.category, 'timeout');

  const cancelContext = new TraceContext();
  const cancelRecorder = new RecordingRecorder();
  const controller = new AbortController();
  await assert.rejects(runInTrace(cancelContext, cancelRecorder, 'trace-paused-cancel', async () => {
    for await (const _chunk of clientFor(cancelContext, provider.baseUrl, 100).stream({
      model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'go' }], signal: controller.signal,
    })) {
      setTimeout(() => controller.abort(), 20);
      await wait(150);
    }
  }), (error) => error instanceof AiAdapterError && error.category === 'cancelled');
  assert.equal(aiSpan(cancelRecorder, 'trace-paused-cancel').error.category, 'cancelled');
});

test('request, SSE frame, and total SSE byte limits reject without recording payloads', async (t) => {
  let requestCount = 0;
  const provider = await createProvider(t, (_request, response) => {
    requestCount += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requestCount === 1) {
      response.end(event({ choices: [{ delta: { content: 'x'.repeat(70 * 1024) }, finish_reason: null }] }));
      return;
    }
    const comment = `:${'x'.repeat(60 * 1024 - 1)}\n\n`;
    const repeats = Math.ceil((8 * 1024 * 1024 + 1) / Buffer.byteLength(comment));
    response.end(comment.repeat(repeats));
  });
  const context = new TraceContext();
  const recorder = new RecordingRecorder();
  const client = clientFor(context, provider.baseUrl);

  await assert.rejects(client.complete({
    model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }],
  }), (error) => error instanceof AiAdapterError && error.category === 'invalid_request');
  assert.equal(requestCount, 0);

  for (const [index, category] of [[0, 'invalid_response'], [1, 'invalid_response']]) {
    const traceId = `trace-size-${index}`;
    await assert.rejects(runInTrace(context, recorder, traceId, async () => {
      for await (const _chunk of client.stream({
        model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'go' }],
      })) { /* consume */ }
    }), (error) => error instanceof AiAdapterError && error.category === category);
    assert.equal(aiSpan(recorder, traceId).error.category, category);
  }
  assert.equal(requestCount, 2);
});
