import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { after, before, test } from 'node:test';
import {
  createAdminProxy,
  inspectAdminRequestTarget,
  validateAdminQuery,
  validateLocalSameOrigin,
} from '../src/admin-proxy-runtime.mjs';

const projectId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const startTime = '2026-01-01T00:00:00Z';
const endTime = '2026-01-31T00:00:00Z';
const testToken = 'synthetic-admin-token-for-tests';
const upstreamRequests = [];
let upstreamMode = { status: 200, body: JSON.stringify({ ok: true }) };
let upstreamServer;
let upstreamPort;
let proxyServer;
let proxyPort;
let missingTokenServer;
let missingTokenPort;

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
  return new Promise((resolve, reject) => {
    if (!server?.listening) return resolve();
    server.close((error) => error ? reject(error) : resolve());
  });
}

function get(path, { port = proxyPort, method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.setTimeout(2000, () => request.destroy(new Error('test request timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

function localHeaders(site = 'same-origin', origin) {
  const originValue = arguments.length < 2 ? `http://127.0.0.1:${proxyPort}` : origin;
  return {
    ...(originValue === undefined ? {} : { origin: originValue }),
    ...(site === undefined ? {} : { 'sec-fetch-site': site }),
  };
}

function boundaryRequest(options = {}) {
  const host = options.host ?? '127.0.0.1:5173';
  const origin = Object.hasOwn(options, 'origin') ? options.origin : 'http://127.0.0.1:5173';
  const site = Object.hasOwn(options, 'site') ? options.site : 'same-origin';
  const remoteAddress = options.remoteAddress ?? '127.0.0.1';
  const localPort = options.localPort ?? 5173;
  const duplicateHost = options.duplicateHost ?? false;
  const rawHeaders = ['host', host];
  if (duplicateHost) rawHeaders.push('host', host);
  if (origin !== undefined) rawHeaders.push('origin', origin);
  if (site !== undefined) rawHeaders.push('sec-fetch-site', site);
  return {
    headers: {
      host,
      ...(origin === undefined ? {} : { origin }),
      ...(site === undefined ? {} : { 'sec-fetch-site': site }),
    },
    rawHeaders,
    socket: { remoteAddress, localPort },
  };
}

function routeFor(path) {
  const inspected = inspectAdminRequestTarget(path);
  assert.ok(inspected?.valid, `expected recognized admin path: ${path}`);
  return inspected.route;
}

before(async () => {
  upstreamServer = createServer((request, response) => {
    upstreamRequests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      clientAuthorization: request.headers['x-client-authorization'],
    });
    response.statusCode = upstreamMode.status;
    for (const [name, value] of Object.entries(upstreamMode.headers ?? {})) response.setHeader(name, value);
    if (upstreamMode.location) response.setHeader('Location', upstreamMode.location);
    response.setHeader('Content-Type', upstreamMode.contentType ?? 'application/json; charset=utf-8');
    response.setHeader('Set-Cookie', 'upstream-secret=must-not-reach-browser');
    if (upstreamMode.dripEveryMs) {
      const mode = upstreamMode;
      let count = 0;
      response.write('[');
      const dripTimer = setInterval(() => {
        if (!response.destroyed) response.write(count++ === 0 ? '1' : ',1');
      }, mode.dripEveryMs);
      response.on('close', () => {
        clearInterval(dripTimer);
        mode.closed = true;
        mode.onClose?.();
      });
      return;
    }
    response.end(upstreamMode.body);
  });
  upstreamPort = await listen(upstreamServer);

  proxyServer = createServer((request, response) => createAdminProxy({
    adminToken: () => testToken,
    apiPort: () => upstreamPort,
  })(request, response, () => {
    response.statusCode = 204;
    response.end();
  }));
  proxyPort = await listen(proxyServer);

  missingTokenServer = createServer((request, response) => createAdminProxy({
    apiPort: () => upstreamPort,
  })(request, response, () => {
    response.statusCode = 204;
    response.end();
  }));
  missingTokenPort = await listen(missingTokenServer);
});

after(async () => {
  await Promise.all([close(proxyServer), close(missingTokenServer), close(upstreamServer)]);
});

test('accepts only exact admin route shapes in origin-form', () => {
  const accepted = [
    '/api/v1/projects',
    '/api/v1/overview',
    '/api/v1/metrics/overview',
    '/api/v1/metrics/ai',
    '/api/v1/traces',
    '/api/v1/traces/trace_v1_abc-123',
  ];
  for (const path of accepted) assert.equal(inspectAdminRequestTarget(path)?.valid, true, path);

  const rejected = [
    '/api/v1/projects/',
    '/api/v1/projects/project-1/keys',
    '/api/v1/metrics/overview/export',
    '/api/v1/traces/trace_v1_abc/nested',
    '/api/v1/traces/',
    '/api/v1/%70rojects',
    '/api/v1/projects\\..\\traces',
    '//outside.example/api/v1/projects',
    'http://outside.example/api/v1/projects',
    '/api/v1/projects#fragment',
  ];
  for (const path of rejected) {
    const inspected = inspectAdminRequestTarget(path);
    assert.ok(!inspected?.valid, path);
  }
  assert.equal(inspectAdminRequestTarget('/api/v1/other'), undefined);

  const viteStaticTargets = [
    '/',
    '/src/components/ui.tsx',
    '/@vite/client',
    '/@vite/env',
    '/@fs/D:/repo/node_modules/.vite/deps/vite/client/env.mjs',
    '/node_modules/.vite/deps/react.js',
    '/assets/index.js',
    '/favicon.svg',
  ];
  for (const path of viteStaticTargets) assert.equal(inspectAdminRequestTarget(path), undefined, path);
});

test('projects and legacy overview queries follow their exact DTO field sets', () => {
  assert.equal(validateAdminQuery(routeFor('/api/v1/projects'), '').valid, true);
  assert.equal(validateAdminQuery(routeFor('/api/v1/projects'), 'debug=true').valid, false);
  assert.equal(validateAdminQuery(routeFor('/api/v1/overview'), `projectId=${projectId}`).valid, true);
  assert.equal(validateAdminQuery(routeFor('/api/v1/overview'), `projectId=${projectId}&environment=all&range=7d`).valid, true);
  assert.equal(validateAdminQuery(routeFor('/api/v1/overview'), `projectId=${projectId}&includeContent=false`).valid, false);
  assert.equal(validateAdminQuery(routeFor('/api/v1/overview'), 'projectId=not-a-uuid').valid, false);
  assert.equal(validateAdminQuery(routeFor('/api/v1/overview'), `projectId=${projectId}&environment=qa`).valid, false);
});

test('metrics query validation matches metrics-query.ts fields, range modes, and bounds', () => {
  const overview = routeFor('/api/v1/metrics/overview');
  const ai = routeFor('/api/v1/metrics/ai');
  const valid = [
    `projectId=${projectId}`,
    `projectId=${projectId}&environment=all&range=24h&service=assistant-api&groupBy=service`,
    `projectId=${projectId}&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent(endTime)}`,
    `projectId=${projectId}&service=`,
  ];
  for (const query of valid) {
    assert.equal(validateAdminQuery(overview, query).valid, true, query);
    assert.equal(validateAdminQuery(ai, query).valid, true, query);
  }

  const invalid = [
    '',
    `projectId=${projectId}&unknown=x`,
    `projectId=${projectId}&environment=production`,
    `projectId=${projectId}&range=30d`,
    `projectId=${projectId}&groupBy=model`,
    `projectId=${projectId}&projectId=${projectId}`,
    `projectId=${projectId}&projectId%00=${projectId}`,
    `projectId=${projectId}&range=24h&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent(endTime)}`,
    `projectId=${projectId}&from=${encodeURIComponent(startTime)}`,
    `projectId=${projectId}&from=${encodeURIComponent(endTime)}&to=${encodeURIComponent(startTime)}`,
    `projectId=${projectId}&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent('2026-02-01T00:00:00Z')}`,
    `projectId=${projectId}&service=${encodeURIComponent(` ${'a'.repeat(119)}`)}`,
    `projectId=${projectId}&service=${'a'.repeat(121)}`,
    `projectId=${projectId}&service=%00`,
    `projectId=${projectId}&range=24h&range=7d`,
    `projectId=${projectId}&service=%E0%A4%A`,
  ];
  for (const query of invalid) {
    assert.equal(validateAdminQuery(overview, query).valid, false, query);
    assert.equal(validateAdminQuery(ai, query).valid, false, query);
  }
});

test('trace list validation applies required window, page bounds, filters, and strict query keys', () => {
  const route = routeFor('/api/v1/traces');
  const valid = [
    `projectId=${projectId}&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent(endTime)}`,
    `projectId=${projectId}&environment=dev&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent(endTime)}&traceId=trace_v1_abc-123&service=api&status=error&page=100&pageSize=100`,
    `projectId=${projectId}&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent(endTime)}&page=101&pageSize=100`,
  ];
  for (const query of valid) assert.equal(validateAdminQuery(route, query).valid, true, query);

  const invalid = [
    `projectId=${projectId}&from=${encodeURIComponent(startTime)}`,
    `projectId=${projectId}&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent('2026-02-01T00:00:00Z')}`,
    `projectId=${projectId}&from=${encodeURIComponent(endTime)}&to=${encodeURIComponent(startTime)}`,
    `projectId=${projectId}&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent(endTime)}&includeContent=false`,
    `projectId=${projectId}&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent(endTime)}&traceId=has%20space`,
    `projectId=${projectId}&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent(endTime)}&status=unknown`,
    `projectId=${projectId}&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent(endTime)}&page=0`,
    `projectId=${projectId}&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent(endTime)}&page=1001`,
    `projectId=${projectId}&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent(endTime)}&page=102&pageSize=100`,
    `projectId=${projectId}&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent(endTime)}&pageSize=101`,
  ];
  for (const query of invalid) assert.equal(validateAdminQuery(route, query).valid, false, query);
});

test('trace detail requires project and concrete environment and forbids content reads', () => {
  const route = routeFor('/api/v1/traces/trace_v1_abc-123');
  assert.equal(validateAdminQuery(route, `projectId=${projectId}&environment=staging`).valid, true);
  assert.equal(validateAdminQuery(route, `projectId=${projectId}&environment=prod&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent(endTime)}&includeContent=false`).valid, true);
  assert.deepEqual(
    validateAdminQuery(route, `projectId=${projectId}&environment=dev&includeContent=true`).status,
    403,
  );
  for (const query of [
    `projectId=${projectId}&environment=all`,
    `projectId=${projectId}`,
    `projectId=${projectId}&environment=dev&from=${encodeURIComponent(startTime)}`,
    `projectId=${projectId}&environment=dev&includeContent=yes`,
    `projectId=${projectId}&environment=dev&attributes=true`,
  ]) {
    assert.equal(validateAdminQuery(route, query).valid, false, query);
  }
  assert.equal(validateAdminQuery({ ...route, traceId: 'bad/id' }, `projectId=${projectId}&environment=dev`).valid, false);
});

test('query parser rejects duplicate, array, malformed encoding, and oversized inputs', () => {
  const route = routeFor('/api/v1/metrics/ai');
  for (const query of [
    `projectId=${projectId}&projectId=${projectId}`,
    `projectId=${projectId}&service[]=api`,
    `projectId=${projectId}&service=%ZZ`,
    `projectId=${projectId}&${'x'.repeat(4097)}=1`,
    `projectId=${projectId}&&range=1h`,
  ]) assert.equal(validateAdminQuery(route, query).valid, false, query.slice(0, 80));
});

test('local same-origin boundary accepts only same-origin browser fetch metadata', () => {
  assert.deepEqual(validateLocalSameOrigin(boundaryRequest()), { ok: true });
  assert.deepEqual(validateLocalSameOrigin(boundaryRequest({ site: 'same-origin', origin: 'http://127.0.0.1:5173' })), { ok: true });
  assert.deepEqual(validateLocalSameOrigin(boundaryRequest({ site: 'same-origin', origin: undefined })), { ok: true });
  assert.equal(validateLocalSameOrigin(boundaryRequest({ site: 'none' })).ok, false);
  assert.equal(validateLocalSameOrigin(boundaryRequest({ site: undefined, origin: undefined })).ok, false);
});

test('local same-origin boundary rejects cross-site, same-site, foreign Origin, and hostile Host', () => {
  for (const request of [
    boundaryRequest({ site: 'cross-site' }),
    boundaryRequest({ site: 'same-site', origin: 'http://127.0.0.1:5173' }),
    boundaryRequest({ site: 'same-origin', origin: 'http://evil.example' }),
    boundaryRequest({ site: undefined, origin: 'http://localhost:5173' }),
    boundaryRequest({ host: 'evil.example:5173', site: 'same-origin', origin: 'http://evil.example:5173' }),
    boundaryRequest({ host: '127.0.0.1:5173', site: 'same-origin', origin: 'http://127.0.0.1:5173', localPort: 5174 }),
    boundaryRequest({ host: '127.0.0.1:5173', site: 'same-origin', duplicateHost: true }),
    boundaryRequest({ site: 'none', origin: 'http://127.0.0.1:5173' }),
    boundaryRequest({ site: undefined, origin: undefined, remoteAddress: '192.168.1.3' }),
  ]) assert.equal(validateLocalSameOrigin(request).ok, false);
});

test('middleware requires same-origin fetch metadata and permits an omitted Origin', async () => {
  const cases = [
    { name: 'same-origin fetch', headers: localHeaders(), expectedStatus: 200 },
    { name: 'same-origin fetch without Origin', headers: localHeaders('same-origin', undefined), expectedStatus: 200 },
    { name: 'direct API navigation', headers: localHeaders('none', undefined), expectedStatus: 403 },
    { name: 'headerless loopback curl', headers: {}, expectedStatus: 403 },
  ];
  for (const entry of cases) {
    const response = await get('/api/v1/projects', { headers: entry.headers });
    assert.equal(response.status, entry.expectedStatus, entry.name);
    if (entry.expectedStatus === 200) assert.deepEqual(JSON.parse(response.body), { ok: true });
  }
});

test('middleware rejects cross-origin requests and does not contact the API', async () => {
  const beforeCount = upstreamRequests.length;
  for (const headers of [
    localHeaders('cross-site', 'http://evil.example'),
    localHeaders('same-site', 'http://other.localhost:5173'),
    localHeaders('same-origin', 'http://evil.example'),
  ]) {
    const response = await get('/api/v1/projects', { headers });
    assert.equal(response.status, 403);
    assert.doesNotMatch(response.body, /synthetic-admin-token|upstream-secret/);
  }
  assert.equal(upstreamRequests.length, beforeCount);
});

test('middleware forwards only validated allowlisted GETs with the server token', async () => {
  const beforeCount = upstreamRequests.length;
  const cases = [
    ['/api/v1/projects', '/api/v1/projects'],
    [`/api/v1/overview?projectId=${projectId}&environment=staging&range=24h`, `/api/v1/overview?projectId=${projectId}&environment=staging&range=24h`],
    [`/api/v1/metrics/overview?projectId=${projectId}&groupBy=service`, `/api/v1/metrics/overview?projectId=${projectId}&groupBy=service`],
    [`/api/v1/metrics/ai?projectId=${projectId}&service=api`, `/api/v1/metrics/ai?projectId=${projectId}&service=api`],
    [`/api/v1/traces?projectId=${projectId}&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent(endTime)}`, `/api/v1/traces?projectId=${projectId}&from=${encodeURIComponent(startTime)}&to=${encodeURIComponent(endTime)}`],
    [`/api/v1/traces/trace_v1_abc-123?projectId=${projectId}&environment=dev`, `/api/v1/traces/trace_v1_abc-123?projectId=${projectId}&environment=dev`],
  ];

  for (const [path, expectedPath] of cases) {
    const response = await get(path, {
      headers: { ...localHeaders(), authorization: 'Bearer browser-supplied-value' },
    });
    assert.equal(response.status, 200, path);
    assert.deepEqual(JSON.parse(response.body), { ok: true });
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.headers.authorization, undefined);
  }

  const forwarded = upstreamRequests.slice(beforeCount);
  assert.equal(forwarded.length, cases.length);
  for (const request of forwarded) {
    assert.equal(request.method, 'GET');
    assert.equal(request.authorization, `Bearer ${testToken}`);
    assert.equal(request.clientAuthorization, undefined);
  }
  for (let index = 0; index < cases.length; index++) assert.equal(forwarded[index].url, cases[index][1]);
});

test('middleware blocks POST, unknown query fields, includeContent=true, and non-admin SDK paths', async () => {
  const beforeCount = upstreamRequests.length;
  const post = await get('/api/v1/projects', { method: 'POST', headers: localHeaders(), body: '{}' });
  assert.equal(post.status, 405);
  const unknown = await get(`/api/v1/metrics/ai?projectId=${projectId}&includeContent=true`, { headers: localHeaders() });
  assert.equal(unknown.status, 400);
  const content = await get(`/api/v1/traces/trace_v1_abc?projectId=${projectId}&environment=dev&includeContent=true`, { headers: localHeaders() });
  assert.equal(content.status, 403);
  const nonAdmin = await get('/api/v1/spans', { method: 'POST', body: '{}' });
  assert.equal(nonAdmin.status, 204);
  for (const path of [
    '/',
    '/src/components/ui.tsx',
    '/@vite/client',
    '/@vite/env',
    '/@fs/D:/repo/node_modules/.vite/deps/vite/client/env.mjs',
    '/node_modules/.vite/deps/react.js',
    '/assets/index.js',
    '/favicon.svg',
  ]) {
    const response = await get(path);
    assert.equal(response.status, 204, path);
  }
  assert.equal(upstreamRequests.length, beforeCount);
});

test('missing server token fails closed with a safe configuration hint', async () => {
  const beforeCount = upstreamRequests.length;
  const response = await get('/api/v1/projects', {
    port: missingTokenPort,
    headers: localHeaders('same-origin', `http://127.0.0.1:${missingTokenPort}`),
  });
  assert.equal(response.status, 401);
  assert.match(response.body, /PLATFORM_ADMIN_TOKEN/);
  assert.match(response.body, /生产环境请使用正式 BFF/);
  assert.doesNotMatch(response.body, /synthetic-admin-token/);
  assert.equal(upstreamRequests.length, beforeCount);
});

test('upstream errors and redirects are sanitized and never expose redirect headers', async () => {
  upstreamMode = {
    status: 500,
    body: JSON.stringify({ message: 'database password=upstream-secret diagnostic' }),
  };
  const failure = await get('/api/v1/projects', { headers: localHeaders() });
  assert.equal(failure.status, 500);
  assert.doesNotMatch(failure.body, /database|password|upstream-secret/);

  upstreamMode = {
    status: 302,
    body: 'redirect body with upstream-secret',
    location: 'http://outside.example/?token=upstream-secret',
  };
  const redirect = await get('/api/v1/projects', { headers: localHeaders() });
  assert.equal(redirect.status, 502);
  assert.equal(redirect.headers.location, undefined);
  assert.doesNotMatch(redirect.body, /outside.example|upstream-secret/);

  upstreamMode = { status: 200, body: JSON.stringify({ ok: true }) };
});

test('oversized and malformed upstream success bodies are rejected with fixed errors', async () => {
  upstreamMode = { status: 200, body: JSON.stringify('x'.repeat(128)) };
  const proxy = createServer((request, response) => createAdminProxy({
    adminToken: testToken,
    apiPort: upstreamPort,
    maxResponseBytes: 32,
  })(request, response, () => response.end()));
  const port = await listen(proxy);
  try {
    const oversized = await get('/api/v1/projects', { port, headers: { ...localHeaders('same-origin', `http://127.0.0.1:${port}`) } });
    assert.equal(oversized.status, 502);
    assert.doesNotMatch(oversized.body, /x{40}/);
  } finally {
    await close(proxy);
  }

  upstreamMode = { status: 200, body: 'not-json' };
  const malformed = await get('/api/v1/projects', { headers: localHeaders() });
  assert.equal(malformed.status, 502);
  assert.doesNotMatch(malformed.body, /not-json/);
  upstreamMode = { status: 200, body: JSON.stringify({ ok: true }) };
});

test('absolute deadline stops a response that keeps dripping before the idle timeout', async () => {
  let notifyClosed;
  const upstreamClosed = new Promise((resolve) => { notifyClosed = resolve; });
  const mode = {
    status: 200,
    body: '',
    dripEveryMs: 25,
    onClose: notifyClosed,
  };
  upstreamMode = mode;
  const proxy = createServer((request, response) => createAdminProxy({
    adminToken: testToken,
    apiPort: upstreamPort,
    timeoutMs: 180,
  })(request, response, () => response.end()));
  const port = await listen(proxy);
  const startedAt = Date.now();
  try {
    const response = await get('/api/v1/projects', {
      port,
      headers: localHeaders('same-origin', `http://127.0.0.1:${port}`),
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(response.status, 504);
    assert.ok(elapsedMs >= 120 && elapsedMs < 1000, `deadline response took ${elapsedMs}ms`);
    await Promise.race([upstreamClosed, new Promise((resolve) => setTimeout(resolve, 1000))]);
    assert.equal(mode.closed, true, 'deadline must close the upstream response');
  } finally {
    await close(proxy);
    upstreamMode = { status: 200, body: JSON.stringify({ ok: true }) };
  }
});

test('legacy path helper remains path-only for overview-api.test.mjs compatibility', async () => {
  const { readFile } = await import('node:fs/promises');
  const ts = await import('typescript');
  const source = await readFile(new URL('../src/admin-proxy.ts', import.meta.url), 'utf8');
  const compiled = ts.default.transpileModule(source, {
    compilerOptions: { module: ts.default.ModuleKind.ESNext, target: ts.default.ScriptTarget.ES2022 },
  }).outputText;
  const legacy = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

  assert.equal(legacy.isAdminReadRequest('GET', '/api/v1/projects'), true);
  assert.equal(legacy.isAdminReadRequest('get', '/api/v1/overview?range=24h'), true);
  assert.equal(legacy.isAdminReadRequest('GET', '/api/v1/projects/'), true);
  assert.equal(legacy.isAdminReadRequest('GET', `/api/v1/metrics/ai?includeContent=true`), true);
  assert.equal(legacy.isAdminReadRequest('GET', '/api/v1/traces/trace_v1_abc'), true);
  assert.equal(legacy.isAdminReadRequest('POST', '/api/v1/projects'), false);
  assert.equal(legacy.isAdminReadRequest('GET', '/api/v1/projects/project-1/keys'), false);
  assert.equal(legacy.isAdminReadRequest('GET', 'http://outside.example/api/v1/projects'), false);
});
