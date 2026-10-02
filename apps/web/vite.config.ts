import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createAdminProxy } from './src/admin-proxy-runtime.mjs';

const require = createRequire(import.meta.url);
const { createBrowserSpanRelay } = require('../../scripts/browser-span-relay.cjs');

function browserSpanRelay() {
  return {
    name: 'local-browser-span-relay',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use(createBrowserSpanRelay({
        projectKey: process.env.SDK_TEST_PROJECT_KEY,
        apiPort: process.env.API_PORT ?? '3001',
      }));
    },
  };
}

function localAdminQueryProxy() {
  return {
    name: 'local-admin-query-proxy',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use(createAdminProxy({
        // Read the secret only at request time in the dev-server process.
        adminToken: () => process.env.PLATFORM_ADMIN_TOKEN,
        apiPort: () => process.env.API_PORT ?? '3001',
      }));
    },
  };
}

function localSdkTestEndpoint() {
  const install = (server: { middlewares: { use: (middleware: (request: { url?: string; method?: string }, response: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: string) => void }, next: () => void) => void) => void } }) => {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] !== '/__sdk_test__/http-error') {
        next();
        return;
      }

      if (request.method !== 'GET') {
        response.statusCode = 405;
        response.setHeader('Allow', 'GET');
        response.end();
        return;
      }

      response.statusCode = 503;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end('Local synthetic SDK test response.');
    });
  };

  return {
    name: 'local-sdk-test-endpoint',
    configureServer: install,
    configurePreviewServer: install,
  };
}

function localWebPort() {
  const configuredPort = process.env.WEB_DEV_PORT;
  if (configuredPort === undefined) return 5173;
  if (!/^\d{1,5}$/.test(configuredPort)) return 5173;
  const port = Number(configuredPort);
  return port >= 0 && port <= 65535 ? port : 5173;
}

export default defineConfig({
  plugins: [react(), localAdminQueryProxy(), localSdkTestEndpoint(), browserSpanRelay()],
  server: {
    host: '127.0.0.1',
    port: localWebPort(),
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.API_PORT ?? '3001'}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        console: fileURLToPath(new URL('./index.html', import.meta.url)),
        sdkTest: fileURLToPath(new URL('./sdk-test.html', import.meta.url)),
      },
    },
  },
});
