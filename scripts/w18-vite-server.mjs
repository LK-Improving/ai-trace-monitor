// Test-only loopback bridge: a browser request exercises real instrumented adapters.
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href);
if (process.env.TRACE_OPS_RUN_INTEGRATION !== '1') throw new Error('Integration opt-in required');
const fixture = new URL(process.env.W18_FIXTURE_URL);
if (fixture.hostname !== '127.0.0.1') throw new Error('Loopback fixture required');
const server = await createServer({
  root: path.join(root, 'apps/web'),
  configFile: path.join(root, 'apps/web/vite.config.ts'),
  server: { host: '127.0.0.1', port: Number(process.env.W18_WEB_PORT), strictPort: true },
  plugins: [{ name: 'w18-browser-fixture', configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      if (!request.url?.startsWith('/__w18_')) return next();
      const expectedHost = `127.0.0.1:${process.env.W18_WEB_PORT}`;
      if (request.headers.host !== expectedHost
        || (request.headers.origin && request.headers.origin !== `http://${expectedHost}`)
        || request.headers['sec-fetch-site'] === 'cross-site') {
        response.writeHead(403).end(); return;
      }
      if (request.method === 'GET' && request.url === '/__w18_session__') {
        try {
          const session = JSON.parse(fs.readFileSync(path.join(root, 'output/acceptance/w18-session.json'), 'utf8'));
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(session));
        } catch { response.writeHead(503).end(); }
        return;
      }
      const modes = { '/__w18_fixture__/complete': 'complete', '/__w18_fixture__/rateLimit': 'rateLimit' };
      const mode = modes[request.url];
      if (!mode) return next();
      const traceId = request.headers['x-trace-id'];
      if (request.method !== 'GET' || typeof traceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(traceId)) {
        response.writeHead(400).end(); return;
      }
      try {
        const result = await fetch(new URL(`/api/v1/w11-fixture/chat/${mode}`, fixture), {
          headers: { 'x-trace-id': traceId }, signal: AbortSignal.timeout(5000),
        });
        response.setHeader('x-trace-id', traceId);
        response.setHeader('content-type', 'application/json');
        // No provider body or private exception escapes this fixture bridge.
        response.writeHead(result.status).end(JSON.stringify({ status: result.status }));
      } catch { response.writeHead(502).end(JSON.stringify({ status: 502 })); }
    });
  } }],
});
await server.listen();
console.log('W18 browser fixture ready');
async function close() { await server.close(); process.exit(0); }
process.on('SIGTERM', close); process.on('SIGINT', close);
