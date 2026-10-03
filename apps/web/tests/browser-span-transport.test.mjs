import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';

const transportSource = await readFile(new URL('../src/browser-span-transport.ts', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
const sdkTestSource = await readFile(new URL('../src/sdk-test.ts', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const webVitalsUrl = pathToFileURL(join(dirname(require.resolve('web-vitals')), 'web-vitals.js')).href;
let moduleInstance = 0;

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function toDataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

const fallbackFetchModule = toDataModule(`
  export function getUnpatchedFetch() {
    const fetcher = globalThis.fetch;
    return typeof fetcher === 'function' ? fetcher.bind(globalThis) : undefined;
  }
`);

function apiModuleUrl() {
  const output = transpile(apiSource).replaceAll("'web-vitals'", `'${webVitalsUrl}'`);
  return toDataModule(`${output}\n// instance ${moduleInstance++}`);
}

async function loadTransport(apiUrl = fallbackFetchModule) {
  const source = transportSource.replace("from './api';", `from '${apiUrl}';`);
  const output = `${transpile(source)}\n// instance ${moduleInstance++}`;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

function replaceGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
}

function createWindowMock() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) ?? new Set();
      callbacks.add(callback);
      listeners.set(type, callbacks);
    },
    removeEventListener(type, callback) {
      listeners.get(type)?.delete(callback);
    },
    dispatch(type, event) {
      for (const callback of [...(listeners.get(type) ?? [])]) callback(event);
    },
  };
}

function installTestBrowser(fetchImpl) {
  const window = createWindowMock();
  const intervals = [];
  const restores = [
    replaceGlobal('location', { href: 'https://app.example.test/sdk-test.html', origin: 'https://app.example.test' }),
    replaceGlobal('fetch', fetchImpl),
    replaceGlobal('window', window),
    replaceGlobal('crypto', webcrypto),
    replaceGlobal('setInterval', (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      intervals.push(timer);
      return timer;
    }),
    replaceGlobal('clearInterval', (timer) => { timer.cleared = true; }),
  ];
  return {
    window,
    intervals,
    restore() {
      for (const restore of restores.reverse()) restore();
    },
  };
}

const traceId = 'trace_web_sdk_test-1';
const eventTime = 1_790_280_000_125;

function makeEvent(type = 'network_error', overrides = {}) {
  const base = {
    service: 'web-sdk-demo',
    environment: 'dev',
    timestamp: eventTime,
    traceId,
  };
  if (type === 'navigation') {
    return {
      ...base,
      type,
      spanId: '1'.repeat(32),
      startTime: eventTime - 250,
      ...overrides,
    };
  }
  if (type === 'web_vital') {
    return {
      ...base,
      type,
      metric: 'LCP',
      value: 1_234.5,
      delta: 21.5,
      rating: 'good',
      metricId: 'METRIC_ID_PRIVATE_SENTINEL',
      ...overrides,
    };
  }
  if (type === 'javascript_error') {
    return {
      ...base,
      type,
      message: 'RAW_ERROR_MESSAGE_PRIVATE_SENTINEL',
      errorName: 'TypeError',
      path: '/api/v1/chat/:id',
      line: 12,
      column: 3,
      ...overrides,
    };
  }
  if (type === 'unhandled_rejection') {
    return {
      ...base,
      type,
      message: 'RAW_REJECTION_PRIVATE_SENTINEL',
      errorName: 'Error',
      ...overrides,
    };
  }
  return {
    ...base,
    type: 'network_error',
    source: 'fetch',
    reason: 'http',
    method: 'POST',
    status: 503,
    durationMs: 25,
    path: '/api/v1/chat/:id',
    ...overrides,
  };
}

test('the converter maps real SDK event kinds into strict spans and only whitelisted attributes', async () => {
  const transport = await loadTransport();
  const cases = [
    ['navigation', 'browser.navigation', 'ok'],
    ['web_vital', 'browser.web_vital', 'ok'],
    ['javascript_error', 'browser.javascript_error', 'error'],
    ['unhandled_rejection', 'browser.unhandled_rejection', 'error'],
    ['network_error', 'browser.network_error', 'error'],
  ];

  for (const [type, operation, status] of cases) {
    const span = transport.convertBrowserMonitorEventToSpan(makeEvent(type));
    assert.ok(span);
    assert.deepEqual(Object.keys(span).sort(), ['attributes', 'endTime', 'operation', 'service', 'spanId', 'startTime', 'status', 'traceId']);
    assert.equal(span.operation, operation);
    assert.equal(span.attributes.eventType, type);
    assert.equal(span.status, status);
    assert.equal(span.service, 'web-sdk-demo');
    assert.equal(span.endTime, eventTime);
    assert.match(span.spanId, /^[a-f0-9]{32}$/);
    if (type === 'navigation') {
      assert.equal(span.spanId, '1'.repeat(32));
      assert.equal(span.startTime, eventTime - 250);
    }
    assert.equal('parentId' in span, false);
    assert.equal('parentSpanId' in span, false);
    assert.equal('tokenUsage' in span, false);
    assert.equal('error' in span, false);
  }

  const vital = transport.convertBrowserMonitorEventToSpan(makeEvent('web_vital'));
  assert.deepEqual(vital.attributes, {
    eventType: 'web_vital', metric: 'LCP', value: 1_234.5, delta: 21.5, rating: 'good',
  });
  const network = transport.convertBrowserMonitorEventToSpan(makeEvent('network_error'));
  assert.equal(network.startTime, eventTime - 25);
  assert.deepEqual(network.attributes, {
    eventType: 'network_error', source: 'fetch', reason: 'http', method: 'POST',
    path: '/api/v1/chat/:id', httpStatus: 503,
  });

  const parentSpanId = 'a'.repeat(32);
  const child = transport.convertBrowserMonitorEventToSpan(makeEvent('web_vital', { parentSpanId }));
  assert.equal(child.parentSpanId, parentSpanId);
  assert.equal(child.operation, 'browser.web_vital');

  const serialized = JSON.stringify(cases.map(([type]) => transport.convertBrowserMonitorEventToSpan(makeEvent(type))));
  for (const sentinel of [
    'METRIC_ID_PRIVATE_SENTINEL', 'RAW_ERROR_MESSAGE_PRIVATE_SENTINEL', 'RAW_REJECTION_PRIVATE_SENTINEL',
    'AUTH_PRIVATE_SENTINEL', 'headers', 'body',
  ]) assert.equal(serialized.includes(sentinel), false);
});

test('the converter rejects foreign service or environment and defensively drops unsafe paths', async () => {
  const transport = await loadTransport();
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('javascript_error', { service: 'other-service' })), undefined);
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('javascript_error', { environment: 'prod' })), undefined);

  const span = transport.convertBrowserMonitorEventToSpan(makeEvent('javascript_error', {
    path: '/api/v1/chat/RAW_PATH_PRIVATE_SENTINEL?token=secret#fragment',
  }));
  assert.ok(span);
  assert.equal('path' in span.attributes, false);
  assert.equal(JSON.stringify(span).includes('RAW_PATH_PRIVATE_SENTINEL'), false);
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('web_vital', { value: -0.1 })), undefined);
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('web_vital', { value: 1e9 + 1 })), undefined);
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('web_vital', { delta: -1e9 - 1 })), undefined);
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('javascript_error', { timestamp: 8.64e15 + 1 })), undefined);
  assert.equal('line' in transport.convertBrowserMonitorEventToSpan(makeEvent('javascript_error', { line: 1e7 + 1 })).attributes, false);
  const negativeDelta = transport.convertBrowserMonitorEventToSpan(makeEvent('web_vital', { delta: -0.1 }));
  assert.equal(negativeDelta.attributes.delta, -0.1);
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('network_error', { status: 200 })), undefined);
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('network_error', { status: 302 })).attributes.httpStatus, 302);
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('network_error', { status: 199 })).attributes.httpStatus, 199);
  const networkFailure = transport.convertBrowserMonitorEventToSpan(makeEvent('network_error', {
    reason: 'network', status: 0,
  }));
  assert.equal('httpStatus' in networkFailure.attributes, false);
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('network_error', { durationMs: 300_001 })), undefined);
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('javascript_error', { parentSpanId: 'invalid-parent' })), undefined);
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('javascript_error', { extraField: 'not-allowlisted' })), undefined);
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('network_error', { body: 'BODY_PRIVATE_SENTINEL' })), undefined);
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('navigation', { url: 'https://private.example/path' })), undefined);
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('navigation', { parentSpanId: 'a'.repeat(32) })), undefined);
  assert.equal(transport.convertBrowserMonitorEventToSpan(makeEvent('navigation', { spanId: 'not-a-span-id' })), undefined);
});

test('SDK page clears a disposed relay snapshot when the next session starts local-only', async () => {
  const fakeApiModule = toDataModule(`
    let latestMonitorOptions;
    export function createTraceId() { return 'trace_web_lifecycle-1'; }
    export function isValidTraceId(value) { return typeof value === 'string' && value.startsWith('trace_web_'); }
    export function initBrowserMonitoring(options) { latestMonitorOptions = options; }
    export function teardownBrowserMonitoring() {}
    export function getLatestMonitorOptions() { return latestMonitorOptions; }
  `);
  const fakeTransportModule = toDataModule(`
    export const BROWSER_SPAN_ENDPOINT = '/__sdk_test__/spans';
    export const BROWSER_SPAN_ENVIRONMENT = 'dev';
    export const BROWSER_SPAN_SERVICE = 'web-sdk-demo';
    const instances = [];
    export function getInstances() { return instances; }
    export function createBrowserSpanTransport(options) {
      let status = { state: 'idle', queueSize: 0, inFlight: 0, apiQueuedCount: 0, droppedCount: 0, failedCount: 0 };
      const instance = {
        transport() {
          status = { ...status, state: 'queued_in_memory', queueSize: 1 };
          options.onStatusChange(status);
        },
        flush() {
          status = { ...status, state: 'queued_in_memory', queueSize: 0, apiQueuedCount: 1, lastDelivery: 'queued_in_memory' };
          options.onStatusChange(status);
          return Promise.resolve();
        },
        dispose() {
          status = { ...status, state: 'disposed', queueSize: 0 };
          options.onStatusChange(status);
        },
        getStatus() { return status; },
      };
      instances.push(instance);
      return instance;
    }
  `);

  function element() {
    const listeners = new Map();
    return {
      checked: false,
      disabled: false,
      dataset: {},
      children: [],
      textContent: '',
      className: '',
      addEventListener(type, callback) {
        const callbacks = listeners.get(type) ?? [];
        callbacks.push(callback);
        listeners.set(type, callbacks);
      },
      dispatch(type) { for (const callback of listeners.get(type) ?? []) callback({ target: this }); },
      querySelector() { return this.innerSpan; },
      replaceChildren(...children) { this.children = [...children]; },
      append(...children) { this.children.push(...children); },
      setAttribute() {},
      remove() {},
    };
  }

  const ids = [
    '#start-sdk', '#stop-sdk', '#capture-errors', '#capture-vitals', '#server-relay', '#flush-spans',
    '#transport-state', '#transport-detail', '#sdk-state', '#current-trace-id', '#trace-valid', '#event-count',
    '#trace-check', '#privacy-check', '#event-list', '#event-json', '#trigger-fetch', '#trigger-js-error',
    '#trigger-rejection', '#clear-events',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, element()]));
  elements['#sdk-state'].innerSpan = element();
  const scenarios = [element(), element(), element()];
  const documentMock = {
    head: { append() {} },
    querySelector(selector) {
      if (selector === 'meta[name="x-trace-id"]') return null;
      return elements[selector] ?? null;
    },
    querySelectorAll(selector) { return selector === '.scenario-button' ? scenarios : []; },
    createElement() { return element(); },
  };
  const restoreDocument = replaceGlobal('document', documentMock);
  try {
    let runnable = sdkTestSource
      .replace("from './api';", `from '${fakeApiModule}';`)
      .replace("from './browser-span-transport';", `from '${fakeTransportModule}';`)
      .replace("import './sdk-test.css';", '');
    runnable = `${transpile(runnable)}\n// lifecycle ${moduleInstance++}`;
    const pageModule = await import(toDataModule(runnable));
    void pageModule;
    const fakeTransport = await import(fakeTransportModule);
    const relayToggle = elements['#server-relay'];
    assert.equal(elements['#transport-state'].textContent, '默认关闭');
    assert.equal(fakeTransport.getInstances().length, 0);
    relayToggle.checked = true;
    elements['#start-sdk'].dispatch('click');

    const fakeApi = await import(fakeApiModule);
    const firstOptions = fakeApi.getLatestMonitorOptions();
    assert.equal(firstOptions.service, 'web-sdk-demo');
    assert.equal(firstOptions.environment, 'dev');
    assert.equal(typeof firstOptions.transport, 'function');
    firstOptions.transport({});
    elements['#flush-spans'].dispatch('click');
    elements['#stop-sdk'].dispatch('click');
    assert.equal(elements['#transport-state'].textContent, '已停止');
    assert.match(elements['#transport-detail'].textContent, /累计 API 内存排队 1/);

    relayToggle.checked = false;
    relayToggle.dispatch('change');
    elements['#start-sdk'].dispatch('click');
    const secondOptions = fakeApi.getLatestMonitorOptions();
    assert.equal('transport' in secondOptions, false);
    assert.equal(fakeTransport.getInstances().length, 1);
    assert.equal(elements['#transport-state'].textContent, '默认关闭');
    assert.equal(elements['#transport-detail'].textContent, '仅本地 onEvent；不会发起平台请求。');
    elements['#stop-sdk'].dispatch('click');
  } finally {
    restoreDocument();
  }
});

test('endpoint validation accepts only same-origin paths without query or hash', async () => {
  const browser = installTestBrowser(async () => new Response(null, { status: 202 }));
  const transport = await loadTransport();
  try {
    assert.throws(() => transport.createBrowserSpanTransport({ endpoint: 'https://elsewhere.example.test/__sdk_test__/spans' }), TypeError);
    assert.throws(() => transport.createBrowserSpanTransport({ endpoint: '/__sdk_test__/spans?debug=1' }), TypeError);
    assert.throws(() => transport.createBrowserSpanTransport({ endpoint: '/__sdk_test__/spans#fragment' }), TypeError);
    assert.throws(() => transport.createBrowserSpanTransport({ endpoint: 'https://user:pass@app.example.test/__sdk_test__/spans' }), TypeError);
    const instance = transport.createBrowserSpanTransport({ endpoint: '/__sdk_test__/spans' });
    assert.equal(instance.getStatus().state, 'idle');
    assert.equal(browser.intervals.at(-1).delay, 1_000);
    instance.dispose();
    assert.equal(browser.intervals.at(-1).cleared, true);
  } finally {
    browser.restore();
  }
});

test('202 sends the exact dev payload without Authorization, cookies, or extra Span fields', async () => {
  const calls = [];
  const browser = installTestBrowser(async (input, init) => {
    calls.push({ input, init });
    return new Response(null, { status: 202 });
  });
  const transportModule = await loadTransport();
  const instance = transportModule.createBrowserSpanTransport({ endpoint: '/__sdk_test__/spans' });
  try {
    instance.transport(makeEvent('web_vital'));
    await instance.flush();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, '/__sdk_test__/spans');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.credentials, 'omit');
    assert.equal(calls[0].init.mode, 'same-origin');
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('x-trace-id'), false);

    const payload = JSON.parse(calls[0].init.body);
    assert.deepEqual(Object.keys(payload), ['environment', 'spans']);
    assert.equal(payload.environment, 'dev');
    assert.equal(payload.spans.length, 1);
    assert.deepEqual(Object.keys(payload.spans[0]).sort(), [
      'attributes', 'endTime', 'operation', 'service', 'spanId', 'startTime', 'status', 'traceId',
    ]);
    assert.equal(payload.spans[0].service, 'web-sdk-demo');
    assert.equal(payload.spans[0].operation, 'browser.web_vital');
    assert.equal(payload.spans[0].attributes.eventType, 'web_vital');
    assert.equal(instance.getStatus().lastDelivery, 'queued_in_memory');
    assert.equal(instance.getStatus().apiQueuedCount, 1);
  } finally {
    instance.dispose();
    browser.restore();
  }
});

test('the real transport submits one browser navigation root and its exception child as a trace tree', async () => {
  const calls = [];
  const browser = installTestBrowser(async (input, init) => {
    calls.push({ input, init });
    return new Response(null, { status: 202 });
  });
  const apiUrl = apiModuleUrl();
  const api = await import(apiUrl);
  const transportModule = await loadTransport(apiUrl);
  const instance = transportModule.createBrowserSpanTransport({ endpoint: '/__sdk_test__/spans' });
  const events = [];
  const monitor = api.initBrowserMonitoring({
    service: 'web-sdk-demo',
    environment: 'dev',
    captureWebVitals: false,
    onEvent: (event) => events.push(event),
    transport: (event) => instance.transport(event),
  });

  try {
    browser.window.dispatch('error', {
      error: new TypeError('PRIVATE_BROWSER_ERROR_SENTINEL'),
      filename: 'https://app.example.test/src/private.js?token=PRIVATE_QUERY_SENTINEL',
      lineno: 9,
      colno: 4,
    });
    await instance.flush();

    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'navigation');
    assert.equal(events[1].type, 'javascript_error');
    assert.equal(events[1].parentSpanId, events[0].spanId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, '/__sdk_test__/spans');
    assert.equal(calls[0].init.credentials, 'omit');
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('x-trace-id'), false);

    const payload = JSON.parse(calls[0].init.body);
    assert.equal(payload.spans.length, 2);
    const [root, child] = payload.spans;
    assert.equal(root.operation, 'browser.navigation');
    assert.equal(root.parentSpanId, undefined);
    assert.equal(root.spanId, events[0].spanId);
    assert.equal(child.operation, 'browser.javascript_error');
    assert.equal(child.parentSpanId, root.spanId);
    assert.equal(child.traceId, root.traceId);
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('PRIVATE_BROWSER_ERROR_SENTINEL'), false);
    assert.equal(serialized.includes('PRIVATE_QUERY_SENTINEL'), false);
    assert.equal(serialized.includes('PRIVATE_QUERY'), false);
  } finally {
    monitor.teardown();
    instance.dispose();
    browser.restore();
  }
});

test('batch limit is 20 and immediate flush drains multiple successful batches', async () => {
  const batches = [];
  const browser = installTestBrowser(async (_input, init) => {
    batches.push(JSON.parse(init.body).spans.length);
    return new Response(null, { status: 202 });
  });
  const transportModule = await loadTransport();
  const instance = transportModule.createBrowserSpanTransport({ endpoint: '/__sdk_test__/spans' });
  try {
    for (let index = 0; index < 21; index += 1) instance.transport(makeEvent('web_vital', { value: index }));
    await instance.flush();
    assert.deepEqual(batches, [20, 1]);
    assert.equal(instance.getStatus().apiQueuedCount, 21);
    assert.equal(instance.getStatus().failedCount, 0);
  } finally {
    instance.dispose();
    browser.restore();
  }
});

test('queue, batch, and timeout options stay bounded; overflow is counted without throwing', async () => {
  const browser = installTestBrowser(async () => new Response(null, { status: 202 }));
  const transportModule = await loadTransport();
  try {
    assert.throws(() => transportModule.createBrowserSpanTransport({ endpoint: '/__sdk_test__/spans', maxQueueSize: 101 }), RangeError);
    assert.throws(() => transportModule.createBrowserSpanTransport({ endpoint: '/__sdk_test__/spans', batchSize: 21 }), RangeError);
    assert.throws(() => transportModule.createBrowserSpanTransport({ endpoint: '/__sdk_test__/spans', timeoutMs: 3_001 }), RangeError);

    const instance = transportModule.createBrowserSpanTransport({ endpoint: '/__sdk_test__/spans', maxQueueSize: 2 });
    instance.transport(makeEvent('web_vital'));
    instance.transport(makeEvent('javascript_error'));
    assert.doesNotThrow(() => instance.transport(makeEvent('network_error')));
    assert.deepEqual(
      [instance.getStatus().queueSize, instance.getStatus().droppedCount],
      [2, 1],
    );
    instance.dispose();
    assert.equal(instance.getStatus().state, 'disposed');
    assert.equal(instance.getStatus().queueSize, 0);
    assert.equal(instance.getStatus().droppedCount, 3);
  } finally {
    browser.restore();
  }
});

test('only HTTP 202 is API memory queued; other statuses and network failures count once without retry', async (t) => {
  for (const [label, fetchImpl, expectedStatus] of [
    ['HTTP 200', async () => new Response(null, { status: 200 }), 200],
    ['HTTP 503', async () => new Response(null, { status: 503 }), 503],
    ['network rejection', async () => { throw new Error('PRIVATE_NETWORK_ERROR_SENTINEL'); }, undefined],
  ]) {
    await t.test(label, async () => {
      let calls = 0;
      const browser = installTestBrowser(async (...args) => {
        calls += 1;
        return fetchImpl(...args);
      });
      const transportModule = await loadTransport();
      const instance = transportModule.createBrowserSpanTransport({ endpoint: '/__sdk_test__/spans' });
      try {
        instance.transport(makeEvent('web_vital'));
        await instance.flush();
        assert.equal(calls, 1);
        assert.equal(instance.getStatus().failedCount, 1);
        assert.equal(instance.getStatus().apiQueuedCount, 0);
        assert.equal(instance.getStatus().lastDelivery, 'failed');
        assert.equal(instance.getStatus().lastHttpStatus, expectedStatus);
        assert.equal(instance.getStatus().queueSize, 0);
      } finally {
        instance.dispose();
        browser.restore();
      }
    });
  }
});

test('timeout aborts the request and records failure without rejecting flush', async () => {
  let requestSignal;
  const browser = installTestBrowser((_input, init) => new Promise((_resolve, reject) => {
    requestSignal = init.signal;
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const transportModule = await loadTransport();
  const instance = transportModule.createBrowserSpanTransport({ endpoint: '/__sdk_test__/spans', timeoutMs: 15 });
  try {
    instance.transport(makeEvent('web_vital'));
    await assert.doesNotReject(instance.flush());
    assert.equal(requestSignal.aborted, true);
    assert.equal(instance.getStatus().failedCount, 1);
    assert.equal(instance.getStatus().state, 'failed');
  } finally {
    instance.dispose();
    browser.restore();
  }
});

test('dispose clears queued data, aborts an active batch, and retains cumulative status', async () => {
  let requestSignal;
  const browser = installTestBrowser((_input, init) => new Promise((_resolve, reject) => {
    requestSignal = init.signal;
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const transportModule = await loadTransport();
  const instance = transportModule.createBrowserSpanTransport({ endpoint: '/__sdk_test__/spans' });
  try {
    instance.transport(makeEvent('web_vital'));
    const pendingFlush = instance.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const beforeDispose = instance.getStatus();
    instance.dispose();
    await pendingFlush;
    const afterDispose = instance.getStatus();
    assert.equal(requestSignal.aborted, true);
    assert.equal(afterDispose.state, 'disposed');
    assert.equal(afterDispose.queueSize, 0);
    assert.equal(afterDispose.droppedCount, beforeDispose.inFlight);
    assert.equal(afterDispose.failedCount, 0);
  } finally {
    instance.dispose();
    browser.restore();
  }
});

test('native fetch captured before SDK startup prevents failed transport requests from self-capturing', async () => {
  let fetchCalls = 0;
  const browser = installTestBrowser(async () => {
    fetchCalls += 1;
    throw new Error('PRIVATE_TRANSPORT_FAILURE');
  });
  const apiUrl = apiModuleUrl();
  const api = await import(apiUrl);
  const transportModule = await loadTransport(apiUrl);
  let instance;
  instance = transportModule.createBrowserSpanTransport({ endpoint: '/__sdk_test__/spans' });
  const events = [];
  const monitor = api.initBrowserMonitoring({
    service: 'web-sdk-demo',
    environment: 'dev',
    captureWebVitals: false,
    onEvent: (event) => events.push(event),
    transport: (event) => instance?.transport(event),
  });
  try {
    browser.window.dispatch('error', {
      error: new TypeError('PRIVATE_APPLICATION_ERROR'),
      filename: 'https://app.example.test/src/app.js?private=1',
      lineno: 7,
      colno: 2,
    });
    assert.equal(events.length, 2);
    await instance.flush();
    assert.equal(fetchCalls, 1);
    assert.equal(events.length, 2);
    assert.equal(instance.getStatus().failedCount, 2);
  } finally {
    monitor.teardown();
    instance.dispose();
    browser.restore();
  }
});

test('api recursion fallback is limited to the exact local relay POST path', async () => {
  const fetchCalls = [];
  const browser = installTestBrowser(async (input, init) => {
    fetchCalls.push({ input, init });
    throw new Error('PRIVATE_TRANSPORT_FAILURE');
  });
  const api = await import(apiModuleUrl());
  const events = [];
  const monitor = api.initBrowserMonitoring({
    service: 'web-sdk-demo',
    environment: 'dev',
    captureWebVitals: false,
    onEvent: (event) => events.push(event),
  });
  try {
    await assert.rejects(globalThis.fetch('/__sdk_test__/spans', { method: 'POST' }));
    assert.equal(events.length, 1);
    assert.equal(new Headers(fetchCalls[0].init.headers).has('x-trace-id'), false);

    await assert.rejects(globalThis.fetch('/__sdk_test__/spans?extra=1', { method: 'POST' }));
    assert.equal(events.length, 2);
    assert.equal(new Headers(fetchCalls[1].init.headers).has('x-trace-id'), true);
  } finally {
    monitor.teardown();
    browser.restore();
  }
});

test('transport loaded after the SDK patch still uses the underlying fetch for caller-owned endpoints', async () => {
  const fetchCalls = [];
  const browser = installTestBrowser(async (input, init) => {
    fetchCalls.push({ input, init });
    throw new Error('PRIVATE_TRANSPORT_FAILURE');
  });
  const apiUrl = apiModuleUrl();
  const api = await import(apiUrl);
  let instance;
  const events = [];
  const relay = (event) => instance?.transport(event);
  const options = {
    service: 'web-sdk-demo',
    environment: 'dev',
    captureWebVitals: false,
    onEvent: (event) => events.push(event),
  };
  const monitor = api.initBrowserMonitoring(options);
  const transportModule = await loadTransport(apiUrl);
  instance = transportModule.createBrowserSpanTransport({ endpoint: '/custom-bff/spans' });
  monitor.start({ ...options, transport: relay });
  try {
    browser.window.dispatch('error', {
      error: new TypeError('PRIVATE_APPLICATION_ERROR'),
      filename: 'https://app.example.test/src/app.js',
      lineno: 8,
      colno: 2,
    });
    await instance.flush();
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].input, '/custom-bff/spans');
    assert.equal(new Headers(fetchCalls[0].init.headers).has('x-trace-id'), false);
    assert.equal(events.length, 2);
    assert.equal(instance.getStatus().failedCount, 2);

    await assert.rejects(globalThis.fetch('/__sdk_test__/spans/other', { method: 'POST' }));
    assert.equal(events.length, 3);
  } finally {
    monitor.teardown();
    instance.dispose();
    browser.restore();
  }
});
