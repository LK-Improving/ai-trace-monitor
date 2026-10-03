import { createServer, type Server, type ServerResponse } from 'node:http';
import { CollectorTelemetry } from './collector-telemetry';

export const OPS_HEALTH_BIND_HOST = '127.0.0.1';
export const OPS_HEALTH_PORT = 3011;
export const OPS_HEALTH_PATH = '/internal/ops/health';

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(JSON.stringify(body));
}

/** Create a minimal handler; the caller binds it only to the loopback port. */
export function createOpsHealthServer(telemetry: CollectorTelemetry): Server {
  const server = createServer((request, response) => {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }
    if (request.url !== OPS_HEALTH_PATH) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    sendJson(response, 200, telemetry.snapshot());
  });
  server.headersTimeout = 2_000;
  server.requestTimeout = 1_000;
  server.keepAliveTimeout = 1_000;
  return server;
}

/** Keep the production bind address and port fixed and loopback-only. */
export function listenOpsHealthServer(server: Server): void {
  server.listen(OPS_HEALTH_PORT, OPS_HEALTH_BIND_HOST);
}
