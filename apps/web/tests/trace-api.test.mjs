import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';

const source = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const require = createRequire(import.meta.url);
const webVitalsUrl = pathToFileURL(join(dirname(require.resolve('web-vitals')), 'web-vitals.js')).href;
const runnableOutput = outputText.replaceAll("'web-vitals'", `'${webVitalsUrl}'`);
const api = await import(`data:text/javascript;base64,${Buffer.from(runnableOutput).toString('base64')}`);

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
  let addCount = 0;
  return {
    addEventListener(type, callback) {
      addCount += 1;
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
    count(type) {
      return listeners.get(type)?.size ?? 0;
    },
    get addCount() {
      return addCount;
    },
  };
}

function setupBrowserGlobals({ fetch = globalThis.fetch, XMLHttpRequest = undefined } = {}) {
  const window = createWindowMock();
  const restore = [
    replaceGlobal('location', { href: 'https://app.example.test/page?private=1#hash', origin: 'https://app.example.test' }),
    replaceGlobal('window', window),
    replaceGlobal('fetch', fetch),
  ];
  if (XMLHttpRequest) restore.push(replaceGlobal('XMLHttpRequest', XMLHttpRequest));
  return {
    window,
    restore() {
      api.teardownBrowserMonitoring();
      for (const undo of restore.reverse()) undo();
    },
  };
}

test('current operation Trace ID takes priority and is injected as x-trace-id', () => {
  const request = api.prepareApiRequest('/v1/spans', {
    traceId: 'trace_web_operation-1',
    headers: { 'X-Trace-Id': 'trace_web_inbound-1', 'content-type': 'application/json' },
  });

  assert.equal(request.traceId, 'trace_web_operation-1');
  assert.equal(new Headers(request.init.headers).get('x-trace-id'), 'trace_web_operation-1');
  assert.equal(new Headers(request.init.headers).get('content-type'), 'application/json');
});

test('a valid inbound request Trace ID is reused when there is no operation ID', () => {
  const request = api.prepareApiRequest(new Request('https://example.test/api', {
    headers: { 'x-trace-id': 'trace_web_inbound-2' },
  }));

  assert.equal(request.traceId, 'trace_web_inbound-2');
});

test('page meta Trace ID is reused; invalid IDs are replaced with unique IDs', () => {
  const originalDocument = globalThis.document;
  globalThis.document = { querySelector: () => ({ content: 'trace_web_page-3' }) };
  try {
    assert.equal(api.prepareApiRequest('/api').traceId, 'trace_web_page-3');
    assert.equal(api.prepareApiRequest('/api', { headers: { 'x-trace-id': 'bad value' } }).traceId, 'trace_web_page-3');
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }

  const first = api.prepareApiRequest('/api', { headers: { 'x-trace-id': 'bad value' } }).traceId;
  const second = api.prepareApiRequest('/api', { traceId: 'not a valid id' }).traceId;
  assert.notEqual(first, second);
  assert.match(first, /^trace_web_[A-Za-z0-9._:-]{1,118}$/);
  assert.equal(api.isValidTraceId('trace_web_ok.1:2-3'), true);
  assert.equal(api.isValidTraceId('trace_web_bad value'), false);
});

test('Trace ID generation fails closed when Web Crypto is unavailable', () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });

  try {
    assert.throws(() => api.createTraceId(), /Web Crypto API is required/);
  } finally {
    if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
    else delete globalThis.crypto;
  }
});

test('environment labels map to the protocol values dev/staging/prod', () => {
  assert.equal(api.toProtocolEnvironment('development'), 'dev');
  assert.equal(api.toProtocolEnvironment('dev'), 'dev');
  assert.equal(api.toProtocolEnvironment('staging'), 'staging');
  assert.equal(api.toProtocolEnvironment('production'), 'prod');
  assert.equal(api.toProtocolEnvironment('prod'), 'prod');
  assert.throws(() => api.toProtocolEnvironment('all'), TypeError);
});

test('apiFetch forwards the normalized Trace ID header', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (input, init) => {
    captured = { input, init };
    return new Response(null, { status: 204 });
  };

  try {
    await api.apiFetch('/v1/spans', { traceId: 'trace_web_fetch-4' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.input, '/v1/spans');
  assert.equal(new Headers(captured.init.headers).get('x-trace-id'), 'trace_web_fetch-4');
});

test('the official Web Vitals adapter registers all five metrics with their exact names', () => {
  const registered = [];
  const delivered = [];
  const metric = {
    name: 'CLS', value: 0.12, delta: 0.12, rating: 'good', id: 'metric-1', entries: [], navigationType: 'navigate', navigationId: 1,
  };
  const callbacks = Object.fromEntries(['onCLS', 'onINP', 'onLCP', 'onFCP', 'onTTFB'].map((name) => [name, (callback) => {
    registered.push(name);
    callback(metric);
  }]));

  api.registerWebVitals((name, receivedMetric) => delivered.push([name, receivedMetric]), callbacks);

  assert.deepEqual(registered, ['onCLS', 'onINP', 'onLCP', 'onFCP', 'onTTFB']);
  assert.deepEqual(delivered.map(([name]) => name), ['CLS', 'INP', 'LCP', 'FCP', 'TTFB']);
  assert.ok(delivered.every(([, receivedMetric]) => receivedMetric === metric));
});

test('same-origin fetch injects Trace ID and emits only sanitized network metadata', async () => {
  const body = JSON.stringify({ prompt: 'PROMPT_SENTINEL' });
  const fetchCalls = [];
  const nativeFetch = async (input, init) => {
    fetchCalls.push({ input, init });
    if (String(input).includes('/fail/')) throw new Error('RESPONSE_SENTINEL Authorization: secret-value');
    return new Response('RESPONSE_SENTINEL', { status: 503 });
  };
  const browser = setupBrowserGlobals({ fetch: nativeFetch });
  const events = [];
  const transportedEvents = [];
  const monitor = api.initBrowserMonitoring({
    service: 'customer-web', environment: 'dev', captureWebVitals: false,
    onEvent: (event) => events.push(event),
    transport(event) { transportedEvents.push(event); },
  });

  try {
    const response = await globalThis.fetch('/api/v1/chat/private-prompt?token=secret#private', {
      method: 'post', headers: { authorization: 'hidden-auth', 'content-type': 'application/json' }, body,
    });
    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'RESPONSE_SENTINEL');
    assert.equal(fetchCalls[0].init.body, body);
    assert.ok(api.isValidTraceId(new Headers(fetchCalls[0].init.headers).get('x-trace-id')));

    await assert.rejects(globalThis.fetch('/api/v1/fail/user-input?secret=query', { method: 'GET' }), /RESPONSE_SENTINEL/);
    assert.equal(events.length, 2);
    assert.equal(transportedEvents.length, 2);
    assert.deepEqual(events.map((event) => [event.type, event.reason, event.status]), [
      ['network_error', 'http', 503],
      ['network_error', 'network', 0],
    ]);
    assert.equal(events[0].method, 'POST');
    assert.equal(events[0].path, '/api/v1/chat/:id');
    assert.equal(events[0].traceId, new Headers(fetchCalls[0].init.headers).get('x-trace-id'));
    assert.equal(events[0].service, 'customer-web');
    assert.equal(events[0].environment, 'dev');
    assert.equal(events[0].durationMs >= 0, true);
    assert.equal(fetchCalls.length, 2);
    for (const event of events) {
      const serialized = JSON.stringify(event);
      assert.equal(serialized.includes('PROMPT_SENTINEL'), false);
      assert.equal(serialized.includes('RESPONSE_SENTINEL'), false);
      assert.equal(serialized.includes('hidden-auth'), false);
      assert.equal(serialized.includes('secret'), false);
      assert.equal('body' in event, false);
      assert.equal('headers' in event, false);
    }
  } finally {
    monitor.teardown();
    browser.restore();
  }
});

test('same-origin XHR injects a single valid ID and emits no body or header values', () => {
  class MockXhr {
    status = 418;
    headers = [];
    listeners = new Map();
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers.push([name, value]);
    }
    send(body) {
      this.body = body;
    }
    addEventListener(type, callback) {
      const callbacks = this.listeners.get(type) ?? new Set();
      callbacks.add(callback);
      this.listeners.set(type, callbacks);
    }
    removeEventListener(type, callback) {
      this.listeners.get(type)?.delete(callback);
    }
    dispatch(type) {
      for (const callback of [...(this.listeners.get(type) ?? [])]) callback();
    }
  }
  const browser = setupBrowserGlobals({ XMLHttpRequest: MockXhr });
  const events = [];
  const monitor = api.initBrowserMonitoring({
    service: 'web', environment: 'staging', captureWebVitals: false, onEvent: (event) => events.push(event),
  });

  try {
    const xhr = new globalThis.XMLHttpRequest();
    xhr.open('POST', '/api/v1/users/prompt-text?key=private');
    xhr.setRequestHeader('x-trace-id', 'trace_web_existing-1');
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.setRequestHeader('authorization', 'AUTH_SENTINEL');
    xhr.send('BODY_SENTINEL');
    xhr.dispatch('loadend');

    const traceHeaders = xhr.headers.filter(([name]) => name.toLowerCase() === 'x-trace-id');
    assert.deepEqual(traceHeaders, [['x-trace-id', 'trace_web_existing-1']]);
    assert.equal(xhr.body, 'BODY_SENTINEL');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'network_error');
    assert.equal(events[0].source, 'xhr');
    assert.equal(events[0].reason, 'http');
    assert.equal(events[0].status, 418);
    assert.equal(events[0].path, '/api/v1/users/:id');
    assert.equal(events[0].traceId, 'trace_web_existing-1');
    assert.equal(JSON.stringify(events[0]).includes('BODY_SENTINEL'), false);
    assert.equal(JSON.stringify(events[0]).includes('AUTH_SENTINEL'), false);

    const failedXhr = new globalThis.XMLHttpRequest();
    failedXhr.status = 0;
    failedXhr.open('GET', '/api/v1/services/private-id?token=secret');
    failedXhr.send('UNREAD_BODY_SENTINEL');
    failedXhr.dispatch('loadend');
    assert.equal(events.length, 2);
    assert.equal(events[1].reason, 'network');
    assert.equal(events[1].status, 0);
    assert.equal(events[1].path, '/api/v1/services/:id');
    assert.equal(JSON.stringify(events[1]).includes('UNREAD_BODY_SENTINEL'), false);
  } finally {
    monitor.teardown();
    browser.restore();
  }
});

test('JavaScript errors and rejections emit generic safe diagnostics without raw messages', () => {
  const browser = setupBrowserGlobals();
  const events = [];
  const monitor = api.initBrowserMonitoring({
    service: 'web', environment: 'prod', captureWebVitals: false, onEvent: (event) => events.push(event),
  });

  try {
    browser.window.dispatch('error', {
      error: new TypeError('PROMPT_SENTINEL'), message: 'RESPONSE_SENTINEL',
      filename: 'https://app.example.test/api/v1/chat/private-value.js?token=secret#fragment', lineno: 14, colno: 9,
    });
    browser.window.dispatch('unhandledrejection', { reason: 'USER_INPUT_SENTINEL' });

    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'javascript_error');
    assert.equal(events[0].message, 'JavaScript error');
    assert.equal(events[0].errorName, 'TypeError');
    assert.equal(events[0].path, '/api/v1/chat/:id');
    assert.equal(events[0].line, 14);
    assert.equal(events[0].column, 9);
    assert.equal(events[1].type, 'unhandled_rejection');
    assert.equal(events[1].message, 'Unhandled promise rejection');
    assert.equal(events[1].errorName, 'Error');
    const serialized = JSON.stringify(events);
    for (const privateText of ['PROMPT_SENTINEL', 'RESPONSE_SENTINEL', 'USER_INPUT_SENTINEL', 'secret', 'fragment']) {
      assert.equal(serialized.includes(privateText), false);
    }
    assert.ok(events.every((event) => api.isValidTraceId(event.traceId)));
  } finally {
    monitor.teardown();
    browser.restore();
  }
});

test('cross-origin traffic is passed through without automatic Trace ID injection or events', async () => {
  const calls = [];
  const nativeFetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(null, { status: 204 });
  };
  class MockXhr {
    headers = [];
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers.push([name, value]); }
    send(body) { this.body = body; }
    addEventListener() {}
    removeEventListener() {}
  }
  const browser = setupBrowserGlobals({ fetch: nativeFetch, XMLHttpRequest: MockXhr });
  const events = [];
  const monitor = api.initBrowserMonitoring({
    service: 'web', environment: 'dev', captureWebVitals: false, onEvent: (event) => events.push(event),
  });

  try {
    await globalThis.fetch('https://third-party.example.test/collect?secret=query', { method: 'POST' });
    await api.apiFetch('https://third-party.example.test/api', { traceId: 'trace_web_explicit-1' });
    assert.equal(new Headers(calls[0].init.headers).has('x-trace-id'), false);
    assert.equal(new Headers(calls[1].init.headers).has('x-trace-id'), false);

    const xhr = new globalThis.XMLHttpRequest();
    xhr.open('POST', 'https://third-party.example.test/collect?secret=query');
    xhr.setRequestHeader('authorization', 'AUTH_SENTINEL');
    xhr.send('BODY_SENTINEL');
    assert.deepEqual(xhr.headers, [['authorization', 'AUTH_SENTINEL']]);
    assert.equal(events.length, 0);
  } finally {
    monitor.teardown();
    browser.restore();
  }
});

test('start is idempotent; disabled, sampled-out, and teardown states add no listeners or patches', async () => {
  const nativeFetch = async () => new Response(null, { status: 204 });
  class MockXhr {
    open() {}
    setRequestHeader() {}
    send() {}
    addEventListener() {}
    removeEventListener() {}
  }
  const originalXhrMethods = [MockXhr.prototype.open, MockXhr.prototype.setRequestHeader, MockXhr.prototype.send];
  const browser = setupBrowserGlobals({ fetch: nativeFetch, XMLHttpRequest: MockXhr });
  const onEvent = () => undefined;
  const options = { service: 'web', environment: 'dev', captureWebVitals: false, onEvent };

  try {
    const monitor = api.initBrowserMonitoring(options);
    const patchedFetch = globalThis.fetch;
    const patchedXhrMethods = [MockXhr.prototype.open, MockXhr.prototype.setRequestHeader, MockXhr.prototype.send];
    const addsAfterStart = browser.window.addCount;
    monitor.start(options);
    api.startBrowserMonitoring(options);
    assert.equal(globalThis.fetch, patchedFetch);
    assert.deepEqual([MockXhr.prototype.open, MockXhr.prototype.setRequestHeader, MockXhr.prototype.send], patchedXhrMethods);
    assert.equal(browser.window.addCount, addsAfterStart);
    assert.equal(browser.window.count('error'), 1);
    assert.equal(browser.window.count('unhandledrejection'), 1);

    monitor.teardown();
    assert.equal(globalThis.fetch, nativeFetch);
    assert.deepEqual([MockXhr.prototype.open, MockXhr.prototype.setRequestHeader, MockXhr.prototype.send], originalXhrMethods);
    assert.equal(browser.window.count('error'), 0);
    assert.equal(browser.window.count('unhandledrejection'), 0);
    await globalThis.fetch('/api/v1/health');

    monitor.start({ ...options, enabled: false });
    assert.equal(globalThis.fetch, nativeFetch);
    assert.equal(browser.window.count('error'), 0);
    monitor.teardown();

    const randomDescriptor = Object.getOwnPropertyDescriptor(Math, 'random');
    Math.random = () => 0.99;
    try {
      monitor.start({ ...options, sampleRate: 0.5 });
      assert.equal(globalThis.fetch, nativeFetch);
      assert.equal(browser.window.count('error'), 0);
      await globalThis.fetch('/api/v1/health');
    } finally {
      if (randomDescriptor) Object.defineProperty(Math, 'random', randomDescriptor);
      else delete Math.random;
    }
    assert.equal(browser.window.addCount, addsAfterStart);
  } finally {
    browser.restore();
  }
});
