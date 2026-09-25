import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SpanIngestService } = require('../dist/spans/span-ingest.service.js');
const { SpansController } = require('../dist/spans/spans.controller.js');
const { BoundedSpanQueue } = require('../dist/spans/bounded-span-queue.js');
const { AdminTokenGuard } = require('../dist/admin/admin-token.guard.js');
const { GUARDS_METADATA } = require('@nestjs/common/constants');

const projectId = 'b35a64bb-8a12-4806-9e77-8831870a5dd0';
const forgedProjectId = 'e48b6b53-d508-45d7-ad43-f2d34d17e689';

function makeKey() {
  return `tr_${randomBytes(32).toString('base64url')}`;
}

function makeSpan(overrides = {}) {
  return {
    traceId: 'trace_v1_01234567-89ab-cdef-0123-456789abcdef',
    spanId: 'span-1',
    service: 'api',
    operation: 'http.server',
    startTime: 1_790_280_000_000,
    endTime: 1_790_280_000_025,
    status: 'ok',
    attributes: {},
    ...overrides,
  };
}

function makeRequest(projectKey, spans = [makeSpan()], overrides = {}) {
  return { projectKey, environment: 'dev', spans, ...overrides };
}

function makeHarness(overrides = {}) {
  const key = overrides.key ?? makeKey();
  const candidate = {
    key_id: '2195c20c-a0b8-47bb-bfd3-1b181fd9d66f',
    project_id: projectId,
    key_hash: createHash('sha256').update(key).digest('hex'),
    scopes: ['spans:write'],
    revoked_at: null,
    project_status: 'active',
    ...overrides.candidate,
  };
  const queries = [];
  const database = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes('FROM project_keys pk')) return { rows: [candidate], rowCount: 1 };
      if (sql.includes('FROM services')) {
        const names = overrides.registeredServices ?? ['api'];
        return { rows: names.map((name) => ({ name })), rowCount: names.length };
      }
      if (sql.includes('UPDATE project_keys')) {
        return { rows: [{ id: candidate.key_id }], rowCount: 1 };
      }
      throw new Error('Unexpected database statement');
    },
  };
  const published = [];
  const queue = overrides.queue ?? {
    enqueue(events) {
      published.push(...events);
      return {
        accepted: true,
        acceptedSpans: events.length,
        droppedSpans: 0,
        queueDepth: events.length,
        producerState: 'idle',
      };
    },
    metrics() { return { queueDepth: 0 }; },
  };
  return {
    key,
    candidate,
    queries,
    published,
    queue,
    service: new SpanIngestService(database, queue),
  };
}

async function assertHttpStatus(promise, status) {
  await assert.rejects(promise, (error) => error.getStatus() === status);
}

test('校验 W1 请求并注入服务端 projectId/schemaVersion/environment，属性脱敏后排队', async () => {
  const harness = makeHarness();
  const secret = 'private prompt and credential';
  const result = await harness.service.ingest(makeRequest(harness.key, [makeSpan({
    projectId: forgedProjectId,
    schemaVersion: 73,
    error: secret,
    attributes: {
      prompt: secret,
      model: 'model-x',
      nested: { apiKey: 'api-secret', visible: 'kept' },
    },
  })]));

  assert.deepEqual({
    status: result.status,
    delivery: result.delivery,
    durability: result.durability,
    acceptedSpans: result.acceptedSpans,
  }, {
    status: 'queued',
    delivery: 'queued_in_memory',
    durability: 'best_effort',
    acceptedSpans: 1,
  });
  assert.equal(harness.published.length, 1);
  assert.equal(harness.published[0].projectId, projectId);
  assert.notEqual(harness.published[0].projectId, forgedProjectId);
  assert.equal(harness.published[0].schemaVersion, 1);
  assert.equal(harness.published[0].environment, 'dev');
  assert.equal('projectKey' in harness.published[0], false);
  assert.deepEqual(harness.published[0].attributes, { model: 'model-x', nested: { visible: 'kept' } });
  assert.equal(JSON.stringify(harness.published).includes(secret), false);
  assert.equal(harness.published[0].error, undefined);
  assert.equal(JSON.stringify(harness.published).includes('api-secret'), false);
  assert.equal(JSON.stringify(harness.published).includes(harness.key), false);
  assert.equal(JSON.stringify(harness.published).includes('projectKey'), false);
  const keyLookup = harness.queries.find(({ sql }) => sql.includes('FROM project_keys pk'));
  assert.deepEqual(keyLookup.values, [harness.key.slice(0, 11)]);
});

test('拒绝不符合严格外层契约或超过 500 条的请求，错误不回显 body', async () => {
  const harness = makeHarness();
  const sentinel = 'body-secret-that-must-not-be-echoed';
  await assertHttpStatus(
    harness.service.ingest(makeRequest(harness.key, [makeSpan()], { projectId: sentinel })),
    400,
  );
  await assertHttpStatus(
    harness.service.ingest(makeRequest(harness.key, Array.from({ length: 501 }, (_, i) => makeSpan({ spanId: `s-${i}` })))),
    400,
  );
  await assertHttpStatus(
    harness.service.ingest(makeRequest(harness.key, [makeSpan({ endTime: 0, error: sentinel })])),
    400,
  );
  assert.equal(harness.queries.length, 0);
  await assert.rejects(
    harness.service.ingest(makeRequest(harness.key, [makeSpan({ endTime: 0, error: sentinel })])),
    (error) => {
      assert.equal(JSON.stringify(error.response).includes(sentinel), false);
      return true;
    },
  );
});

test('错误密钥、撤销密钥、缺少 spans:write Scope、非 active 项目均 fail closed', async (t) => {
  const cases = [
    ['错误密钥', (harness) => { harness.candidate.key_hash = createHash('sha256').update(makeKey()).digest('hex'); }],
    ['已撤销密钥', (harness) => { harness.candidate.revoked_at = new Date(); }],
    ['缺少写入 Scope', (harness) => { harness.candidate.scopes = ['traces:read']; }],
    ['已停用项目', (harness) => { harness.candidate.project_status = 'disabled'; }],
  ];
  for (const [name, setup] of cases) {
    await t.test(name, async () => {
      const harness = makeHarness();
      setup(harness);
      await assertHttpStatus(harness.service.ingest(makeRequest(harness.key)), 401);
      assert.equal(harness.published.length, 0);
    });
  }
});

test('环境或服务未在该项目注册时拒绝整批 Span', async () => {
  const harness = makeHarness({ registeredServices: [] });
  await assertHttpStatus(harness.service.ingest(makeRequest(harness.key)), 400);
  assert.equal(harness.published.length, 0);
  assert.equal(harness.queries.find(({ sql }) => sql.includes('FROM services')).values[1], 'dev');
});

test('密钥候选按前缀查询且数据库错误不会泄露底层信息', async () => {
  const key = makeKey();
  const service = new SpanIngestService({
    async query() { throw new Error(`database error included ${key}`); },
  }, { enqueue() { throw new Error('must not enqueue'); }, metrics() { return {}; } });
  await assert.rejects(service.ingest(makeRequest(key)), (error) => {
    assert.equal(error.getStatus(), 503);
    assert.equal(JSON.stringify(error.response).includes(key), false);
    assert.doesNotMatch(error.message, /database error included/);
    return true;
  });
});

test('真实队列满时整批拒绝并返回 503，body 与 projectKey 不进入事件/响应', async () => {
  let unblockSend;
  let signalSendStarted;
  const sendStarted = new Promise((resolve) => { signalSendStarted = resolve; });
  const sendGate = new Promise((resolve) => { unblockSend = resolve; });
  const producer = {
    async connect() {},
    async send() { signalSendStarted(); await sendGate; },
    async disconnect() {},
  };
  const queue = new BoundedSpanQueue({
    topic: 'ai-spans',
    brokers: ['localhost:9092'],
    producerFactory: () => producer,
    maxQueueSpans: 1,
  });
  const harness = makeHarness({ queue });
  const controller = new SpansController(harness.service);
  const responseFor = () => ({ code: 0, status(code) { this.code = code; return this; } });

  const firstResponse = responseFor();
  const first = await controller.ingest(
    makeRequest(harness.key),
    { traceId: 'trace_v1_queue_first' },
    firstResponse,
  );
  assert.equal(firstResponse.code, 202);
  assert.equal(first.delivery, 'queued_in_memory');
  await sendStarted;

  const secondResponse = responseFor();
  const second = await controller.ingest(
    makeRequest(harness.key, [makeSpan({ spanId: 'span-2' })]),
    { traceId: 'trace_v1_queue_second' },
    secondResponse,
  );
  assert.equal(secondResponse.code, 503);
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason, 'queue_full');
  assert.equal(second.acceptedSpans, 0);
  assert.equal(second.droppedSpans, 1);
  assert.equal(queue.metrics().droppedSpans, 1);
  assert.equal(JSON.stringify(second).includes(harness.key), false);
  assert.equal(JSON.stringify(second).includes('projectKey'), false);

  unblockSend();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await queue.close();
});

test('status 汇总 Schema/服务环境拒绝次数，仅保留固定 reason、middleware traceId 与 timestamp', async () => {
  const requestKey = makeKey();
  const privateText = 'do-not-store-this-body-or-error';
  const harness = makeHarness({ registeredServices: [] });
  const controller = new SpansController(harness.service);
  const responseFor = () => ({ status() { return this; } });

  await assertHttpStatus(controller.ingest(
    makeRequest(requestKey, [makeSpan({ error: privateText })], { extra: privateText }),
    { traceId: 'trace_v1_schema_rejected' },
    responseFor(),
  ), 400);
  const afterSchemaFailure = controller.status();
  assert.equal(afterSchemaFailure.rejectedInvalidBatchCount, 1);
  assert.deepEqual(afterSchemaFailure.lastInvalidBatchRejection, {
    reasonCode: 'invalid_request_schema',
    requestTraceId: 'trace_v1_schema_rejected',
    timestamp: afterSchemaFailure.lastInvalidBatchRejection.timestamp,
  });
  assert.ok(Number.isFinite(Date.parse(afterSchemaFailure.lastInvalidBatchRejection.timestamp)));

  await assertHttpStatus(controller.ingest(
    makeRequest(harness.key, [makeSpan({ error: privateText })]),
    { traceId: 'trace_v1_service_rejected' },
    responseFor(),
  ), 400);
  const afterServiceFailure = controller.status();
  assert.equal(afterServiceFailure.rejectedInvalidBatchCount, 2);
  assert.deepEqual(afterServiceFailure.lastInvalidBatchRejection, {
    reasonCode: 'service_environment_unregistered',
    requestTraceId: 'trace_v1_service_rejected',
    timestamp: afterServiceFailure.lastInvalidBatchRejection.timestamp,
  });
  assert.equal(JSON.stringify(afterServiceFailure).includes(requestKey), false);
  assert.equal(JSON.stringify(afterServiceFailure).includes(privateText), false);
  assert.equal(JSON.stringify(afterServiceFailure).includes('Span.error'), false);
  const guards = Reflect.getMetadata(GUARDS_METADATA, SpansController.prototype.status);
  assert.ok(guards.includes(AdminTokenGuard));
});

test('Kafka 不可用時 API 不等待发送：只确认内存排队，失败后暴露 drop/error 计数', async () => {
  let connectAttempts = 0;
  const queue = new BoundedSpanQueue({
    topic: 'ai-spans',
    brokers: ['unavailable:9092'],
    producerFactory: () => ({
      async connect() { connectAttempts += 1; throw new Error('broker details must not escape'); },
      async send() { throw new Error('send must not be reached'); },
      async disconnect() {},
    }),
    maxRetries: 1,
    retryDelayMs: 1,
  });
  const harness = makeHarness({ queue });
  const started = Date.now();
  const result = await harness.service.ingest(makeRequest(harness.key));

  assert.ok(Date.now() - started < 100);
  assert.equal(result.status, 'queued');
  assert.equal(result.delivery, 'queued_in_memory');
  assert.equal(result.durability, 'best_effort');
  assert.equal(result.producerState, 'idle');
  assert.equal(JSON.stringify(result).includes(harness.key), false);
  await new Promise((resolve) => {
    const startedWaiting = Date.now();
    const poll = () => {
      if (queue.metrics().queueDepth === 0) return resolve();
      if (Date.now() - startedWaiting > 1_000) throw new Error('Kafka failure was not bounded');
      setTimeout(poll, 2);
    };
    poll();
  });

  assert.equal(connectAttempts, 2);
  assert.equal(queue.metrics().publishedSpans, 0);
  assert.equal(queue.metrics().publishErrorCount, 2);
  assert.equal(queue.metrics().retryCount, 1);
  assert.equal(queue.metrics().droppedSpans, 1);
  assert.equal(queue.metrics().producerState, 'unavailable');
  await queue.close();
});
