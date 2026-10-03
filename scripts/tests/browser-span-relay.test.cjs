'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { createBrowserSpanRelay } = require('../browser-span-relay.cjs');

const ROUTE = '/__sdk_test__/spans';
const PROJECT_KEY = 'tr_' + 'A'.repeat(43);
const PRIVATE_CANARY = 'browser_private_canary_7f3a';
const OPERATION_BY_EVENT_TYPE = {
  navigation: 'browser.navigation',
  web_vital: 'browser.web_vital',
  javascript_error: 'browser.javascript_error',
  unhandled_rejection: 'browser.unhandled_rejection',
  network_error: 'browser.network_error',
};
let spanIdSequence = 0;

function makeSpan(eventType = 'javascript_error', overrides = {}) {
  const endTime = Date.now();
  let startTime = endTime;
  let attributes = { eventType };
  if (eventType === 'navigation') {
    startTime = endTime - 250;
  } else if (eventType === 'web_vital') {
    attributes = { eventType, metric: 'LCP', value: 1_234, delta: -12, rating: 'good' };
  } else if (eventType === 'javascript_error' || eventType === 'unhandled_rejection') {
    attributes.errorName = 'TypeError';
  } else if (eventType === 'network_error') {
    startTime = endTime - 38;
    attributes = {
      eventType,
      source: 'fetch',
      reason: 'http',
      method: 'GET',
      httpStatus: 503,
      path: '/api/v1/users/:id',
    };
  }

  const span = {
    traceId: 'trace_v1_01234567-89ab-cdef-0123-456789abcdef',
    spanId: (++spanIdSequence).toString(16).padStart(32, '0'),
    service: 'web-sdk-demo',
    operation: OPERATION_BY_EVENT_TYPE[eventType],
    startTime,
    endTime,
    status: eventType === 'web_vital' || eventType === 'navigation' ? 'ok' : 'error',
    attributes,
  };
  const spanOverrides = {};
  const attributeFields = new Set([
    'eventType', 'metric', 'value', 'delta', 'rating', 'errorName', 'path', 'line', 'column',
    'source', 'reason', 'method', 'httpStatus', 'metricId', 'message',
  ]);
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'attributes') {
      attributes = value;
    } else if (attributeFields.has(key)) {
      attributes[key] = value;
    } else {
      spanOverrides[key] = value;
    }
  }
  return { ...span, ...spanOverrides, attributes };
}

function loadFrontendConverter() {
  const filename = path.resolve(__dirname, '../../apps/web/src/browser-span-transport.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  let uuidCounter = 0;
  const sandbox = {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === './api') return { getUnpatchedFetch: () => undefined };
      throw new Error('Unexpected converter import');
    },
    globalThis: {
      crypto: {
        randomUUID() {
          uuidCounter += 1;
          return '00000000-0000-4000-8000-' + uuidCounter.toString(16).padStart(12, '0');
        },
      },
    },
  };
  vm.runInNewContext(javascript, sandbox, { filename });
  return module.exports.convertBrowserMonitorEventToSpan;
}

function makeBody(spans = [makeSpan('javascript_error')], overrides = {}) {
  return { environment: 'dev', spans, ...overrides };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function makeHarness(t, relayOptions = {}) {
  const upstreamRequests = [];
  const upstreamHandler = relayOptions.upstreamHandler;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      upstreamRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        bodyText: Buffer.concat(chunks).toString('utf8'),
      });
      if (upstreamHandler) {
        upstreamHandler(req, res);
        return;
      }
      res.statusCode = 202;
      res.end('{"ignored":"upstream response"}');
    });
  });
  const apiPort = await listen(upstream);
  const relay = createBrowserSpanRelay({
    projectKey: PROJECT_KEY,
    apiPort: String(apiPort),
    ...relayOptions,
  });
  const web = http.createServer((req, res) => relay(req, res, () => {
    res.statusCode = 404;
    res.end('not found');
  }));
  const webPort = await listen(web);
  t.after(async () => {
    await close(web);
    await close(upstream);
  });
  return { apiPort, webPort, upstreamRequests, upstream, web, relay };
}

function sendRequest(port, options = {}) {
  const bodyText = options.bodyText ?? JSON.stringify(options.body ?? makeBody());
  const headers = {
    host: Object.prototype.hasOwnProperty.call(options, 'host') ? options.host : '127.0.0.1:' + port,
    origin: Object.prototype.hasOwnProperty.call(options, 'origin') ? options.origin : 'http://127.0.0.1:' + port,
    'content-type': options.contentType ?? 'application/json',
    'content-length': Buffer.byteLength(bodyText),
    ...(options.headers ?? {}),
  };
  for (const [name, value] of Object.entries(headers)) {
    if (value === null || value === undefined) delete headers[name];
  }

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: options.path ?? ROUTE,
      method: options.method ?? 'POST',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.once('error', reject);
    req.end(bodyText);
  });
}

test('接受前端 TraceSpan、保留标识与时间并验证五类 operation/eventType 语义', async (t) => {
  const harness = await makeHarness(t);
  const spans = [
    makeSpan('web_vital'),
    makeSpan('javascript_error', { path: '/web/:id', line: 12, column: 4 }),
    makeSpan('unhandled_rejection'),
    makeSpan('network_error'),
  ];
  const response = await sendRequest(harness.webPort, {
    body: makeBody(spans),
    headers: { 'x-trace-id': 'trace_v1_request_header', authorization: 'Bearer browser-secret', cookie: 'session=browser-secret' },
  });

  assert.equal(response.status, 202);
  assert.deepEqual(response.json, {
    status: 'queued',
    delivery: 'queued_in_memory',
    durability: 'best_effort',
    acceptedSpans: 4,
  });
  assert.equal(response.text.includes(PROJECT_KEY), false);
  assert.equal(response.text.includes('browser-secret'), false);
  assert.equal(harness.upstreamRequests.length, 1);
  const sent = harness.upstreamRequests[0];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/api/v1/spans');
  assert.equal(sent.headers.host, '127.0.0.1:' + harness.apiPort);
  assert.equal(sent.headers['x-trace-id'], 'trace_v1_request_header');
  assert.equal('authorization' in sent.headers, false);
  assert.equal('cookie' in sent.headers, false);

  const envelope = JSON.parse(sent.bodyText);
  assert.deepEqual(Object.keys(envelope).sort(), ['environment', 'projectKey', 'spans']);
  assert.equal(envelope.projectKey, PROJECT_KEY);
  assert.equal(envelope.environment, 'dev');
  assert.deepEqual(
    envelope.spans.map((span) => [span.operation, span.attributes.eventType]),
    [
      ['browser.web_vital', 'web_vital'],
      ['browser.javascript_error', 'javascript_error'],
      ['browser.unhandled_rejection', 'unhandled_rejection'],
      ['browser.network_error', 'network_error'],
    ],
  );

  for (const [index, span] of envelope.spans.entries()) {
    assert.equal(span.service, 'web-sdk-demo');
    assert.equal(span.operation, ({
      web_vital: 'browser.web_vital',
      javascript_error: 'browser.javascript_error',
      unhandled_rejection: 'browser.unhandled_rejection',
      network_error: 'browser.network_error',
    })[span.attributes.eventType]);
    assert.deepEqual(
      Object.keys(span).sort(),
      ['attributes', 'endTime', 'operation', 'service', 'spanId', 'startTime', 'status', 'traceId'],
    );
    assert.equal(JSON.stringify(span).includes('metricId'), false);
    assert.equal(JSON.stringify(span).includes('message'), false);
    assert.equal(JSON.stringify(span).includes('durationMs'), false);
    assert.equal(JSON.stringify(span).includes('parentSpanId'), false);
    assert.equal(JSON.stringify(span).includes('tokenUsage'), false);
    assert.equal(span.spanId, spans[index].spanId);
    assert.equal(span.traceId, spans[index].traceId);
    assert.equal(span.startTime, spans[index].startTime);
    assert.equal(span.endTime, spans[index].endTime);
    assert.equal(span.status, spans[index].status);
  }
  assert.equal(envelope.spans[0].attributes.delta, -12);
  assert.equal(envelope.spans[1].attributes.path, '/web/:id');
  assert.deepEqual(envelope.spans[3].attributes, {
    eventType: 'network_error',
    source: 'fetch',
    reason: 'http',
    method: 'GET',
    httpStatus: 503,
    path: '/api/v1/users/:id',
  });
  assert.equal(envelope.spans[3].startTime, spans[3].startTime);
  assert.equal(envelope.spans[3].endTime, spans[3].endTime);
});

test('跨端契约：relay 接受前端 converter 实际输出并丢弃原始错误文本/未脱敏 path', async (t) => {
  const convert = loadFrontendConverter();
  assert.equal(typeof convert, 'function');
  const now = Date.now();
  const events = [
    {
      type: 'web_vital',
      service: 'web-sdk-demo',
      environment: 'dev',
      timestamp: now,
      traceId: 'trace_web_01234567-89ab-cdef-0123-456789abcdef',
      metric: 'CLS',
      value: 0.25,
      delta: -0.125,
      rating: 'good',
    },
    {
      type: 'javascript_error',
      service: 'web-sdk-demo',
      environment: 'dev',
      timestamp: now + 1,
      traceId: 'trace_web_01234567-89ab-cdef-0123-456789abcdef',
      message: PRIVATE_CANARY,
      errorName: 'TypeError',
      path: '/api/users/' + PRIVATE_CANARY,
      line: 7,
      column: 9,
    },
    {
      type: 'unhandled_rejection',
      service: 'web-sdk-demo',
      environment: 'dev',
      timestamp: now + 2,
      traceId: 'trace_web_01234567-89ab-cdef-0123-456789abcdef',
      message: PRIVATE_CANARY,
      errorName: 'Error',
    },
    {
      type: 'network_error',
      service: 'web-sdk-demo',
      environment: 'dev',
      timestamp: now + 100,
      traceId: 'trace_web_01234567-89ab-cdef-0123-456789abcdef',
      source: 'xhr',
      reason: 'http',
      method: 'post',
      status: 503,
      durationMs: 50,
      path: '/api/v1/users/:id',
    },
  ];
  const spans = events.map(convert);
  assert.ok(spans.every(Boolean));
  assert.equal(spans[0].attributes.delta, -0.125);
  assert.equal(JSON.stringify(spans).includes(PRIVATE_CANARY), false);

  const harness = await makeHarness(t);
  const response = await sendRequest(harness.webPort, { body: makeBody(spans) });
  assert.equal(response.status, 202);
  const forwarded = JSON.parse(harness.upstreamRequests[0].bodyText).spans;
  assert.deepEqual(forwarded, JSON.parse(JSON.stringify(spans)));
  assert.equal(JSON.stringify(forwarded).includes(PRIVATE_CANARY), false);
});

test('没有管理员凭据也可通过本地 relay，projectKey 仅附加在服务端请求', async (t) => {
  const harness = await makeHarness(t);
  const response = await sendRequest(harness.webPort);
  assert.equal(response.status, 202);
  assert.equal(harness.upstreamRequests.length, 1);
  assert.equal(JSON.parse(harness.upstreamRequests[0].bodyText).projectKey, PROJECT_KEY);
  assert.equal(response.text.includes('projectKey'), false);
});

test('API 端口字符串只用于固定 127.0.0.1 目标，且不跟随上游重定向', async (t) => {
  let call;
  const harness = await makeHarness(t, {
    apiPort: '4321',
    fetchImpl: async (url, options) => {
      call = { url, options };
      return { status: 302, body: null };
    },
  });
  const response = await sendRequest(harness.webPort);
  assert.equal(response.status, 503);
  assert.equal(call.url, 'http://127.0.0.1:4321/api/v1/spans');
  assert.equal(call.options.redirect, 'manual');
  assert.equal(call.options.headers.authorization, undefined);
  assert.equal(call.options.headers.cookie, undefined);
});

test('缺少或伪造 Origin、非 loopback Host 会 fail closed', async (t) => {
  const harness = await makeHarness(t);
  const cases = [
    { origin: null },
    { origin: 'https://127.0.0.1:' + harness.webPort },
    {
      host: 'example.test:' + harness.webPort,
      origin: 'http://example.test:' + harness.webPort,
    },
    {
      host: '127.0.0.1:' + harness.webPort,
      origin: 'http://localhost:' + harness.webPort,
    },
    { origin: 'http://127.0.0.1:' + harness.webPort + '/path' },
    { origin: 'http://127.0.0.1:' + harness.webPort + '?x=1' },
  ];
  for (const testCase of cases) {
    const response = await sendRequest(harness.webPort, testCase);
    assert.equal(response.status, 403);
    assert.equal(response.text.includes(PROJECT_KEY), false);
  }
  assert.equal(harness.upstreamRequests.length, 0);
});

test('拒绝非 loopback socket 来源，即使 Host 与 Origin 看似本机', async () => {
  const relay = createBrowserSpanRelay({ projectKey: PROJECT_KEY, apiPort: '3001' });
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = ROUTE;
  req.headers = { host: 'localhost:5173', origin: 'http://localhost:5173' };
  req.rawHeaders = ['host', 'localhost:5173', 'origin', 'http://localhost:5173'];
  req.socket = { remoteAddress: '192.0.2.10' };
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body, callback) {
      this.body = body;
      this.writableEnded = true;
      callback?.();
    },
  };

  await relay(req, res, () => assert.fail('unexpected fallthrough'));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.includes(PROJECT_KEY), false);
});

test('projectKey 未配置或 apiPort 非法时返回固定 503', async (t) => {
  const harness = await makeHarness(t, { projectKey: '', apiPort: 65_536 });
  const response = await sendRequest(harness.webPort);
  assert.equal(response.status, 503);
  assert.deepEqual(response.json, {
    status: 'rejected',
    message: 'Browser span relay is unavailable',
  });
  assert.equal(response.text.includes(PROJECT_KEY), false);
  assert.equal(harness.upstreamRequests.length, 0);
});

test('接受 browser.navigation 根 Span 与有效 parentSpanId，并将父子关系安全转发', async (t) => {
  const harness = await makeHarness(t);
  const root = makeSpan('navigation');
  const vital = makeSpan('web_vital', { parentSpanId: root.spanId });
  const exception = makeSpan('javascript_error', { parentSpanId: root.spanId });
  const response = await sendRequest(harness.webPort, {
    body: makeBody([root, vital, exception]),
    headers: { 'x-trace-id': root.traceId },
  });

  assert.equal(response.status, 202);
  const envelope = JSON.parse(harness.upstreamRequests[0].bodyText);
  assert.deepEqual(envelope.spans.map((span) => [span.operation, span.parentSpanId ?? null]), [
    ['browser.navigation', null],
    ['browser.web_vital', root.spanId],
    ['browser.javascript_error', root.spanId],
  ]);
  assert.deepEqual(envelope.spans[0].attributes, { eventType: 'navigation' });
  assert.equal(envelope.spans[0].status, 'ok');
  assert.deepEqual(Object.keys(envelope.spans[0].attributes), ['eventType']);
  assert.deepEqual(Object.keys(envelope.spans[0]).sort(), [
    'attributes', 'endTime', 'operation', 'service', 'spanId', 'startTime', 'status', 'traceId',
  ]);
});

test('拒绝非法 JSON、额外字段、未知事件字段和未脱敏 path，不转发 canary', async (t) => {
  const harness = await makeHarness(t);
  const requests = [
    { bodyText: '{"environment":' },
    { body: makeBody([makeSpan('javascript_error')], { projectKey: PRIVATE_CANARY }) },
    { body: makeBody([makeSpan('javascript_error', { extra: PRIVATE_CANARY })]) },
    { body: makeBody([makeSpan('javascript_error', { parentSpanId: 'malformed-parent' })]) },
    { body: makeBody([makeSpan('javascript_error', { parentSpanId: 'a'.repeat(32), extra: PRIVATE_CANARY })]) },
    { body: makeBody([makeSpan('javascript_error', { parentSpanId: '1'.repeat(32), spanId: '1'.repeat(32) })]) },
    { body: makeBody([makeSpan('javascript_error', { message: PRIVATE_CANARY })]) },
    {
      body: makeBody([makeSpan('network_error', { path: '/api/users/' + PRIVATE_CANARY })]),
    },
    {
      body: makeBody([makeSpan('javascript_error', { attributes: { eventType: 'javascript_error', message: PRIVATE_CANARY } })]),
    },
    { body: makeBody([makeSpan('web_vital', { metricId: PRIVATE_CANARY })]) },
    { body: makeBody([makeSpan('javascript_error', { operation: 'browser.network_error' })]) },
    { body: makeBody([makeSpan('web_vital', { delta: -1_000_000_001 })]) },
    { body: makeBody([makeSpan('web_vital', { value: 1_000_000_001 })]) },
    {
      body: makeBody([{
        type: 'web_vital',
        service: 'web-sdk-demo',
        environment: 'dev',
        timestamp: Date.now(),
        traceId: 'trace_v1_01234567-89ab-cdef-0123-456789abcdef',
      }]),
    },
  ];
  for (const request of requests) {
    const response = await sendRequest(harness.webPort, request);
    assert.equal(response.status, 400);
    assert.equal(response.text.includes(PRIVATE_CANARY), false);
  }
  assert.equal(harness.upstreamRequests.length, 0);
});

test('body 超过 64 KiB 与 batch 超过 20 条均拒绝', async (t) => {
  const harness = await makeHarness(t);
  const oversized = JSON.stringify({
    environment: 'dev',
    spans: [makeSpan('javascript_error')],
    padding: 'x'.repeat(65 * 1024),
  });
  const oversizedResponse = await sendRequest(harness.webPort, { bodyText: oversized });
  assert.equal(oversizedResponse.status, 413);

  const tooMany = Array.from({ length: 21 }, () => makeSpan('web_vital'));
  const batchResponse = await sendRequest(harness.webPort, { body: makeBody(tooMany) });
  assert.equal(batchResponse.status, 400);
  assert.equal(harness.upstreamRequests.length, 0);
});

test('只处理精确 POST 路径；query path 歧义拒绝，其余请求交给 next', async (t) => {
  const harness = await makeHarness(t);
  const queryResponse = await sendRequest(harness.webPort, { path: ROUTE + '?fixture=' + PRIVATE_CANARY });
  assert.equal(queryResponse.status, 400);
  assert.equal(queryResponse.text.includes(PRIVATE_CANARY), false);
  assert.equal((await sendRequest(harness.webPort, { method: 'GET' })).status, 404);
  assert.equal((await sendRequest(harness.webPort, { path: '/another-path' })).status, 404);
  assert.equal(harness.upstreamRequests.length, 0);
});

test('全局请求速率限制按 relay 实例共享', async (t) => {
  const harness = await makeHarness(t, { maxRequestsPerMinute: 1 });
  assert.equal((await sendRequest(harness.webPort)).status, 202);
  const limited = await sendRequest(harness.webPort);
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.json, {
    status: 'rejected',
    message: 'Browser span relay is busy',
  });
  assert.equal(harness.upstreamRequests.length, 1);
});

test('限制并发请求数，释放后继续处理', async (t) => {
  let signalStarted;
  let release;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => {
    signalStarted();
    await gate;
    return { status: 202, body: null };
  };
  const harness = await makeHarness(t, { maxInFlight: 1, fetchImpl });
  const firstPromise = sendRequest(harness.webPort);
  await started;
  const limited = await sendRequest(harness.webPort);
  assert.equal(limited.status, 429);
  release();
  assert.equal((await firstPromise).status, 202);
});

test('上游超过 3 秒超时并中止；上游失败正文和异常不泄漏', async (t) => {
  let receivedSignal;
  const fetchImpl = async (_url, options) => {
    receivedSignal = options.signal;
    return new Promise(() => undefined);
  };
  const harness = await makeHarness(t, { timeoutMs: 40, fetchImpl });
  const timedOut = await sendRequest(harness.webPort);
  assert.equal(timedOut.status, 504);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(timedOut.text.includes(PROJECT_KEY), false);

  const failing = createBrowserSpanRelay({
    projectKey: PROJECT_KEY,
    apiPort: String(harness.apiPort),
    fetchImpl: async () => { throw new Error('upstream ' + PRIVATE_CANARY + ' ' + PROJECT_KEY); },
  });
  const failingWeb = http.createServer((req, res) => failing(req, res, () => res.end()));
  const failingPort = await listen(failingWeb);
  t.after(() => close(failingWeb));
  const failure = await sendRequest(failingPort);
  assert.equal(failure.status, 503);
  assert.equal(failure.text.includes(PRIVATE_CANARY), false);
  assert.equal(failure.text.includes(PROJECT_KEY), false);
});

test('上游非 202 或带敏感正文时只返回固定安全错误', async (t) => {
  const harness = await makeHarness(t, {
    upstreamHandler(_req, res) {
      res.statusCode = 500;
      res.end('private upstream response ' + PRIVATE_CANARY + ' ' + PROJECT_KEY);
    },
  });
  const response = await sendRequest(harness.webPort);
  assert.equal(response.status, 503);
  assert.deepEqual(response.json, {
    status: 'rejected',
    message: 'Browser span relay is unavailable',
  });
  assert.equal(response.text.includes(PRIVATE_CANARY), false);
  assert.equal(response.text.includes(PROJECT_KEY), false);
});
