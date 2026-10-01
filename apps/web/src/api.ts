import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';
import type { Metric as WebVitalMetric } from 'web-vitals';

export const TRACE_ID_HEADER = 'x-trace-id';

const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ProtocolEnvironment = 'dev' | 'staging' | 'prod';
export type WebVitalName = 'CLS' | 'INP' | 'LCP' | 'FCP' | 'TTFB';

export interface ApiRequestInit extends RequestInit {
  /** Current user-operation Trace ID, when this request belongs to an existing operation. */
  traceId?: string;
}

export interface PreparedApiRequest {
  input: RequestInfo | URL;
  init: RequestInit;
  traceId: string;
}

export interface MonitorEventBase {
  service: string;
  environment: ProtocolEnvironment;
  timestamp: number;
  traceId: string;
}

export type BrowserMonitorEvent = MonitorEventBase & (
  | {
      type: 'web_vital';
      metric: WebVitalName;
      value: number;
      delta: number;
      rating: 'good' | 'needs-improvement' | 'poor';
      metricId?: string;
    }
  | {
      type: 'javascript_error' | 'unhandled_rejection';
      message: 'JavaScript error' | 'Unhandled promise rejection';
      errorName: string;
      path?: string;
      line?: number;
      column?: number;
    }
  | {
      type: 'network_error';
      source: 'fetch' | 'xhr';
      reason: 'network' | 'http';
      method: string;
      status: number;
      durationMs: number;
      path: string;
    }
);

type BrowserMonitorEventPayload = BrowserMonitorEvent extends infer Event
  ? Event extends MonitorEventBase ? Omit<Event, keyof MonitorEventBase> : never
  : never;

export type BrowserMonitorTransport = (event: BrowserMonitorEvent) => void | Promise<void>;

export interface BrowserMonitorOptions {
  service: string;
  /** Must be the W1 canonical wire value; display aliases are not accepted here. */
  environment: ProtocolEnvironment;
  enabled?: boolean;
  captureWebVitals?: boolean;
  captureErrors?: boolean;
  /** Applied once per start to include or exclude the whole browser session. */
  sampleRate?: number;
  onEvent?: (event: BrowserMonitorEvent) => void | Promise<void>;
  /** Optional caller-owned event sink. No transport is configured by default. */
  transport?: BrowserMonitorTransport;
}

export interface BrowserMonitorController {
  start(options?: BrowserMonitorOptions): BrowserMonitorController;
  teardown(): void;
}

export interface WebVitalsCallbacks {
  onCLS(callback: (metric: WebVitalMetric) => void): void;
  onINP(callback: (metric: WebVitalMetric) => void): void;
  onLCP(callback: (metric: WebVitalMetric) => void): void;
  onFCP(callback: (metric: WebVitalMetric) => void): void;
  onTTFB(callback: (metric: WebVitalMetric) => void): void;
}

export function isValidTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID_PATTERN.test(value);
}

export function createTraceId(): string {
  const cryptoApi = globalThis.crypto;

  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `trace_web_${cryptoApi.randomUUID()}`;
  }

  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return `trace_web_${uuid}`;
  }

  throw new Error('Web Crypto API is required to generate a Trace ID');
}

export function resolveTraceId(currentTraceId?: string, inboundTraceId?: string): string {
  if (isValidTraceId(currentTraceId)) return currentTraceId;
  if (isValidTraceId(inboundTraceId)) return inboundTraceId;
  return createTraceId();
}

export function toProtocolEnvironment(environment: string): ProtocolEnvironment {
  switch (environment) {
    case 'dev':
    case 'development':
      return 'dev';
    case 'staging':
      return 'staging';
    case 'prod':
    case 'production':
      return 'prod';
    default:
      throw new TypeError(`Unsupported environment value: ${environment}`);
  }
}

function getPageTraceId(): string | undefined {
  if (typeof document === 'undefined') return undefined;

  const value = document.querySelector<HTMLMetaElement>('meta[name="x-trace-id"]')?.content;
  return isValidTraceId(value) ? value : undefined;
}

export function prepareApiRequest(input: RequestInfo | URL, options: ApiRequestInit = {}): PreparedApiRequest {
  const { traceId: currentTraceId, ...requestInit } = options;
  const requestHeaders = typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined;
  const headers = new Headers(requestHeaders);

  new Headers(requestInit.headers).forEach((value, name) => headers.set(name, value));

  const headerTraceId = headers.get(TRACE_ID_HEADER);
  const inboundTraceId = isValidTraceId(headerTraceId) ? headerTraceId : getPageTraceId();
  const traceId = resolveTraceId(currentTraceId, inboundTraceId);
  headers.set(TRACE_ID_HEADER, traceId);

  return {
    input,
    init: { ...requestInit, headers },
    traceId,
  };
}

function getRequestUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return undefined;
}

function getResolvedUrl(input: RequestInfo | URL): URL | undefined {
  const rawUrl = getRequestUrl(input);
  const location = globalThis.location;
  if (!rawUrl || !location?.href) return undefined;

  try {
    return new URL(rawUrl, location.href);
  } catch {
    return undefined;
  }
}

function isSameOrigin(input: RequestInfo | URL): boolean {
  const url = getResolvedUrl(input);
  return Boolean(url && globalThis.location?.origin && url.origin === globalThis.location.origin);
}

const SAFE_ROUTE_SEGMENTS = new Set([
  'alerts', 'api', 'auth', 'chat', 'client', 'completion', 'completions', 'config', 'events', 'health',
  'ingest', 'keys', 'llm', 'login', 'logout', 'me', 'metrics', 'models', 'monitor', 'projects', 'prompts',
  'query', 'rag', 'search', 'services', 'settings', 'spans', 'tools', 'traces', 'users', 'v1', 'v2', 'web',
]);

/** Keep known route labels; replace every other path segment so IDs and user text cannot escape. */
export function sanitizePath(input: RequestInfo | URL | string): string | undefined {
  let url: URL | undefined;
  if (typeof input === 'string') {
    url = getResolvedUrl(input as RequestInfo);
  } else {
    url = getResolvedUrl(input);
  }
  if (!url || !globalThis.location?.origin || url.origin !== globalThis.location.origin) return undefined;

  const segments = url.pathname.split('/').filter(Boolean).map((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Invalid escapes are treated as dynamic path content below.
    }
    const safeSegment = decoded.toLowerCase();
    return SAFE_ROUTE_SEGMENTS.has(safeSegment) || /^v\d{1,2}$/.test(safeSegment) ? safeSegment : ':id';
  });

  return (`/${segments.join('/')}`).slice(0, 128) || '/';
}

function normalizeMethod(method: unknown): string {
  if (typeof method !== 'string') return 'GET';
  const normalized = method.toUpperCase();
  return ['CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE'].includes(normalized)
    ? normalized
    : 'OTHER';
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return normalizeMethod(init.method);
  if (typeof Request !== 'undefined' && input instanceof Request) return normalizeMethod(input.method);
  return 'GET';
}

function currentTime(): number {
  const now = globalThis.performance?.now?.();
  return typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(currentTime() - startedAt));
}

const SAFE_ERROR_NAMES = new Set([
  'AggregateError', 'DOMException', 'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'TypeError', 'URIError',
]);

function safeErrorName(value: unknown): string {
  try {
    if (value && typeof value === 'object') {
      const name = (value as { name?: unknown }).name;
      if (typeof name === 'string' && SAFE_ERROR_NAMES.has(name)) return name;
    }
  } catch {
    // Error-like objects may define throwing accessors; keep the generic safe label.
  }
  return 'Error';
}

function safePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function normalizeOptions(options: BrowserMonitorOptions): BrowserMonitorOptions & Required<Pick<
  BrowserMonitorOptions,
  'enabled' | 'captureWebVitals' | 'captureErrors' | 'sampleRate'
>> {
  if (typeof options.service !== 'string' || !options.service.trim() || options.service.trim().length > 120) {
    throw new TypeError('service must contain 1 to 120 characters');
  }
  if (!['dev', 'staging', 'prod'].includes(options.environment)) {
    throw new TypeError('environment must be dev, staging, or prod');
  }
  const sampleRate = options.sampleRate ?? 1;
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
    throw new RangeError('sampleRate must be between 0 and 1');
  }
  if (options.onEvent !== undefined && typeof options.onEvent !== 'function') {
    throw new TypeError('onEvent must be a function');
  }
  if (options.transport !== undefined && typeof options.transport !== 'function') {
    throw new TypeError('transport must be a function');
  }

  return {
    ...options,
    service: options.service.trim(),
    enabled: options.enabled ?? true,
    captureWebVitals: options.captureWebVitals ?? true,
    captureErrors: options.captureErrors ?? true,
    sampleRate,
  };
}

function sameOptions(left: BrowserMonitorOptions, right: BrowserMonitorOptions): boolean {
  return left.service === right.service
    && left.environment === right.environment
    && left.enabled === right.enabled
    && left.captureWebVitals === right.captureWebVitals
    && left.captureErrors === right.captureErrors
    && left.sampleRate === right.sampleRate
    && left.onEvent === right.onEvent
    && left.transport === right.transport;
}

let activeOptions: ReturnType<typeof normalizeOptions> | undefined;
let pageTraceId: string | undefined;
let webVitalsObserversInstalled = false;

function hasEventSink(options: BrowserMonitorOptions): boolean {
  return Boolean(options.onEvent || options.transport);
}

function deliverEvent(event: BrowserMonitorEvent): void {
  const options = activeOptions;
  if (!options || !hasEventSink(options)) return;

  const safeEvent = Object.freeze(event);
  try {
    const result = options.onEvent?.(safeEvent);
    if (result && typeof result.then === 'function') void result.catch(() => undefined);
  } catch {
    // Telemetry callbacks must not change application behavior.
  }

  try {
    const result = options.transport?.(safeEvent);
    if (result && typeof result.then === 'function') void result.catch(() => undefined);
  } catch {
    // Telemetry callbacks must not change application behavior.
  }
}

function emitWithPageTrace(
  options: BrowserMonitorOptions,
  event: BrowserMonitorEventPayload,
): void {
  if (!activeOptions || !hasEventSink(options)) return;

  if (!pageTraceId) {
    try {
      pageTraceId = resolveTraceId(undefined, getPageTraceId());
    } catch {
      return;
    }
  }

  deliverEvent({
    ...event,
    service: options.service,
    environment: options.environment,
    timestamp: Date.now(),
    traceId: pageTraceId,
  } as BrowserMonitorEvent);
}

const defaultWebVitalsCallbacks: WebVitalsCallbacks = {
  onCLS: (callback) => onCLS((metric) => callback(metric)),
  onINP: (callback) => onINP((metric) => callback(metric)),
  onLCP: (callback) => onLCP((metric) => callback(metric)),
  onFCP: (callback) => onFCP((metric) => callback(metric)),
  onTTFB: (callback) => onTTFB((metric) => callback(metric)),
};

/** Registers each official web-vitals observer exactly once when the monitor first needs them. */
export function registerWebVitals(
  callback: (name: WebVitalName, metric: WebVitalMetric) => void,
  vitals: WebVitalsCallbacks = defaultWebVitalsCallbacks,
): void {
  vitals.onCLS((metric) => callback('CLS', metric));
  vitals.onINP((metric) => callback('INP', metric));
  vitals.onLCP((metric) => callback('LCP', metric));
  vitals.onFCP((metric) => callback('FCP', metric));
  vitals.onTTFB((metric) => callback('TTFB', metric));
}

function installWebVitalsObservers(): void {
  if (webVitalsObserversInstalled) return;
  webVitalsObserversInstalled = true;

  try {
    registerWebVitals((name, metric) => {
      const options = activeOptions;
      if (!options?.captureWebVitals || !hasEventSink(options)) return;
      if (!Number.isFinite(metric.value) || !Number.isFinite(metric.delta)) return;

      const event: BrowserMonitorEventPayload = {
        type: 'web_vital',
        metric: name,
        value: metric.value,
        delta: metric.delta,
        rating: metric.rating,
        ...(isValidTraceId(metric.id) ? { metricId: metric.id } : {}),
      };
      emitWithPageTrace(options, event);
    });
  } catch {
    // Registration can be partial and web-vitals has no teardown; never retry and duplicate it.
  }
}

function installWindowErrorListeners(): () => void {
  const target = globalThis.window;
  if (!target?.addEventListener) return () => undefined;

  const onError = (rawEvent: Event): void => {
    const options = activeOptions;
    if (!options?.captureErrors || !hasEventSink(options)) return;
    const event = rawEvent as ErrorEvent;
    const diagnostic: BrowserMonitorEventPayload = {
      type: 'javascript_error',
      message: 'JavaScript error',
      errorName: safeErrorName(event.error),
      ...(sanitizePath(event.filename) ? { path: sanitizePath(event.filename) } : {}),
      ...(safePositiveInteger(event.lineno) ? { line: safePositiveInteger(event.lineno) } : {}),
      ...(safePositiveInteger(event.colno) ? { column: safePositiveInteger(event.colno) } : {}),
    };
    emitWithPageTrace(options, diagnostic);
  };

  const onUnhandledRejection = (rawEvent: Event): void => {
    const options = activeOptions;
    if (!options?.captureErrors || !hasEventSink(options)) return;
    const event = rawEvent as PromiseRejectionEvent;
    const diagnostic: BrowserMonitorEventPayload = {
      type: 'unhandled_rejection',
      message: 'Unhandled promise rejection',
      errorName: safeErrorName(event.reason),
    };
    emitWithPageTrace(options, diagnostic);
  };

  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onUnhandledRejection);

  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}

interface FetchPatch {
  original: typeof fetch;
  wrapper: typeof fetch;
}

let fetchPatch: FetchPatch | undefined;

const LOCAL_BROWSER_SPAN_TRANSPORT_PATH = '/__sdk_test__/spans';

/** Return fetch below this SDK's wrapper, including when a transport module loads later. */
export function getUnpatchedFetch(): typeof fetch | undefined {
  const fetcher = fetchPatch?.original ?? globalThis.fetch;
  return typeof fetcher === 'function' ? fetcher.bind(globalThis) : undefined;
}

/** The opt-in Span BFF request must bypass this monitor even if the transport captured its wrapper. */
function isLocalBrowserSpanTransportRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (requestMethod(input, init) !== 'POST') return false;
  const url = getResolvedUrl(input);
  return Boolean(url
    && globalThis.location?.origin
    && url.origin === globalThis.location.origin
    && url.pathname === LOCAL_BROWSER_SPAN_TRANSPORT_PATH
    && !url.search
    && !url.hash);
}

function installFetchPatch(): () => void {
  if (fetchPatch) return () => undefined;
  const original = globalThis.fetch;
  if (typeof original !== 'function') return () => undefined;

  const wrapper: typeof fetch = function (this: typeof globalThis, input, init) {
    if (isLocalBrowserSpanTransportRequest(input, init)) return original.call(this, input, init);
    const options = activeOptions;
    if (!options?.enabled || !isSameOrigin(input)) return original.call(this, input, init);

    const method = requestMethod(input, init);
    const path = sanitizePath(input) ?? '/';
    const shouldCapture = Boolean(options.captureErrors && hasEventSink(options));
    const startedAt = shouldCapture ? currentTime() : 0;
    let prepared: PreparedApiRequest;
    try {
      prepared = prepareApiRequest(input, init as ApiRequestInit | undefined);
    } catch (error) {
      return Promise.reject(error);
    }

    const emitNetworkFailure = (reason: 'network' | 'http', status: number): void => {
      const currentOptions = activeOptions;
      if (!currentOptions?.captureErrors || !hasEventSink(currentOptions)) return;
      deliverEvent({
        type: 'network_error',
        source: 'fetch',
        reason,
        method,
        status,
        durationMs: elapsedMilliseconds(startedAt),
        path,
        service: currentOptions.service,
        environment: currentOptions.environment,
        timestamp: Date.now(),
        traceId: prepared.traceId,
      });
    };

    let pending: Promise<Response>;
    try {
      pending = original.call(this, prepared.input, prepared.init);
    } catch (error) {
      if (shouldCapture) emitNetworkFailure('network', 0);
      throw error;
    }
    if (!shouldCapture) return pending;

    return pending.then((response) => {
      if (response.status < 200 || response.status >= 300) emitNetworkFailure('http', response.status);
      return response;
    }, (error: unknown) => {
      emitNetworkFailure('network', 0);
      throw error;
    });
  };

  globalThis.fetch = wrapper;
  fetchPatch = { original, wrapper };

  return () => {
    if (fetchPatch?.wrapper !== wrapper) return;
    if (globalThis.fetch === wrapper) {
      globalThis.fetch = original;
      fetchPatch = undefined;
    }
    // If another library wrapped this function, leave the now-inert wrapper in place
    // rather than layering another patch on top of an unknown wrapper chain.
  };
}

interface XhrRequestMetadata {
  sameOrigin: boolean;
  method: string;
  path: string;
  traceHeaderValues: string[];
  traceId?: string;
}

interface XhrPatch {
  prototype: XMLHttpRequest;
  originalOpen: XMLHttpRequest['open'];
  originalSetRequestHeader: XMLHttpRequest['setRequestHeader'];
  originalSend: XMLHttpRequest['send'];
  wrappedOpen: XMLHttpRequest['open'];
  wrappedSetRequestHeader: XMLHttpRequest['setRequestHeader'];
  wrappedSend: XMLHttpRequest['send'];
  metadata: WeakMap<XMLHttpRequest, XhrRequestMetadata>;
}

let xhrPatch: XhrPatch | undefined;
const pendingXhrListenerCleanups = new Set<() => void>();

function installXhrPatch(): () => void {
  if (xhrPatch) return () => undefined;
  const constructor = globalThis.XMLHttpRequest;
  const prototype = constructor?.prototype;
  if (!prototype) return () => undefined;

  const originalOpen = prototype.open;
  const originalSetRequestHeader = prototype.setRequestHeader;
  const originalSend = prototype.send;
  const metadata = new WeakMap<XMLHttpRequest, XhrRequestMetadata>();

  const wrappedOpen = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    const sameOrigin = isSameOrigin(url);
    metadata.set(this, {
      sameOrigin,
      method: normalizeMethod(method),
      path: sanitizePath(url) ?? '/',
      traceHeaderValues: [],
    });
    if (async === undefined) return originalOpen.call(this, method, url, true, null, null);
    return originalOpen.call(this, method, url, async, username, password);
  } as XMLHttpRequest['open'];

  const wrappedSetRequestHeader: XMLHttpRequest['setRequestHeader'] = function (this: XMLHttpRequest, name, value) {
    const request = metadata.get(this);
    if (request?.sameOrigin && name.toLowerCase() === TRACE_ID_HEADER) {
      request.traceHeaderValues.push(value);
      return;
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  const wrappedSend: XMLHttpRequest['send'] = function (this: XMLHttpRequest, body) {
    const request = metadata.get(this);
    const options = activeOptions;
    if (!request?.sameOrigin || !options?.enabled) return originalSend.call(this, body);

    const headerTraceId = request.traceHeaderValues.length === 1 ? request.traceHeaderValues[0] : undefined;
    const inboundTraceId = isValidTraceId(headerTraceId) ? headerTraceId : getPageTraceId();
    request.traceId = resolveTraceId(undefined, inboundTraceId);
    originalSetRequestHeader.call(this, TRACE_ID_HEADER, request.traceId);

    const shouldCapture = Boolean(options.captureErrors && hasEventSink(options));
    if (shouldCapture) {
      const startedAt = currentTime();
      let removeListener = (): void => undefined;
      const onLoadEnd = (): void => {
        removeListener();
        const currentOptions = activeOptions;
        if (!currentOptions?.captureErrors || !hasEventSink(currentOptions)) return;

        const status = this.status;
        if (status >= 200 && status < 300) return;
        deliverEvent({
          type: 'network_error',
          source: 'xhr',
          reason: status === 0 ? 'network' : 'http',
          method: request.method,
          status,
          durationMs: elapsedMilliseconds(startedAt),
          path: request.path,
          service: currentOptions.service,
          environment: currentOptions.environment,
          timestamp: Date.now(),
          traceId: request.traceId!,
        });
      };
      this.addEventListener('loadend', onLoadEnd, { once: true });
      removeListener = () => {
        this.removeEventListener('loadend', onLoadEnd);
        pendingXhrListenerCleanups.delete(removeListener);
      };
      pendingXhrListenerCleanups.add(removeListener);
    }

    return originalSend.call(this, body);
  };

  try {
    prototype.open = wrappedOpen;
    prototype.setRequestHeader = wrappedSetRequestHeader;
    prototype.send = wrappedSend;
  } catch {
    prototype.open = originalOpen;
    prototype.setRequestHeader = originalSetRequestHeader;
    prototype.send = originalSend;
    return () => undefined;
  }

  xhrPatch = {
    prototype,
    originalOpen,
    originalSetRequestHeader,
    originalSend,
    wrappedOpen,
    wrappedSetRequestHeader,
    wrappedSend,
    metadata,
  };

  return () => {
    for (const cleanup of [...pendingXhrListenerCleanups]) cleanup();
    if (xhrPatch?.wrappedOpen !== wrappedOpen) return;

    let restored = true;
    if (prototype.open === wrappedOpen) prototype.open = originalOpen;
    else restored = false;
    if (prototype.setRequestHeader === wrappedSetRequestHeader) prototype.setRequestHeader = originalSetRequestHeader;
    else restored = false;
    if (prototype.send === wrappedSend) prototype.send = originalSend;
    else restored = false;
    if (restored) xhrPatch = undefined;
  };
}

function installRuntimeListeners(options: ReturnType<typeof normalizeOptions>): Array<() => void> {
  const cleanups: Array<() => void> = [];
  cleanups.push(installFetchPatch());
  cleanups.push(installXhrPatch());
  if (options.captureErrors && hasEventSink(options)) cleanups.push(installWindowErrorListeners());
  if (options.captureWebVitals && hasEventSink(options)) installWebVitalsObservers();
  return cleanups;
}

class BrowserMonitor implements BrowserMonitorController {
  private options?: ReturnType<typeof normalizeOptions>;
  private cleanups: Array<() => void> = [];
  private started = false;

  start(options?: BrowserMonitorOptions): BrowserMonitorController {
    const nextOptions = options ? normalizeOptions(options) : this.options;
    if (!nextOptions) throw new Error('Call initBrowserMonitoring(options) before start()');
    if (this.started && this.options && sameOptions(this.options, nextOptions)) return this;

    this.stopRuntime();
    this.options = nextOptions;
    this.started = true;

    if (!nextOptions.enabled) return this;
    if (nextOptions.sampleRate < 1 && Math.random() >= nextOptions.sampleRate) {
      return this;
    }

    activeOptions = nextOptions;
    try {
      this.cleanups = installRuntimeListeners(nextOptions);
    } catch (error) {
      this.stopRuntime();
      this.started = false;
      throw error;
    }
    return this;
  }

  teardown(): void {
    this.stopRuntime();
    this.started = false;
  }

  private stopRuntime(): void {
    activeOptions = undefined;
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch {
        // Cleanup is best effort; an inactive runtime never emits events.
      }
    }
  }
}

const browserMonitor = new BrowserMonitor();

/** Start the page-wide browser monitor. Calling it again with the same options is idempotent. */
export function initBrowserMonitoring(options: BrowserMonitorOptions): BrowserMonitorController {
  return browserMonitor.start(options);
}

/** Reuse the initialized options, or replace them when options are supplied. */
export function startBrowserMonitoring(options?: BrowserMonitorOptions): BrowserMonitorController {
  return browserMonitor.start(options);
}

/** Stop event delivery, listeners, and temporary fetch/XHR patches. */
export function teardownBrowserMonitoring(): void {
  browserMonitor.teardown();
}

/** Shared browser request entry point; pass traceId to keep requests in one user operation together. */
export function apiFetch(input: RequestInfo | URL, options: ApiRequestInit = {}): Promise<Response> {
  const location = globalThis.location;
  if (location?.origin && !isSameOrigin(input)) {
    const { traceId: _traceId, ...requestInit } = options;
    return globalThis.fetch(input, requestInit);
  }

  const request = prepareApiRequest(input, options);
  return globalThis.fetch(request.input, request.init);
}
