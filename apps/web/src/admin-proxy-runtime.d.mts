import type { IncomingMessage, ServerResponse } from 'node:http';

export interface AdminProxyOptions {
  adminToken?: string | (() => string | undefined);
  apiPort?: number | string | (() => number | string | undefined);
  timeoutMs?: number;
  bodyTimeoutMs?: number;
  maxResponseBytes?: number;
}

export function createAdminProxy(options?: AdminProxyOptions): (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void;
