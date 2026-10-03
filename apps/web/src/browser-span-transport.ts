import { getUnpatchedFetch, type BrowserMonitorEvent } from './api';

export const BROWSER_SPAN_ENDPOINT = '/__sdk_test__/spans';
export const BROWSER_SPAN_SERVICE = 'web-sdk-demo';
export const BROWSER_SPAN_ENVIRONMENT = 'dev';

const DEFAULT_MAX_QUEUE_SIZE = 100;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_TIMEOUT_MS = 3_000;
const FLUSH_INTERVAL_MS = 1_000;
const MAX_QUEUE_SIZE = 100;
const MAX_BATCH_SIZE = 20;
const MAX_TIMEOUT_MS = 3_000;

const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SPAN_ID_PATTERN = /^[a-f0-9]{32}$/;
const SAFE_ERROR_NAMES = new Set([
  'AggregateError', 'DOMException', 'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'TypeError', 'URIError',
]);
const SAFE_PATH_SEGMENTS = new Set([
  'alerts', 'api', 'auth', 'chat', 'client', 'completion', 'completions', 'config', 'events', 'health',
  'ingest', 'keys', 'llm', 'login', 'logout', 'me', 'metrics', 'models', 'monitor', 'projects', 'prompts',
  'query', 'rag', 'search', 'services', 'settings', 'spans', 'tools', 'traces', 'users', 'v1', 'v2', 'web',
]);
const SAFE_METHODS = new Set([
  'CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE', 'OTHER',
]);

export interface BrowserTraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service: typeof BROWSER_SPAN_SERVICE;
  operation:
    | 'browser.navigation'
    | 'browser.web_vital'
    | 'browser.javascript_error'
    | 'browser.unhandled_rejection'
    | 'browser.network_error';
  startTime: number;
  endTime: number;
  status: 'ok' | 'error';
  attributes: Record<string, string | number>;
}

export type BrowserSpanDelivery = 'queued_in_memory' | 'failed';
export type BrowserSpanTransportState = 'idle' | 'queued_in_memory' | 'sending' | 'failed' | 'disposed';

export interface BrowserSpanTransportStatus {
  state: BrowserSpanTransportState;
  queueSize: number;
  inFlight: number;
  apiQueuedCount: number;
  droppedCount: number;
  failedCount: number;
  lastHttpStatus?: number;
  lastDelivery?: BrowserSpanDelivery;
}

export interface BrowserSpanTransportOptions {
  endpoint: string;
  maxQueueSize?: number;
  batchSize?: number;
  timeoutMs?: number;
  onStatusChange?: (status: BrowserSpanTransportStatus) => void;
}

export interface BrowserSpanTransport {
  transport(event: BrowserMonitorEvent): void;
  flush(): Promise<void>;
  dispose(): void;
  getStatus(): BrowserSpanTransportStatus;
}

// Capture the SDK's underlying fetch even if this module loads after its monitor patch.
const originalFetch: typeof fetch | undefined = getUnpatchedFetch();

function isSafeUnixMilliseconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
}

function safeSpanId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID().replaceAll('-', '').toLowerCase();
  }
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    return Array.from(cryptoApi.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('Web Crypto API is required to create a Span ID');
}

function isSafePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128 || !value.startsWith('/') || value.includes('?') || value.includes('#')) {
    return false;
  }
  if (value === '/') return true;

  return value.slice(1).split('/').every((segment) => segment === ':id'
    || SAFE_PATH_SEGMENTS.has(segment)
    || /^v\d{1,2}$/.test(segment));
}

function safePathAttribute(path: unknown, attributes: Record<string, string | number>): void {
  if (isSafePath(path)) attributes.path = path;
}

function safeLineNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1e7;
}

function safeErrorName(value: unknown): string {
  return typeof value === 'string' && SAFE_ERROR_NAMES.has(value) ? value : 'Error';
}

function safeMethod(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const method = value.toUpperCase();
  return SAFE_METHODS.has(method) ? method : undefined;
}

function safeRating(value: unknown): value is 'good' | 'needs-improvement' | 'poor' {
  return value === 'good' || value === 'needs-improvement' || value === 'poor';
}

function hasOnlyKeys(value: unknown, allowed: readonly string[]): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key));
}

/** Convert one SDK event into a strict, privacy-filtered Span. Invalid events are dropped. */
export function convertBrowserMonitorEventToSpan(event: BrowserMonitorEvent): BrowserTraceSpan | undefined {
  try {
    const type = event.type;
    const traceId = event.traceId;
    const endTime = event.timestamp;
    if (event.service !== BROWSER_SPAN_SERVICE || event.environment !== BROWSER_SPAN_ENVIRONMENT
      || typeof traceId !== 'string' || !TRACE_ID_PATTERN.test(traceId) || !isSafeUnixMilliseconds(endTime)) return undefined;

    const commonFields = ['type', 'service', 'environment', 'timestamp', 'traceId'];
    const allowedFields = type === 'navigation'
      ? [...commonFields, 'spanId', 'startTime']
      : type === 'web_vital'
        ? [...commonFields, 'parentSpanId', 'metric', 'value', 'delta', 'rating', 'metricId']
        : type === 'javascript_error'
          ? [...commonFields, 'parentSpanId', 'message', 'errorName', 'path', 'line', 'column']
          : type === 'unhandled_rejection'
            ? [...commonFields, 'parentSpanId', 'message', 'errorName']
            : type === 'network_error'
              ? [...commonFields, 'parentSpanId', 'source', 'reason', 'method', 'status', 'durationMs', 'path']
              : undefined;
    if (!allowedFields || !hasOnlyKeys(event, allowedFields)) return undefined;
    const parentSpanId = type !== 'navigation' ? event.parentSpanId : undefined;
    if (type !== 'navigation' && parentSpanId !== undefined && !SPAN_ID_PATTERN.test(parentSpanId)) return undefined;

    const attributes: Record<string, string | number> = { eventType: type };
    let operation: BrowserTraceSpan['operation'];
    let status: BrowserTraceSpan['status'];
    let startTime = endTime;

    if (type === 'navigation') {
      operation = 'browser.navigation';
      status = 'ok';
      if (!SPAN_ID_PATTERN.test(event.spanId) || !isSafeUnixMilliseconds(event.startTime) || event.startTime > endTime) {
        return undefined;
      }
      startTime = event.startTime;
    } else if (type === 'web_vital') {
      operation = 'browser.web_vital';
      status = 'ok';
      if (!['CLS', 'INP', 'LCP', 'FCP', 'TTFB'].includes(event.metric)
        || !Number.isFinite(event.value)
        || event.value < 0
        || event.value > 1e9
        || !Number.isFinite(event.delta)
        || Math.abs(event.delta) > 1e9
        || !safeRating(event.rating)) return undefined;
      attributes.metric = event.metric;
      attributes.value = event.value;
      attributes.delta = event.delta;
      attributes.rating = event.rating;
    } else if (type === 'javascript_error') {
      operation = 'browser.javascript_error';
      status = 'error';
      attributes.errorName = safeErrorName(event.errorName);
      safePathAttribute(event.path, attributes);
      if (safeLineNumber(event.line)) attributes.line = event.line;
      if (safeLineNumber(event.column)) attributes.column = event.column;
    } else if (type === 'unhandled_rejection') {
      operation = 'browser.unhandled_rejection';
      status = 'error';
      attributes.errorName = safeErrorName(event.errorName);
    } else if (type === 'network_error') {
      operation = 'browser.network_error';
      status = 'error';
      if ((event.source !== 'fetch' && event.source !== 'xhr')
        || (event.reason !== 'network' && event.reason !== 'http')) return undefined;
      const method = safeMethod(event.method);
      if (!method || !isSafeUnixMilliseconds(event.durationMs)
        || event.durationMs > 300_000 || event.durationMs > endTime || !isSafePath(event.path)) return undefined;
      startTime = endTime - event.durationMs;
      attributes.source = event.source;
      attributes.reason = event.reason;
      attributes.method = method;
      attributes.path = event.path;
      if (event.reason === 'http') {
        if (!Number.isSafeInteger(event.status) || event.status < 100 || event.status > 599
          || (event.status >= 200 && event.status <= 299)) return undefined;
        attributes.httpStatus = event.status;
      } else if (event.status !== 0) {
        return undefined;
      }
    } else {
      return undefined;
    }

    return {
      traceId,
      spanId: type === 'navigation' ? event.spanId : safeSpanId(),
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      service: BROWSER_SPAN_SERVICE,
      operation,
      startTime,
      endTime,
      status,
      attributes,
    };
  } catch {
    // Malformed or hostile event objects are ignored without exposing their values.
    return undefined;
  }
}

function validateEndpoint(endpoint: string): string {
  const location = globalThis.location;
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2_048
    || /[?#\\\s\u0000-\u001f]/.test(endpoint)
    || !location?.href || !location.origin) {
    throw new TypeError('endpoint must be a same-origin URL without query or hash');
  }
  if (endpoint.startsWith('//') || (!endpoint.startsWith('/') && !/^https?:\/\//i.test(endpoint))) {
    throw new TypeError('endpoint must be a same-origin URL without query or hash');
  }

  let url: URL;
  try {
    url = new URL(endpoint, location.href);
  } catch {
    throw new TypeError('endpoint must be a same-origin URL without query or hash');
  }
  if (url.origin !== location.origin || url.search || url.hash || url.username || url.password) {
    throw new TypeError('endpoint must be a same-origin URL without query or hash');
  }
  return url.pathname;
}

function boundedInteger(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function createBrowserSpanTransport(options: BrowserSpanTransportOptions): BrowserSpanTransport {
  const endpoint = validateEndpoint(options.endpoint);
  const maxQueueSize = boundedInteger('maxQueueSize', options.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE, 1, MAX_QUEUE_SIZE);
  const batchSize = boundedInteger('batchSize', options.batchSize, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
  const timeoutMs = boundedInteger('timeoutMs', options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  if (options.onStatusChange !== undefined && typeof options.onStatusChange !== 'function') {
    throw new TypeError('onStatusChange must be a function');
  }

  const queue: BrowserTraceSpan[] = [];
  let disposed = false;
  let inFlight = 0;
  let apiQueuedCount = 0;
  let droppedCount = 0;
  let failedCount = 0;
  let lastHttpStatus: number | undefined;
  let lastDelivery: BrowserSpanDelivery | undefined;
  let activeController: AbortController | undefined;
  let activeFlush: Promise<void> | undefined;

  const getStatus = (): BrowserSpanTransportStatus => {
    let state: BrowserSpanTransportState = 'idle';
    if (disposed) state = 'disposed';
    else if (inFlight > 0) state = 'sending';
    else if (queue.length > 0 || lastDelivery === 'queued_in_memory') state = 'queued_in_memory';
    else if (lastDelivery === 'failed') state = 'failed';
    return Object.freeze({
      state,
      queueSize: queue.length,
      inFlight,
      apiQueuedCount,
      droppedCount,
      failedCount,
      ...(lastHttpStatus === undefined ? {} : { lastHttpStatus }),
      ...(lastDelivery === undefined ? {} : { lastDelivery }),
    });
  };

  const notifyStatus = (): void => {
    try {
      options.onStatusChange?.(getStatus());
    } catch {
      // Status observers must never affect event capture or the application.
    }
  };

  const sendBatch = async (spans: BrowserTraceSpan[]): Promise<boolean> => {
    if (!originalFetch) {
      lastDelivery = 'failed';
      lastHttpStatus = undefined;
      failedCount += spans.length;
      return false;
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    activeController = controller;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          controller?.abort();
          reject(new Error('Browser Span transport timed out'));
        }, timeoutMs);
      });
      const request = originalFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environment: BROWSER_SPAN_ENVIRONMENT, spans }),
        credentials: 'omit',
        mode: 'same-origin',
        ...(controller ? { signal: controller.signal } : {}),
      });
      const response = await Promise.race([request, timeout]);
      if (disposed) return false;
      lastHttpStatus = response.status;
      if (response.status !== 202) {
        lastDelivery = 'failed';
        failedCount += spans.length;
        return false;
      }
      apiQueuedCount += spans.length;
      lastDelivery = 'queued_in_memory';
      return true;
    } catch {
      if (!disposed) {
        lastHttpStatus = undefined;
        lastDelivery = 'failed';
        failedCount += spans.length;
      }
      return false;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (activeController === controller) activeController = undefined;
    }
  };

  const flushQueued = async (): Promise<void> => {
    while (!disposed && queue.length > 0) {
      const batch = queue.splice(0, batchSize);
      inFlight = batch.length;
      notifyStatus();
      const succeeded = await sendBatch(batch);
      if (disposed) return;
      inFlight = 0;
      notifyStatus();
      if (!succeeded) break;
    }
  };

  const flush = (): Promise<void> => {
    if (disposed || queue.length === 0) return Promise.resolve();
    if (activeFlush) return activeFlush;
    activeFlush = flushQueued().finally(() => {
      activeFlush = undefined;
      notifyStatus();
    });
    return activeFlush;
  };

  const timer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);

  return {
    transport(event) {
      if (disposed) return;
      const span = convertBrowserMonitorEventToSpan(event);
      if (!span) {
        droppedCount += 1;
        notifyStatus();
        return;
      }
      if (queue.length + inFlight >= maxQueueSize) {
        droppedCount += 1;
        notifyStatus();
        return;
      }
      queue.push(span);
      notifyStatus();
    },
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      droppedCount += queue.length + inFlight;
      queue.length = 0;
      inFlight = 0;
      clearInterval(timer);
      activeController?.abort();
      activeController = undefined;
      notifyStatus();
    },
    getStatus,
  };
}
