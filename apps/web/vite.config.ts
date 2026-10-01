import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isAdminReadRequest } from './src/admin-proxy';

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

export default defineConfig({
  plugins: [react(), localSdkTestEndpoint(), browserSpanRelay()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.API_PORT ?? '3001'}`,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            if (!isAdminReadRequest(request.method, request.url)) return;
            if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) return;

            const adminToken = process.env.PLATFORM_ADMIN_TOKEN?.trim();
            if (adminToken) proxyRequest.setHeader('Authorization', `Bearer ${adminToken}`);
          });
        },
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
