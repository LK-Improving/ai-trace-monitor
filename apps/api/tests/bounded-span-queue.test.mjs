import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BoundedSpanQueue } = require('../dist/spans/bounded-span-queue.js');

function makeEvent(id = 'span-1', traceId = 'trace_v1_01234567-89ab-cdef-0123-456789abcdef') {
  return {
    schemaVersion: 1,
    projectId: 'b35a64bb-8a12-4806-9e77-8831870a5dd0',
    environment: 'dev',
    traceId,
    spanId: id,
    service: 'api',
    operation: 'http.server',
    startTime: 1_790_280_000_000,
    endTime: 1_790_280_000_025,
    status: 'ok',
    attributes: {},
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for queue state');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function fakeProducer(overrides = {}) {
  return {
    connect: async () => {},
    send: async () => {},
    disconnect: async () => {},
    ...overrides,
  };
}

test('producer 惰性创建、消息以 traceId 为 Kafka key，并只发送事件内容', async () => {
  const sent = [];
  let factories = 0;
  const producer = fakeProducer({ async send(value) { sent.push(value); } });
  const queue = new BoundedSpanQueue({
    topic: 'ai-spans',
    brokers: ['localhost:9092'],
    producerFactory() { factories += 1; return producer; },
  });

  const traceId = 'trace_v1_abcdef01-2345-6789-abcd-ef0123456789';
  const event = makeEvent('span-a', traceId);
  assert.equal(factories, 0);
  const accepted = queue.enqueue([event]);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.producerState, 'idle');
  await waitFor(() => queue.metrics().queueDepth === 0);

  assert.equal(factories, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].topic, 'ai-spans');
  assert.equal(sent[0].messages[0].key, traceId);
  assert.deepEqual(JSON.parse(sent[0].messages[0].value), event);
  assert.equal(queue.metrics().publishedSpans, 1);
  await queue.close();
  assert.equal(queue.metrics().producerState, 'closed');
});

test('队列按 Span 数严格限流，超限整批拒绝并计数', async () => {
  const sendGate = deferred();
  const enteredSend = deferred();
  const producer = fakeProducer({
    async send() { enteredSend.resolve(); await sendGate.promise; },
  });
  const queue = new BoundedSpanQueue({
    topic: 'ai-spans',
    brokers: ['localhost:9092'],
    producerFactory: () => producer,
    maxQueueSpans: 1,
  });

  assert.equal(queue.enqueue([makeEvent('one')]).accepted, true);
  await enteredSend.promise;
  const rejected = queue.enqueue([makeEvent('two')]);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'queue_full');
  assert.equal(rejected.droppedSpans, 1);
  assert.equal(queue.metrics().queueDepth, 1);
  assert.equal(queue.metrics().droppedSpans, 1);
  assert.equal(queue.metrics().rejectedBatchCount, 1);

  sendGate.resolve();
  await waitFor(() => queue.metrics().queueDepth === 0);
  await queue.close();
});

test('队列按序列化字节上限拒绝超大 Span', () => {
  const queue = new BoundedSpanQueue({
    topic: 'ai-spans',
    brokers: ['localhost:9092'],
    producerFactory: () => fakeProducer(),
    maxQueueBytes: 32,
  });
  const result = queue.enqueue([makeEvent()]);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'queue_full');
  assert.equal(queue.metrics().queueBytes, 0);
  assert.equal(queue.metrics().droppedSpans, 1);
  return queue.close();
});

test('Kafka 发送失败有限重试；确认成功前不会计入 published', async () => {
  let sends = 0;
  const producer = fakeProducer({
    async send() {
      sends += 1;
      if (sends === 1) throw new Error('raw broker error');
    },
  });
  const queue = new BoundedSpanQueue({
    topic: 'ai-spans',
    brokers: ['localhost:9092'],
    producerFactory: () => producer,
    maxRetries: 1,
    retryDelayMs: 1,
  });

  queue.enqueue([makeEvent()]);
  assert.equal(queue.metrics().publishedSpans, 0);
  await waitFor(() => queue.metrics().queueDepth === 0);
  assert.equal(sends, 2);
  assert.equal(queue.metrics().publishedSpans, 1);
  assert.equal(queue.metrics().publishErrorCount, 1);
  assert.equal(queue.metrics().retryCount, 1);
  assert.equal(queue.metrics().droppedSpans, 0);
  await queue.close();
});

test('Kafka 持续失败达到重试上限后丢弃并暴露 error/drop 计数', async () => {
  let sends = 0;
  const queue = new BoundedSpanQueue({
    topic: 'ai-spans',
    brokers: ['localhost:9092'],
    producerFactory: () => fakeProducer({ async send() { sends += 1; throw new Error('unsafe detail'); } }),
    maxRetries: 2,
    retryDelayMs: 1,
  });
  queue.enqueue([makeEvent()]);
  await waitFor(() => queue.metrics().queueDepth === 0);

  assert.equal(sends, 3);
  assert.equal(queue.metrics().publishedSpans, 0);
  assert.equal(queue.metrics().publishErrorCount, 3);
  assert.equal(queue.metrics().retryCount, 2);
  assert.equal(queue.metrics().droppedSpans, 1);
  assert.equal(queue.metrics().producerState, 'unavailable');
  await queue.close();
});

test('关闭会有限等待在途发送、丢弃未完成内存数据并完成断开', async () => {
  const sendGate = deferred();
  const enteredSend = deferred();
  let disconnected = false;
  const queue = new BoundedSpanQueue({
    topic: 'ai-spans',
    brokers: ['localhost:9092'],
    producerFactory: () => fakeProducer({
      async send() { enteredSend.resolve(); await sendGate.promise; },
      async disconnect() { disconnected = true; },
    }),
    shutdownTimeoutMs: 10,
  });
  queue.enqueue([makeEvent()]);
  await enteredSend.promise;
  const started = Date.now();
  await queue.close();
  assert.ok(Date.now() - started < 500);
  assert.equal(disconnected, true);
  assert.equal(queue.metrics().producerState, 'closed');
  assert.equal(queue.metrics().queueDepth, 0);
  assert.equal(queue.metrics().publishedSpans, 0);
  assert.equal(queue.metrics().droppedSpans, 1);
  sendGate.resolve();
});
