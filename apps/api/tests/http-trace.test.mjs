import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const {
  Controller,
  Get,
  HttpException,
  Inject,
  Module,
  Param,
  Res,
  UseGuards,
} = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { Observable } = require('rxjs');
const { ApiExceptionFilter } = require('../dist/common/api-exception.filter.js');
const { DatabaseService } = require('../dist/database/database.service.js');
const { HealthController } = require('../dist/health/health.controller.js');
const { HttpTraceInterceptor } = require('../dist/observability/http-trace.interceptor.js');
const { TraceContext } = require('../dist/observability/trace-context.js');
const { TraceObservabilityService } = require('../dist/observability/trace-observability.service.js');
const { TraceIdMiddleware } = require('../dist/trace/trace-id.middleware.js');

class MemoryRecorder {
  constructor() {
    this.spans = [];
    this.sequence = 0;
  }

  start(operation, traceId, parentSpanId) {
    const record = {
      id: `span-${++this.sequence}`,
      operation,
      traceId,
      parentSpanId,
      attributes: {},
      ended: false,
      error: undefined,
    status: undefined,
    };
    const span = {
      id: record.id,
      get traceId() { return record.traceId; },
      set: (key, value) => {
        if (record.ended) throw new TypeError('Cannot modify an ended span');
        record.attributes[key] = value;
      },
      setUsage: (usage) => { record.usage = usage; },
      end: (error) => {
        if (record.ended) return;
        record.ended = true;
        record.error = error;
        record.status = error === undefined ? 'ok' : 'error';
      },
    };
    this.spans.push(record);
    return span;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function decorateMethod(decorator, controller, method) {
  decorator(controller.prototype, method, Object.getOwnPropertyDescriptor(controller.prototype, method));
}

async function createTestApp(options = {}) {
  const prefix = options.prefix ?? true;
  const recorder = Object.hasOwn(options, 'recorder') ? options.recorder : new MemoryRecorder();
  const traceContext = new TraceContext();
  const holdStarted = deferred();
  const treeObservations = [];
  const controls = {
    holdStarted,
    holdRelease: undefined,
    holdDefaultStatus: undefined,
    treeObservations,
    originalErrors: {},
  };

  class TestController {
    constructor(context) {
      this.traceContext = context;
    }

    async concurrent(key) {
      const root = this.traceContext.current();
      const rootSpanId = root?.span.id;
      await this.traceContext.withSpan('rag', async (rag) => {
        controls.treeObservations.push({
          key,
          branch: 'rag',
          traceId: this.traceContext.current()?.span.traceId,
          activeSpanId: this.traceContext.current()?.span.id,
          spanId: rag.id,
          parentSpanId: rootSpanId,
        });
        await delay(key === 'alpha' ? 20 : 5);
        assert.equal(this.traceContext.current()?.span.id, rag.id);
        await this.traceContext.withSpan('tool', async (tool) => {
          controls.treeObservations.push({
            key,
            branch: 'tool',
            traceId: this.traceContext.current()?.span.traceId,
            activeSpanId: this.traceContext.current()?.span.id,
            spanId: tool.id,
            parentSpanId: rag.id,
          });
          await delay(2);
          assert.equal(this.traceContext.current()?.span.id, tool.id);
        });
      });
      await this.traceContext.withSpan('llm', async (llm) => {
        controls.treeObservations.push({
          key,
          branch: 'llm',
          traceId: this.traceContext.current()?.span.traceId,
          activeSpanId: this.traceContext.current()?.span.id,
          spanId: llm.id,
          parentSpanId: rootSpanId,
        });
        await delay(3);
        assert.equal(this.traceContext.current()?.span.id, llm.id);
      });
      return { key };
    }

    fail400() {
      controls.originalErrors.badRequest = new HttpException('safe test error', 400);
      throw controls.originalErrors.badRequest;
    }

    fail500() {
      controls.originalErrors.internal = new Error('safe internal test error');
      throw controls.originalErrors.internal;
    }

    failUndefined() {
      throw undefined;
    }

    manualBadRequest(response) {
      response.status(409);
      return { ok: false };
    }

    endRootEarly() {
      this.traceContext.current()?.span.end();
      return { ok: true };
    }

    hold(response) {
      controls.holdDefaultStatus = response.statusCode;
      controls.holdStarted.resolve();
      return new Promise((resolve) => { controls.holdRelease = resolve; });
    }

    guarded() { return { shouldNotReach: true }; }
    plain() { return { ok: true }; }
    spans() { return { ok: true }; }
    spanChild(child) { return { child }; }
  }
  class UnauthorizedGuard {
    canActivate() { throw new HttpException('Unauthorized', 401); }
  }

  Inject(TraceContext)(TestController, undefined, 0);
  decorateMethod(Get('async/:key'), TestController, 'concurrent');
  Param('key')(TestController.prototype, 'concurrent', 0);
  decorateMethod(Get('bad-request'), TestController, 'fail400');
  decorateMethod(Get('internal-error'), TestController, 'fail500');
  decorateMethod(Get('throw-undefined'), TestController, 'failUndefined');
  decorateMethod(Get('manual-bad-request'), TestController, 'manualBadRequest');
  Res({ passthrough: true })(TestController.prototype, 'manualBadRequest', 0);
  decorateMethod(Get('end-root-early'), TestController, 'endRootEarly');
  decorateMethod(Get('hold'), TestController, 'hold');
  Res()(TestController.prototype, 'hold', 0);
  decorateMethod(Get('guarded'), TestController, 'guarded');
  UseGuards(UnauthorizedGuard)(TestController.prototype, 'guarded', Object.getOwnPropertyDescriptor(TestController.prototype, 'guarded'));
  decorateMethod(Get('plain'), TestController, 'plain');
  decorateMethod(Get('spans'), TestController, 'spans');
  decorateMethod(Get('spans/:child'), TestController, 'spanChild');
  Param('child')(TestController.prototype, 'spanChild', 0);
  Controller()(TestController);

  class TestModule {}
  Module({
    controllers: [TestController, HealthController],
    providers: [
      { provide: TraceContext, useValue: traceContext },
      { provide: DatabaseService, useValue: { ping: async () => undefined } },
      {
        provide: TraceObservabilityService,
        useValue: {
          recorder: () => recorder,
          status: () => ({ state: recorder ? 'ready' : 'disabled' }),
        },
      },
      UnauthorizedGuard,
    ],
  })(TestModule);

  const app = await NestFactory.create(TestModule, { logger: false });
  app.use((request, response, next) => new TraceIdMiddleware().use(request, response, next));
  if (prefix) app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new HttpTraceInterceptor({ recorder: () => recorder }, traceContext));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();

  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}${prefix ? '/api/v1' : ''}`,
    recorder,
    traceContext,
    controls,
  };
}

async function waitFor(predicate, message, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(5);
  }
}

async function withinDeadline(promise, message, timeoutMs = 1500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('六棵并发 trace 树保持 ALS 隔离，分别形成 root→rag→tool 和 root→llm', async (t) => {
  const fixture = await createTestApp();
  t.after(() => fixture.app.close());

  const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => fetch(
    `${fixture.baseUrl}/async/tree-${index}?private_query_marker=secret`,
    { headers: { 'x-trace-id': `trace-${index}`, 'x-private-marker': 'must-not-be-recorded' } },
  )));
  assert.deepEqual(responses.map((response) => response.status), Array(6).fill(200));
  assert.deepEqual(
    responses.map((response) => response.headers.get('x-trace-id')),
    Array.from({ length: 6 }, (_, index) => `trace-${index}`),
  );

  await waitFor(() => fixture.recorder.spans.filter((span) => span.operation === 'http.server').every((span) => span.ended), 'root spans did not finish');
  const roots = fixture.recorder.spans.filter((span) => span.operation === 'http.server');
  const children = fixture.recorder.spans.filter((span) => span.operation !== 'http.server');
  assert.equal(roots.length, 6);
  assert.equal(children.length, 18);

  for (let index = 0; index < 6; index += 1) {
    const key = `tree-${index}`;
    const traceId = `trace-${index}`;
    const root = roots.find((span) => span.traceId === traceId);
    const rag = children.find((span) => span.traceId === traceId && span.operation === 'rag');
    const tool = children.find((span) => span.traceId === traceId && span.operation === 'tool');
    const llm = children.find((span) => span.traceId === traceId && span.operation === 'llm');
    const observations = fixture.controls.treeObservations.filter((item) => item.key === key);
    assert.ok(root);
    assert.ok(rag);
    assert.ok(tool);
    assert.ok(llm);
    assert.equal(rag.parentSpanId, root.id);
    assert.equal(tool.parentSpanId, rag.id);
    assert.equal(llm.parentSpanId, root.id);
    assert.equal(observations.length, 3);
    for (const observation of observations) {
      assert.equal(observation.traceId, traceId);
      assert.equal(observation.activeSpanId, observation.spanId);
    }
    assert.equal(observations.find((item) => item.branch === 'rag').parentSpanId, root.id);
    assert.equal(observations.find((item) => item.branch === 'tool').parentSpanId, rag.id);
    assert.equal(observations.find((item) => item.branch === 'llm').parentSpanId, root.id);
    assert.equal(root.ended, true);
    assert.equal(rag.ended, true);
    assert.equal(tool.ended, true);
    assert.equal(llm.ended, true);
  }

  const sampleRoot = roots.find((span) => span.traceId === 'trace-0');
  assert.equal(sampleRoot.attributes['http.method'], 'GET');
  assert.match(sampleRoot.attributes['http.route'], /async\/:key$/);
  assert.equal(sampleRoot.attributes['http.route'].includes('tree-0'), false);
  assert.equal(sampleRoot.attributes['http.status_code'], 200);
  assert.deepEqual(Object.keys(sampleRoot.attributes).sort(), ['http.method', 'http.route', 'http.status_code']);
});

test('可选 parent header 只关联到 http.server root，异常值不影响响应与 Trace ID', async (t) => {
  const fixture = await createTestApp();
  t.after(() => fixture.app.close());

  const validParent = '0123456789abcdef0123456789abcdef';
  const cases = [
    {
      name: 'valid parent',
      traceId: 'trace-parent-valid',
      parentHeader: validParent,
      expectedParent: validParent,
    },
    {
      name: 'missing parent',
      traceId: 'trace-parent-missing',
      expectedParent: undefined,
    },
    {
      name: 'malformed parent with valid trace',
      traceId: 'trace-parent-malformed',
      parentHeader: 'browser-span-private-value',
      expectedParent: undefined,
    },
    {
      name: 'ambiguous duplicate parent values',
      traceId: 'trace-parent-duplicate',
      parentHeader: `${validParent}, ${validParent}`,
      expectedParent: undefined,
    },
    {
      name: 'missing trace ignores valid parent',
      parentHeader: validParent,
      expectedParent: undefined,
      expectGeneratedTraceId: true,
    },
    {
      name: 'invalid trace remains server-generated and ignores parent',
      traceId: 'invalid trace id',
      parentHeader: validParent,
      expectedParent: undefined,
      expectGeneratedTraceId: true,
    },
    {
      name: 'duplicate trace values remain server-generated and ignore parent',
      traceId: 'trace-parent-duplicate, trace-parent-duplicate',
      parentHeader: validParent,
      expectedParent: undefined,
      expectGeneratedTraceId: true,
    },
  ];

  for (const testCase of cases) {
    const headers = {};
    if (testCase.traceId !== undefined) headers['x-trace-id'] = testCase.traceId;
    if (testCase.parentHeader !== undefined) headers['x-parent-span-id'] = testCase.parentHeader;

    const response = await fetch(`${fixture.baseUrl}/plain`, { headers });
    assert.equal(response.status, 200, testCase.name);
    assert.deepEqual(await response.json(), { ok: true }, testCase.name);

    const responseTraceId = response.headers.get('x-trace-id');
    assert.ok(responseTraceId, `${testCase.name}: response must retain x-trace-id`);
    if (testCase.expectGeneratedTraceId) {
      assert.notEqual(responseTraceId, testCase.traceId);
      assert.match(responseTraceId, /^trace_v1_[0-9a-f-]{36}$/i);
    } else {
      assert.equal(responseTraceId, testCase.traceId, testCase.name);
    }

    await waitFor(
      () => fixture.recorder.spans.some((span) => span.operation === 'http.server' && span.traceId === responseTraceId && span.ended),
      `${testCase.name}: root span did not finish`,
    );
    const root = fixture.recorder.spans.find((span) => span.operation === 'http.server' && span.traceId === responseTraceId);
    assert.equal(root.parentSpanId, testCase.expectedParent, testCase.name);
    assert.deepEqual(Object.keys(root.attributes).sort(), ['http.method', 'http.route', 'http.status_code']);
    if (testCase.parentHeader !== undefined) {
      assert.equal(JSON.stringify(root.attributes).includes(testCase.parentHeader), false, testCase.name);
    }
  }

  const treeParent = 'fedcba9876543210fedcba9876543210';
  const treeResponse = await fetch(`${fixture.baseUrl}/async/parent-context`, {
    headers: {
      'x-trace-id': 'trace-parent-tree',
      'x-parent-span-id': treeParent,
    },
  });
  assert.equal(treeResponse.status, 200);
  assert.deepEqual(await treeResponse.json(), { key: 'parent-context' });
  await waitFor(
    () => fixture.recorder.spans.some((span) => span.operation === 'http.server' && span.traceId === 'trace-parent-tree' && span.ended),
    'parent-context request root did not finish',
  );
  const treeRoot = fixture.recorder.spans.find((span) => span.operation === 'http.server' && span.traceId === 'trace-parent-tree');
  const treeChildren = fixture.recorder.spans.filter((span) => span.traceId === 'trace-parent-tree' && span.operation !== 'http.server');
  const rag = treeChildren.find((span) => span.operation === 'rag');
  const tool = treeChildren.find((span) => span.operation === 'tool');
  const llm = treeChildren.find((span) => span.operation === 'llm');
  assert.equal(treeRoot.parentSpanId, treeParent);
  assert.equal(rag.parentSpanId, treeRoot.id);
  assert.equal(tool.parentSpanId, rag.id);
  assert.equal(llm.parentSpanId, treeRoot.id);
  assert.equal(treeChildren.some((span) => span.parentSpanId === treeParent), false);
});

test('400 和 500 业务错误原样透传，异常过滤器最终状态写入 response span', async (t) => {
  const fixture = await createTestApp();
  t.after(() => fixture.app.close());

  for (const [path, status, errorKey] of [
    ['bad-request', 400, 'badRequest'],
    ['internal-error', 500, 'internal'],
  ]) {
    const response = await fetch(`${fixture.baseUrl}/${path}`);
    assert.equal(response.status, status);
    const traceId = response.headers.get('x-trace-id');
    const root = fixture.recorder.spans.find((span) => span.operation === 'http.server' && span.traceId === traceId);
    await waitFor(() => root?.ended, `${status} response root span did not finish`);
    assert.equal(root.attributes['http.status_code'], status);
    assert.equal(root.error, fixture.controls.originalErrors[errorKey]);
  }
});

test('finish 的 4xx 状态即使没有抛错也标记 span error；undefined 错误使用安全失败标记', async (t) => {
  const fixture = await createTestApp();
  t.after(() => fixture.app.close());

  const manualResponse = await fetch(`${fixture.baseUrl}/manual-bad-request`);
  assert.equal(manualResponse.status, 409);
  const manualTraceId = manualResponse.headers.get('x-trace-id');
  const manualRoot = fixture.recorder.spans.find((span) => span.operation === 'http.server' && span.traceId === manualTraceId);
  await waitFor(() => manualRoot?.ended, 'manual 409 response root span did not finish');
  assert.equal(manualRoot.attributes['http.status_code'], 409);
  assert.equal(manualRoot.status, 'error');

  const undefinedResponse = await fetch(`${fixture.baseUrl}/throw-undefined`);
  assert.equal(undefinedResponse.status, 500);
  const undefinedTraceId = undefinedResponse.headers.get('x-trace-id');
  const undefinedRoot = fixture.recorder.spans.find((span) => span.operation === 'http.server' && span.traceId === undefinedTraceId);
  await waitFor(() => undefinedRoot?.ended, 'undefined error response root span did not finish');
  assert.equal(undefinedRoot.attributes['http.status_code'], 500);
  assert.equal(undefinedRoot.status, 'error');
  assert.ok(undefinedRoot.error instanceof Error);
});

test('客户端断开时由 response close 结束 root span 并保留当前 status_code', async (t) => {
  const fixture = await createTestApp();
  t.after(() => fixture.app.close());

  const abort = new AbortController();
  const request = fetch(`${fixture.baseUrl}/hold`, { signal: abort.signal }).catch(() => undefined);
  try {
    await withinDeadline(fixture.controls.holdStarted.promise, 'hold route was not reached');
    assert.equal(fixture.controls.holdDefaultStatus, 200);
    const root = fixture.recorder.spans.find((span) => span.operation === 'http.server');
    assert.ok(root);
    abort.abort();
    await withinDeadline(request, 'aborted client request did not settle');
    await waitFor(() => root.ended, 'response close did not finish the root span');
    assert.equal(root.attributes['http.status_code'], 499);
    assert.equal(root.status, 'error');
  } finally {
    abort.abort();
    fixture.controls.holdRelease?.();
  }
});

test('业务提前 end root 后真实 HTTP finish 不会让 telemetry 异常影响响应或进程', async (t) => {
  const fixture = await createTestApp();
  t.after(() => fixture.app.close());

  const response = await fetch(`${fixture.baseUrl}/end-root-early`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const traceId = response.headers.get('x-trace-id');
  const root = fixture.recorder.spans.find((span) => span.operation === 'http.server' && span.traceId === traceId);
  assert.equal(root.ended, true);
  assert.equal(root.attributes['http.status_code'], undefined);
});

test('health 和 spans 排除路径支持带 /api/v1 前缀与不带前缀', async (t) => {
  for (const prefix of [true, false]) {
    const fixture = await createTestApp({ prefix });
    t.after(() => fixture.app.close());
    const paths = ['/health?private=secret', '/spans', '/spans/child'];
    for (const path of paths) {
      const response = await fetch(`${fixture.baseUrl}${path}`);
      assert.equal(response.status, 200);
      if (path.startsWith('/health')) {
        const body = await response.json();
        assert.equal(body.tracing.state, 'ready');
      }
    }
    assert.equal(fixture.recorder.spans.length, 0);
  }
});

test('guard 产生的 401 在 interceptor 之前结束，不创建 HTTP root span', async (t) => {
  const fixture = await createTestApp();
  t.after(() => fixture.app.close());

  const response = await fetch(`${fixture.baseUrl}/guarded`);
  assert.equal(response.status, 401);
  assert.equal(fixture.recorder.spans.length, 0);
});

test('recorder disabled 时 HTTP 请求原样通过且不创建 span', async (t) => {
  const fixture = await createTestApp({ recorder: undefined });
  t.after(() => fixture.app.close());

  const response = await fetch(`${fixture.baseUrl}/plain`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('x-trace-id'), /^trace_v1_[0-9a-f-]{36}$/i);
  const health = await fetch(`${fixture.baseUrl}/health`);
  assert.equal((await health.json()).tracing.state, 'disabled');
});

test('withSpan 无上下文时报清晰错误；子 span 继承 trace、设置 parent，并透传原错误', async () => {
  const traceContext = new TraceContext();
  const recorder = new MemoryRecorder();
  await assert.rejects(
    traceContext.withSpan('orphan', () => undefined),
    /requires an active trace context/,
  );
  assert.equal(recorder.spans.length, 0);

  const root = recorder.start('root', 'trace-context');
  const failure = new Error('original child failure');
  await assert.rejects(
    traceContext.run(recorder, root, () => traceContext.withSpan('child', async () => { throw failure; })),
    (error) => error === failure,
  );
  const child = recorder.spans.find((span) => span.operation === 'child');
  assert.equal(child.traceId, 'trace-context');
  assert.equal(child.parentSpanId, root.id);
  assert.equal(child.ended, true);
  assert.equal(child.error, failure);
  assert.equal(traceContext.current(), undefined);
});

test('withSpan 抛出 undefined 时仍以错误状态结束 child span，并原样拒绝 undefined', async () => {
  const traceContext = new TraceContext();
  const recorder = new MemoryRecorder();
  const root = recorder.start('root', 'trace-undefined');
  let rejected = false;
  let reason = 'not-rejected';
  try {
    await traceContext.run(recorder, root, () => traceContext.withSpan('child-undefined', () => { throw undefined; }));
  } catch (error) {
    rejected = true;
    reason = error;
  }
  assert.equal(rejected, true);
  assert.equal(reason, undefined);
  const child = recorder.spans.find((span) => span.operation === 'child-undefined');
  assert.equal(child.ended, true);
  assert.equal(child.status, 'error');
  assert.ok(child.error instanceof Error);
});

test('非 HTTP Nest context 直通，响应结束后清除未触发的 response listener', async () => {
  const recorder = new MemoryRecorder();
  const traceContext = new TraceContext();
  const interceptor = new HttpTraceInterceptor({ recorder: () => recorder }, traceContext);
  const source = new Observable((subscriber) => {
    subscriber.next('rpc result');
    subscriber.complete();
  });
  const rpcResult = interceptor.intercept({
    getType: () => 'rpc',
    switchToHttp: () => { throw new Error('non-http context must not switch to HTTP'); },
  }, { handle: () => source });
  assert.equal(rpcResult, source);
  assert.equal(recorder.spans.length, 0);

  const request = {
    method: 'GET',
    path: '/cleanup',
    route: { path: '/cleanup' },
    headers: {},
  };
  const response = new EventEmitter();
  response.statusCode = 200;
  response.setHeader = () => undefined;
  const httpContext = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  };
  const httpResult = interceptor.intercept(httpContext, { handle: () => source });
  await new Promise((resolve, reject) => httpResult.subscribe({ error: reject, complete: resolve }));
  assert.equal(response.listenerCount('finish'), 1);
  assert.equal(response.listenerCount('close'), 1);
  response.emit('finish');
  assert.equal(response.listenerCount('finish'), 0);
  assert.equal(response.listenerCount('close'), 0);
});
