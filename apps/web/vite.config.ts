import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

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
  plugins: [react(), localSdkTestEndpoint()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
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
