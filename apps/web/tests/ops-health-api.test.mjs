import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

function loadTypeScriptModule(source, importReplacements = {}) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  let runnableOutput = outputText;
  for (const [specifier, replacement] of Object.entries(importReplacements)) {
    runnableOutput = runnableOutput.replaceAll(`'${specifier}'`, `'${replacement}'`);
  }
  return import(`data:text/javascript;base64,${Buffer.from(runnableOutput).toString('base64')}`);
}

const opsApi = await readFile(new URL('../src/ops-health-api.ts', import.meta.url), 'utf8')
  .then((source) => loadTypeScriptModule(source));

function health(overrides = {}) {
  return {
    status: 'healthy',
    checkedAt: '2026-10-03T04:05:06.123Z',
    processUptimeSeconds: 3600.5,
    postgres: { status: 'healthy', latencyMs: 1.75 },
    kafka: {
      status: 'degraded',
      topic: 'ai-spans',
      consumerGroup: 'trace-ops-collector',
      totalLag: 4,
      partitions: [{ partition: 0, lag: 4 }, { partition: 1, lag: null }],
    },
    collector: {
      status: 'running',
      topic: 'ai-spans',
      consumerGroup: 'trace-ops-collector',
      uptimeSeconds: 120,
      processedMessages: 400,
      insertedSpans: 392,
      invalidMessages: 2,
      failedBatches: 1,
      clickhouseWriteFailures: 1,
      committedBatches: 18,
      lastCommitAt: '2026-10-03T04:05:00Z',
      lastClickHouseWriteAt: null,
    },
    clickhouse: {
      status: 'healthy',
      pingLatencyMs: 3.2,
      queryLatency: { windowSeconds: 300, sampleCount: 12, errorCount: 1, p50Ms: 5, p95Ms: 21.5, p99Ms: null },
    },
    spanQueue: {
      producerState: 'ready', depth: 2, capacity: 64, queueBytes: 64, maxQueueBytes: 10_000,
      accepted: 50, published: 48, dropped: 0, publishErrors: 1, retries: 2,
    },
    ...overrides,
  };
}

test('strictly parses the platform-wide response and preserves explicitly unknown measurements', () => {
  const source = health({
    postgres: { status: 'unavailable', latencyMs: null },
    kafka: { ...health().kafka, totalLag: null },
    collector: {
      ...health().collector,
      status: 'unavailable', uptimeSeconds: null, processedMessages: null,
      insertedSpans: null, invalidMessages: null, failedBatches: null,
      clickhouseWriteFailures: null, committedBatches: null, lastCommitAt: null,
    },
    clickhouse: {
      status: 'unavailable', pingLatencyMs: null,
      queryLatency: { windowSeconds: 300, sampleCount: 0, errorCount: 0, p50Ms: null, p95Ms: null, p99Ms: null },
    },
  });

  const parsed = opsApi.parseOpsHealthResponse(source);
  assert.equal(parsed.postgres.latencyMs, null);
  assert.equal(parsed.kafka.totalLag, null);
  assert.equal(parsed.kafka.partitions[1].lag, null);
  assert.equal(parsed.collector.processedMessages, null);
  assert.equal(parsed.collector.lastCommitAt, null);
  assert.equal(parsed.clickhouse.queryLatency.p95Ms, null);
  assert.equal(parsed.clickhouse.queryLatency.windowSeconds, 300);
  assert.equal(parsed.spanQueue.queueBytes, 64);
  assert.equal(parsed.spanQueue.maxQueueBytes, 10_000);
  assert.deepEqual(parsed, source);
});

test('accepts the current exact response when byte metrics are not yet projected and reports them as unknown', () => {
  const currentApiResponse = health();
  delete currentApiResponse.spanQueue.queueBytes;
  delete currentApiResponse.spanQueue.maxQueueBytes;

  const parsed = opsApi.parseOpsHealthResponse(currentApiResponse);
  assert.equal(parsed.spanQueue.queueBytes, null);
  assert.equal(parsed.spanQueue.maxQueueBytes, null);
});

test('rejects unknown fields, malformed nested shapes, unsafe identifiers, and invalid measurements', () => {
  const cases = [
    health({ projectId: 'must-not-be-project-scoped' }),
    { ...health(), postgres: { status: 'healthy', latencyMs: 2, url: 'postgres://secret' } },
    { ...health(), kafka: { ...health().kafka, topic: 'https://user:secret@example.test' } },
    { ...health(), checkedAt: '2026-02-30T04:05:06Z' },
    { ...health(), checkedAt: '2026-10-03T25:05:06Z' },
    { ...health(), processUptimeSeconds: Number.POSITIVE_INFINITY },
    { ...health(), postgres: { status: 'degraded', latencyMs: -1 } },
    { ...health(), kafka: { ...health().kafka, totalLag: 1.5 } },
    { ...health(), kafka: { ...health().kafka, partitions: [{ partition: -1, lag: 0 }] } },
    { ...health(), collector: { ...health().collector, failedBatches: 2.25 } },
    { ...health(), clickhouse: { ...health().clickhouse, queryLatency: { ...health().clickhouse.queryLatency, windowSeconds: 60 } } },
    { ...health(), spanQueue: { ...health().spanQueue, retries: -1 } },
    { ...health(), spanQueue: { ...health().spanQueue, queueBytes: -1 } },
    { ...health(), spanQueue: { ...health().spanQueue, maxQueueBytes: 1.5 } },
    { ...health(), spanQueue: { ...health().spanQueue, queueBytes: '64' } },
    { ...health(), spanQueue: { ...health().spanQueue, queueBytes: 64, unrecognized: 1 } },
  ];
  const legacyQueue = { ...health().spanQueue };
  delete legacyQueue.queueBytes;
  cases.push({ ...health(), spanQueue: legacyQueue });
  for (const payload of cases) assert.throws(() => opsApi.parseOpsHealthResponse(payload), opsApi.OpsHealthPayloadError);
});

test('fetches the exact same-origin admin path as GET without query, body, or browser credential', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { input, init };
    return new Response(JSON.stringify(health()), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await opsApi.fetchOpsHealth();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(request.input, '/api/v1/ops/health');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.cache, 'no-store');
  assert.equal('body' in request.init, false);
  assert.equal(new URL(request.input, 'http://localhost').search, '');
  assert.deepEqual(request.init.headers, { accept: 'application/json' });
  assert.equal(Object.hasOwn(request.init.headers, 'authorization'), false);
});

test('bounds slow health requests and reports only a safe timeout error', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('transport detail', 'AbortError')), { once: true });
  });
  globalThis.setTimeout = ((callback, delay, ...args) => {
    assert.equal(delay, 12_000);
    return originalSetTimeout(callback, 0, ...args);
  });
  try {
    await assert.rejects(
      opsApi.fetchOpsHealth(),
      (error) => error instanceof opsApi.OpsHealthHttpError
        && error.statusCode === 504
        && opsApi.opsHealthErrorMessage(error) === '健康检查等待超时，将在稍后自动重试。',
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('propagates page cancellation to the in-flight health request', async () => {
  const originalFetch = globalThis.fetch;
  const abortController = new AbortController();
  let observedAbort = false;
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      observedAbort = true;
      reject(new DOMException('transport detail', 'AbortError'));
    }, { once: true });
  });
  try {
    const request = opsApi.fetchOpsHealth(abortController.signal);
    abortController.abort();
    await assert.rejects(request, { name: 'AbortError' });
    assert.equal(observedAbort, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normalizes HTTP and payload errors without exposing upstream details', () => {
  assert.equal(
    opsApi.opsHealthErrorMessage(new opsApi.OpsHealthHttpError(403)),
    '本地平台管理员查询未通过授权检查。',
  );
  assert.equal(
    opsApi.opsHealthErrorMessage(new opsApi.OpsHealthHttpError(504)),
    '健康检查等待超时，将在稍后自动重试。',
  );
  assert.equal(
    opsApi.opsHealthErrorMessage(new Error('password=do-not-render')),
    '无法连接平台健康查询接口，请检查本地 API 服务后重试。',
  );
  assert.doesNotMatch(opsApi.opsHealthErrorMessage(new Error('postgres://secret')), /secret|postgres/i);
});
