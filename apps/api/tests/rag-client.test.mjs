import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import test from 'node:test';

const distRoot = resolve(process.env.API_TEST_DIST_DIR
  ?? fileURLToPath(new URL('../dist/', import.meta.url)));
const require = createRequire(join(distRoot, 'rag-client-test.cjs'));
const { QdrantRagClient } = require(join(distRoot, 'observability/rag.client.js'));
const { TraceContext } = require(join(distRoot, 'observability/trace-context.js'));
const { TraceRecorder } = require(join(distRoot, 'observability/trace-recorder.js'));
const { AiAdapterError } = require(join(distRoot, 'observability/ai-observation.js'));

const binding = {
  projectId: 'b35a64bb-8a12-4806-9e77-8831870a5dd0',
  service: 'api',
  environment: 'dev',
};
const traceId = 'trace_v1_01234567-89ab-cdef-0123-456789abcdef';

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function withServer(handler, run) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) json(response, 500, { error: 'test server failure' });
      else response.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
    });
  }
}

function makeTracing() {
  const events = [];
  const recorder = new TraceRecorder(binding, event => {
    events.push(event);
    return { accepted: true };
  });
  return { events, recorder, context: new TraceContext() };
}

function client(baseUrl, context, options = {}) {
  return new QdrantRagClient(context, {
    baseUrl,
    collection: 'trusted_collection-1',
    ...options,
  });
}

async function retrieveWithParent(tracing, ragClient, input) {
  const parent = tracing.recorder.start('http.server', traceId);
  const documents = await tracing.context.run(tracing.recorder, parent, () => ragClient.retrieve(input));
  const parentEvent = parent.end();
  return { documents, parentEvent };
}

function observationEvent(events, operation = 'rag.retrieve') {
  const event = events.find(candidate => candidate.operation === operation);
  assert(event, `missing ${operation} span`);
  return event;
}

test('sends Qdrant query points request and records only bounded opaque source metadata', async () => {
  const requestLog = [];
  const apiKey = 'api-key-canary-never-record-this';
  const pointId = 'private-file-id-canary';
  const payloadText = 'private-document-payload-canary';
  const vector = [0.125, -0.25, 0.5];

  await withServer(async (request, response) => {
    requestLog.push({
      method: request.method,
      url: request.url,
      apiKey: request.headers['api-key'],
      body: await readRequestBody(request),
    });
    json(response, 200, {
      result: { points: [{ id: pointId, score: 0.91, payload: { text: payloadText, file: 'secret.pdf' } }] },
      status: 'ok',
      time: 0.001,
    });
  }, async baseUrl => {
    const tracing = makeTracing();
    const ragClient = client(baseUrl, tracing.context, { apiKey });
    const { documents } = await retrieveWithParent(tracing, ragClient, { vector, topK: 2 });

    assert.deepEqual(requestLog, [{
      method: 'POST',
      url: '/collections/trusted_collection-1/points/query',
      apiKey,
      body: { query: vector, limit: 2, with_payload: true, with_vector: false },
    }]);
    assert.deepEqual(documents, [{
      id: pointId,
      score: 0.91,
      payload: { text: payloadText, file: 'secret.pdf' },
    }]);

    const outer = observationEvent(tracing.events);
    assert.equal(outer.status, 'ok');
    assert.equal(outer.attributes.topK, 2);
    assert.equal(outer.attributes['rag.recalled_count'], 1);
    assert.equal(outer.attributes['rag.empty'], false);
    assert.equal(typeof outer.attributes['rag.recall_ms'], 'number');
    assert.equal(Object.hasOwn(outer.attributes, 'rag.rerank_ms'), false);
    const expectedHash = createHash('sha256').update(pointId, 'utf8').digest('hex');
    assert.deepEqual(outer.attributes.sources, [expectedHash]);

    const spanWire = JSON.stringify(tracing.events);
    for (const canary of [apiKey, pointId, payloadText, 'secret.pdf']) {
      assert.equal(spanWire.includes(canary), false, `span included ${canary}`);
    }
    assert.equal(spanWire.includes('0.125'), false);
    assert.equal(observationEvent(tracing.events, 'rag.recall').parentSpanId, outer.spanId);
  });
});

test('validates topK and vector bounds before making a request', async () => {
  let requests = 0;
  await withServer((_request, response) => {
    requests += 1;
    json(response, 200, { result: { points: [] } });
  }, async baseUrl => {
    const ragClient = client(baseUrl, new TraceContext());
    for (const input of [
      { vector: [1], topK: 0 },
      { vector: [1], topK: 101 },
      { vector: [1], topK: 1.5 },
      { vector: [], topK: 1 },
      { vector: [Number.POSITIVE_INFINITY], topK: 1 },
      { vector: [Number.MAX_SAFE_INTEGER * 2], topK: 1 },
      { vector: Array(4_097).fill(0), topK: 1 },
    ]) {
      await assert.rejects(ragClient.retrieve(input), error =>
        error instanceof AiAdapterError && error.category === 'invalid_request');
    }
    assert.equal(requests, 0);
  });
});

test('timeout configuration matches the service integer bounds', () => {
  const validClient = () => client('https://qdrant.example.test', new TraceContext(), { timeoutMs: 100 });
  assert.doesNotThrow(validClient);
  for (const timeoutMs of [99, 120_001, 100.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => client('https://qdrant.example.test', new TraceContext(), { timeoutMs }), error =>
      error instanceof AiAdapterError && error.category === 'invalid_request');
  }
});

test('maps HTTP failures to safe categories without reading or recording error bodies', async () => {
  const bodyCanary = 'qdrant-private-error-body-canary';
  const apiKey = 'http-error-api-key-canary';
  await withServer((_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: bodyCanary }));
  }, async baseUrl => {
    const tracing = makeTracing();
    const ragClient = client(baseUrl, tracing.context, { apiKey });
    const parent = tracing.recorder.start('http.server', traceId);
    await assert.rejects(
      tracing.context.run(tracing.recorder, parent, () => ragClient.retrieve({ vector: [1], topK: 1 })),
      error => error instanceof AiAdapterError
        && error.category === 'rate_limit'
        && error.httpStatus === 429,
    );
    parent.end();
    const outer = observationEvent(tracing.events);
    assert.equal(outer.status, 'error');
    assert.equal(outer.attributes['ai.error_category'], 'rate_limit');
    const spanWire = JSON.stringify(tracing.events);
    assert.equal(spanWire.includes(bodyCanary), false);
    assert.equal(spanWire.includes(apiKey), false);
  });
});

test('rejects malformed and duplicate Qdrant point IDs with a bounded safe error', async () => {
  const cases = [
    { points: [{ id: 'duplicate-id', score: 1 }, { id: 'duplicate-id', score: 0.5 }] },
    { points: [{ id: { unexpected: true }, score: 1 }] },
    { points: [{ id: 'bad-score', score: null }] },
    { points: [{ id: 'bad-payload', score: 1, payload: [] }] },
    { points: [{ id: 'over-limit', score: 1 }, { id: 'extra', score: 0.5 }] },
  ];
  await withServer(async (_request, response) => {
    const item = cases.shift();
    json(response, 200, { result: { points: item.points } });
  }, async baseUrl => {
    const ragClient = client(baseUrl, new TraceContext());
    for (const _case of [0, 1, 2, 3, 4]) {
      await assert.rejects(ragClient.retrieve({ vector: [1], topK: 1 }), error =>
        error instanceof AiAdapterError && error.category === 'invalid_response');
    }
  });
});

test('empty recall succeeds and records an empty result', async () => {
  await withServer((_request, response) => json(response, 200, { result: { points: [] } }), async baseUrl => {
    const tracing = makeTracing();
    const { documents } = await retrieveWithParent(tracing, client(baseUrl, tracing.context), {
      vector: [0.4],
      topK: 5,
    });
    assert.deepEqual(documents, []);
    const outer = observationEvent(tracing.events);
    assert.equal(outer.status, 'ok');
    assert.equal(outer.attributes['rag.recalled_count'], 0);
    assert.equal(outer.attributes['rag.empty'], true);
    assert.deepEqual(outer.attributes.sources, []);
  });
});

test('nullable point payload is absent while unsafe numeric and empty IDs are rejected', async () => {
  let points = [{ id: 42, score: 0.5, payload: null }];
  await withServer((_request, response) => json(response, 200, { result: { points } }), async baseUrl => {
    const ragClient = client(baseUrl, new TraceContext());
    assert.deepEqual(await ragClient.retrieve({ vector: [1], topK: 1 }), [{ id: 42, score: 0.5 }]);
    for (const id of ['', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      points = [{ id, score: 0.5 }];
      await assert.rejects(ragClient.retrieve({ vector: [1], topK: 1 }), error => error.category === 'invalid_response');
    }
  });
});

test('rerank callback runs in its child span, may reorder or select points, and retains payload', async () => {
  const pointA = { id: 'rerank-id-a', score: 0.9, payload: { text: 'payload-a' } };
  const pointB = { id: 27, score: 0.8, payload: { text: 'payload-b' } };
  await withServer((_request, response) => json(response, 200, {
    result: { points: [pointA, pointB] },
  }), async baseUrl => {
    const tracing = makeTracing();
    let callbackSignal;
    const { documents } = await retrieveWithParent(tracing, client(baseUrl, tracing.context), {
      vector: [0.4],
      topK: 2,
      rerank: async (before, signal) => {
        callbackSignal = signal;
        return [{ ...before[1], score: 0.99 }, { ...before[0], score: 0.7 }];
      },
    });

    assert(callbackSignal instanceof AbortSignal);
    assert.deepEqual(documents, [
      { id: 27, score: 0.99, payload: { text: 'payload-b' } },
      { id: 'rerank-id-a', score: 0.7, payload: { text: 'payload-a' } },
    ]);
    const outer = observationEvent(tracing.events);
    const rerank = observationEvent(tracing.events, 'rag.rerank');
    assert.equal(rerank.parentSpanId, outer.spanId);
    assert.equal(typeof outer.attributes['rag.rerank_ms'], 'number');
    assert(Number.isFinite(outer.attributes['rag.rerank_ms']));
    assert(outer.attributes['rag.rerank_ms'] >= 0);
    assert.deepEqual(outer.attributes['rag.rerank_before'].items.map(item => item.rank), [1, 2]);
    assert.deepEqual(outer.attributes['rag.rerank_after'].items.map(item => item.rank), [1, 2]);
    assert.deepEqual(outer.attributes['rag.rerank_after'].items.map(item => item.score), [0.99, 0.7]);
    const wire = JSON.stringify(tracing.events);
    assert.equal(wire.includes('rerank-id-a'), false);
    assert.equal(wire.includes('payload-a'), false);
  });
});

test('topK 100 retains all required telemetry within the recorder attribute budget', async () => {
  const points = Array.from({ length: 100 }, (_, index) => ({
    id: `budget-doc-${index}`,
    score: 1 - index / 100,
    payload: { privateText: `payload-${index}` },
  }));
  await withServer((_request, response) => json(response, 200, {
    result: { points },
  }), async baseUrl => {
    const tracing = makeTracing();
    const { documents } = await retrieveWithParent(tracing, client(baseUrl, tracing.context), {
      vector: [0.1, 0.2],
      topK: 100,
      rerank: async recalled => recalled,
    });
    assert.equal(documents.length, 100);

    const outer = observationEvent(tracing.events);
    const attributes = outer.attributes;
    assert.equal(attributes.topK, 100);
    assert.equal(attributes['rag.recalled_count'], 100);
    assert.equal(attributes['rag.empty'], false);
    assert.equal(typeof attributes['rag.recall_ms'], 'number');
    assert.equal(typeof attributes['rag.rerank_ms'], 'number');
    assert.equal(attributes.sources.length, 100);
    assert(attributes.sources.every(hash => /^[a-f0-9]{64}$/.test(hash)));
    assert.equal(attributes['rag.rerank_before'].items.length, 20);
    assert.equal(attributes['rag.rerank_before'].total_count, 100);
    assert.equal(attributes['rag.rerank_before'].truncated, true);
    assert.equal(attributes['rag.rerank_after'].items.length, 20);
    assert.equal(attributes['rag.rerank_after'].total_count, 100);
    assert.equal(attributes['rag.rerank_after'].truncated, true);
    assert(Buffer.byteLength(JSON.stringify(attributes), 'utf8') < 16 * 1024);
    assert.equal(JSON.stringify(tracing.events).includes('budget-doc-0'), false);
  });
});

test('rejects rerank fabricated IDs, duplicates, and malformed documents', async () => {
  const invalidResults = [
    documents => [{ id: 'fabricated-rerank-id', score: 1 }],
    documents => [documents[0], documents[0]],
    documents => [{ id: documents[0].id, score: 'not-a-score' }],
    documents => [{ id: documents[0].id, score: 1, payload: null }],
  ];
  await withServer((_request, response) => json(response, 200, {
    result: { points: [{ id: 'only-valid-id', score: 0.5, payload: { text: 'private' } }] },
  }), async baseUrl => {
    const ragClient = client(baseUrl, new TraceContext());
    for (const rerank of invalidResults) {
      await assert.rejects(ragClient.retrieve({ vector: [1], topK: 1, rerank }), error =>
        error instanceof AiAdapterError && error.category === 'invalid_response');
    }
  });
});

test('callback exceptions are safe provider errors and never enter span attributes', async () => {
  const callbackCanary = 'raw-rerank-exception-canary';
  await withServer((_request, response) => json(response, 200, {
    result: { points: [{ id: 'safe-id', score: 1 }] },
  }), async baseUrl => {
    const tracing = makeTracing();
    const ragClient = client(baseUrl, tracing.context);
    const parent = tracing.recorder.start('http.server', traceId);
    await assert.rejects(
      tracing.context.run(tracing.recorder, parent, () => ragClient.retrieve({
        vector: [1],
        topK: 1,
        rerank: async () => { throw new Error(callbackCanary); },
      })),
      error => error instanceof AiAdapterError && error.category === 'provider_error',
    );
    parent.end();
    const outer = observationEvent(tracing.events);
    assert.equal(outer.attributes['ai.error_category'], 'provider_error');
    assert.equal(typeof outer.attributes['rag.rerank_ms'], 'number');
    assert(Number.isFinite(outer.attributes['rag.rerank_ms']));
    assert(outer.attributes['rag.rerank_ms'] >= 0);
    assert.equal(JSON.stringify(tracing.events).includes(callbackCanary), false);
  });
});

test('deadline bounds an incomplete provider JSON body', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"result":');
  }, async baseUrl => {
    const ragClient = client(baseUrl, new TraceContext(), { timeoutMs: 100 });
    const startedAt = Date.now();
    await assert.rejects(ragClient.retrieve({ vector: [1], topK: 1 }), error =>
      error instanceof AiAdapterError && error.category === 'timeout');
    assert(Date.now() - startedAt < 1_500);
  });
});

test('deadline bounds rerank callbacks that ignore their abort signal', async () => {
  await withServer((_request, response) => json(response, 200, {
    result: { points: [{ id: 'timeout-id', score: 1 }] },
  }), async baseUrl => {
    const ragClient = client(baseUrl, new TraceContext(), { timeoutMs: 100 });
    let callbackSignal;
    const startedAt = Date.now();
    await assert.rejects(ragClient.retrieve({
      vector: [1],
      topK: 1,
      rerank: (_documents, signal) => {
        callbackSignal = signal;
        return new Promise(() => {});
      },
    }), error => error instanceof AiAdapterError && error.category === 'timeout');
    assert(Date.now() - startedAt < 1_500);
    assert.equal(callbackSignal.aborted, true);
  });
});

test('redirects are rejected instead of followed', async () => {
  let requests = 0;
  await withServer((request, response) => {
    requests += 1;
    if (request.url === '/collections/trusted_collection-1/points/query') {
      response.writeHead(302, { location: '/redirect-target' });
      response.end();
    } else {
      json(response, 200, { result: { points: [] } });
    }
  }, async baseUrl => {
    const ragClient = client(baseUrl, new TraceContext());
    await assert.rejects(ragClient.retrieve({ vector: [1], topK: 1 }), error =>
      error instanceof AiAdapterError && error.category === 'network_error');
    assert.equal(requests, 1);
  });
});

test('tracing off still performs the real retrieval', async () => {
  await withServer((_request, response) => json(response, 200, {
    result: { points: [{ id: 'off-mode-id', score: 0.75, payload: { keep: true } }] },
  }), async baseUrl => {
    const ragClient = client(baseUrl, new TraceContext());
    assert.deepEqual(await ragClient.retrieve({ vector: [0.75], topK: 1 }), [
      { id: 'off-mode-id', score: 0.75, payload: { keep: true } },
    ]);
  });
});

test('concurrent requests remain under their own parent trace trees', async () => {
  const pending = [];
  await withServer(async (request, response) => {
    const body = await readRequestBody(request);
    pending.push({ response, id: body.query[0] === 1 ? 'tree-one-id' : 'tree-two-id' });
    if (pending.length === 2) {
      for (const item of pending) json(item.response, 200, {
        result: { points: [{ id: item.id, score: 1 }] },
      });
    }
  }, async baseUrl => {
    const tracing = makeTracing();
    const ragClient = client(baseUrl, tracing.context);
    const parentOne = tracing.recorder.start('http.server', traceId);
    const parentTwo = tracing.recorder.start('http.server', traceId);
    const results = await Promise.all([
      tracing.context.run(tracing.recorder, parentOne, () => ragClient.retrieve({ vector: [1], topK: 1 })),
      tracing.context.run(tracing.recorder, parentTwo, () => ragClient.retrieve({ vector: [2], topK: 1 })),
    ]);
    const parentEvents = [parentOne.end(), parentTwo.end()];
    assert.deepEqual(results.map(documents => documents[0].id).sort(), ['tree-one-id', 'tree-two-id']);

    const outerEvents = tracing.events.filter(event => event.operation === 'rag.retrieve');
    const recallEvents = tracing.events.filter(event => event.operation === 'rag.recall');
    assert.equal(outerEvents.length, 2);
    assert.equal(recallEvents.length, 2);
    const parentIds = new Set(parentEvents.map(event => event.spanId));
    for (const outer of outerEvents) assert(parentIds.has(outer.parentSpanId));
    for (const recall of recallEvents) {
      const outer = outerEvents.find(event => event.spanId === recall.parentSpanId);
      assert(outer);
      assert(parentIds.has(outer.parentSpanId));
    }
  });
});
