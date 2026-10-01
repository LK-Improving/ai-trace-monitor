import type { TraceContext } from './trace-context';
import type { ActiveSpan } from './trace-recorder';

export type AiErrorCategory = 'rate_limit' | 'timeout' | 'authentication' | 'content_filter'
  | 'provider_error' | 'network_error' | 'invalid_response' | 'cancelled' | 'invalid_request';

/** Payload-free error: provider bodies, request content and credentials never become causes. */
export class AiAdapterError extends Error {
  constructor(public readonly category: AiErrorCategory, public readonly httpStatus?: number) {
    super(`AI adapter ${category}`);
    this.name = 'AiAdapterError';
  }
}

export function httpError(status: number): AiAdapterError {
  return new AiAdapterError(status === 429 ? 'rate_limit'
    : status === 401 || status === 403 ? 'authentication'
    : status === 408 || status === 504 ? 'timeout'
    : status >= 500 ? 'provider_error' : 'invalid_request', status);
}

export interface AiObservation {
  run<T>(fn: () => T): T;
  set(key: string, value: unknown): void;
  setUsage(input: number, output: number): void;
  finish(error?: unknown): void;
}

/** Closed/offline tracing is a no-op, never a reason to skip the real business call. */
export function beginObservation(context: TraceContext, operation: string): AiObservation {
  const parent = context.current();
  let span: ActiveSpan | undefined;
  try { span = parent?.recorder.start(operation, parent.span.traceId, parent.span.id); } catch { /* telemetry only */ }
  let ended = false;
  return {
    run<T>(fn: () => T): T { return span && parent ? context.run(parent.recorder, span, fn) : fn(); },
    set(key, value) { if (!ended) { try { span?.set(key, value); } catch { /* bounded telemetry may drop fields */ } } },
    setUsage(input, output) { if (!ended) { try { span?.setUsage(input, output); } catch { /* invalid telemetry is not a business failure */ } } },
    finish(error) {
      if (ended) return;
      ended = true;
      try {
        if (error instanceof AiAdapterError) span?.set('ai.error_category', error.category);
        span?.end(error);
      } catch { /* monitoring never overrides the provider result */ }
    },
  };
}

/** Endpoints are server configuration, not HTTP inputs. No redirects or URL credentials. */
export function providerEndpoint(baseUrl: string): URL {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new AiAdapterError('invalid_request'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    || url.username || url.password || url.search || url.hash) throw new AiAdapterError('invalid_request');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

export async function readProviderJson(response: Response, maxBytes = 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new AiAdapterError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new AiAdapterError('invalid_response');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AiAdapterError('invalid_response'); }
  } finally {
    try { await reader.cancel(); } catch { /* connection may already be aborted */ }
    reader.releaseLock();
  }
}
