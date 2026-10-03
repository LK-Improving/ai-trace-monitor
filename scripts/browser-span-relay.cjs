'use strict';

const net = require('node:net');

const ROUTE = '/__sdk_test__/spans';
const SERVICE = 'web-sdk-demo';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_BATCH_SIZE = 20;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_IN_FLIGHT = 8;
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 120;
const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROJECT_KEY_PATTERN = /^tr_[A-Za-z0-9_-]{43}$/;
const EVENT_OPERATION = Object.freeze({
  navigation: 'browser.navigation',
  web_vital: 'browser.web_vital',
  javascript_error: 'browser.javascript_error',
  unhandled_rejection: 'browser.unhandled_rejection',
  network_error: 'browser.network_error',
});
const WEB_VITAL_METRICS = new Set(['CLS', 'INP', 'LCP', 'FCP', 'TTFB']);
const RATINGS = new Set(['good', 'needs-improvement', 'poor']);
const ERROR_NAMES = new Set([
  'AggregateError',
  'DOMException',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);
const HTTP_METHODS = new Set([
  'CONNECT',
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'TRACE',
  'OTHER',
]);
const SAFE_PATH_SEGMENTS = new Set([
  'alerts', 'api', 'auth', 'chat', 'client', 'completion', 'completions', 'config', 'events', 'health',
  'ingest', 'keys', 'llm', 'login', 'logout', 'me', 'metrics', 'models', 'monitor', 'projects', 'prompts',
  'query', 'rag', 'search', 'services', 'settings', 'spans', 'tools', 'traces', 'users', 'v1', 'v2', 'web',
]);
class RelayError extends Error {
  constructor(status, message, closeConnection = true) {
    super(message);
    this.status = status;
    this.closeConnection = closeConnection;
  }
}

function invalidRequest() {
  return new RelayError(400, 'Invalid browser span request');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasKeys(value, required, allowed) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.includes(key));
}

function parseApiPort(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : undefined;
  }
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return undefined;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function isLoopbackIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const octets = address.split('.');
  if (octets.some((octet) => octet.length > 1 && octet.startsWith('0'))) return false;
  return Number(octets[0]) === 127;
}

function isLoopbackIPv6(address) {
  if (net.isIP(address) !== 6) return false;
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) return isLoopbackIPv4(mapped);
    const words = mapped.split(':');
    if (words.length === 2 && words.every((word) => /^[a-f0-9]{1,4}$/.test(word))) {
      const packed = (Number.parseInt(words[0], 16) * 0x1_0000) + Number.parseInt(words[1], 16);
      return Math.floor(packed / 0x1_000_000) === 127;
    }
    return false;
  }

  try {
    return new URL('http://[' + address + ']/').hostname.toLowerCase() === '[::1]';
  } catch {
    return false;
  }
}

function isLoopbackSocket(req) {
  const address = req.socket?.remoteAddress ?? req.connection?.remoteAddress;
  if (typeof address !== 'string') return false;
  if (net.isIP(address) === 4) return isLoopbackIPv4(address);
  return isLoopbackIPv6(address);
}

function parseLoopbackAuthority(authority) {
  if (
    typeof authority !== 'string'
    || authority.length === 0
    || /[\u0000-\u0020\u007f/@\\?#%]/.test(authority)
  ) {
    return undefined;
  }

  let hostname;
  let portText;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) return undefined;
    hostname = authority.slice(1, close);
    const suffix = authority.slice(close + 1);
    if (suffix !== '') {
      if (!suffix.startsWith(':')) return undefined;
      portText = suffix.slice(1);
    }
    if (!isLoopbackIPv6(hostname)) return undefined;
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon >= 0) {
      if (authority.indexOf(':') !== colon) return undefined;
      hostname = authority.slice(0, colon);
      portText = authority.slice(colon + 1);
    } else {
      hostname = authority;
    }

    if (hostname.toLowerCase() !== 'localhost' && !isLoopbackIPv4(hostname)) {
      return undefined;
    }
  }

  let port = 80;
  if (portText !== undefined) {
    if (!/^[0-9]{1,5}$/.test(portText)) return undefined;
    port = Number(portText);
    if (port < 1 || port > 65_535) return undefined;
  }

  let canonicalHost = hostname.toLowerCase();
  if (net.isIP(hostname) === 6) {
    try {
      canonicalHost = new URL('http://[' + hostname + ']/').hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }
  return { hostname: canonicalHost, port };
}

function headerValues(req, name) {
  const rawHeaders = req.rawHeaders;
  if (Array.isArray(rawHeaders)) {
    const values = [];
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      if (String(rawHeaders[index]).toLowerCase() === name) values.push(rawHeaders[index + 1]);
    }
    return values;
  }

  const value = req.headers?.[name];
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}

function validHostAndOrigin(req) {
  const hosts = headerValues(req, 'host');
  const origins = headerValues(req, 'origin');
  if (hosts.length !== 1 || origins.length !== 1) return false;

  const host = parseLoopbackAuthority(hosts[0]);
  if (!host) return false;

  const originValue = origins[0];
  if (typeof originValue !== 'string' || originValue !== originValue.trim()) return false;
  let originUrl;
  try {
    originUrl = new URL(originValue);
  } catch {
    return false;
  }
  if (
    originUrl.protocol !== 'http:'
    || originUrl.origin !== originValue
    || originUrl.username !== ''
    || originUrl.password !== ''
    || originUrl.pathname !== '/'
    || originUrl.search !== ''
    || originUrl.hash !== ''
  ) {
    return false;
  }
  const origin = parseLoopbackAuthority(originUrl.host);
  return Boolean(origin && host.hostname === origin.hostname && host.port === origin.port);
}

function isSanitizedPath(path) {
  if (typeof path !== 'string' || path.length < 1 || path.length > 128 || !path.startsWith('/')) {
    return false;
  }
  if (path === '/') return true;
  const segments = path.slice(1).split('/');
  return segments.every((segment) => (
    segment === ':id'
    || SAFE_PATH_SEGMENTS.has(segment)
    || /^v[0-9]{1,2}$/.test(segment)
  ));
}

function validAttributePath(attributes, safeAttributes) {
  if (!Object.prototype.hasOwnProperty.call(attributes, 'path')) return true;
  if (!isSanitizedPath(attributes.path)) return false;
  safeAttributes.path = attributes.path;
  return true;
}

function validOptionalLine(attributes, field, safeAttributes) {
  if (!Object.prototype.hasOwnProperty.call(attributes, field)) return true;
  const value = attributes[field];
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) return false;
  safeAttributes[field] = value;
  return true;
}

function buildSafeSpan(span) {
  const spanFields = [
    'traceId',
    'spanId',
    'service',
    'operation',
    'startTime',
    'endTime',
    'status',
    'attributes',
  ];
  if (!hasKeys(span, spanFields, [...spanFields, 'parentSpanId'])) throw invalidRequest();
  const hasParentSpanId = Object.prototype.hasOwnProperty.call(span, 'parentSpanId');
  if (
    typeof span.traceId !== 'string'
    || !TRACE_ID_PATTERN.test(span.traceId)
    || typeof span.spanId !== 'string'
    || !/^[a-f0-9]{32}$/.test(span.spanId)
    || span.service !== SERVICE
    || !Number.isSafeInteger(span.startTime)
    || !Number.isSafeInteger(span.endTime)
    || span.startTime < 0
    || span.endTime < span.startTime
    || span.endTime > 8_640_000_000_000_000
    || !isRecord(span.attributes)
    || typeof span.attributes.eventType !== 'string'
    || !Object.prototype.hasOwnProperty.call(EVENT_OPERATION, span.attributes.eventType)
    || span.operation !== EVENT_OPERATION[span.attributes.eventType]
    || (hasParentSpanId && (typeof span.parentSpanId !== 'string'
      || !/^[a-f0-9]{32}$/.test(span.parentSpanId)
      || span.parentSpanId === span.spanId))
  ) {
    throw invalidRequest();
  }

  const eventType = span.attributes.eventType;
  const inputAttributes = span.attributes;
  const commonAttribute = ['eventType'];
  let safeAttributes;
  let expectedStatus;

  if (eventType === 'navigation') {
    if (!hasKeys(inputAttributes, commonAttribute, commonAttribute)
      || hasParentSpanId || span.startTime > span.endTime) {
      throw invalidRequest();
    }
    safeAttributes = { eventType };
    expectedStatus = 'ok';
  } else if (eventType === 'web_vital') {
    const fields = [...commonAttribute, 'metric', 'value', 'delta', 'rating'];
    if (!hasKeys(inputAttributes, fields, fields)) throw invalidRequest();
    if (
      !WEB_VITAL_METRICS.has(inputAttributes.metric)
      || typeof inputAttributes.value !== 'number'
      || !Number.isFinite(inputAttributes.value)
      || inputAttributes.value < 0
      || inputAttributes.value > 1_000_000_000
      || typeof inputAttributes.delta !== 'number'
      || !Number.isFinite(inputAttributes.delta)
      || Math.abs(inputAttributes.delta) > 1_000_000_000
      || !RATINGS.has(inputAttributes.rating)
      || span.startTime !== span.endTime
    ) {
      throw invalidRequest();
    }
    safeAttributes = {
      eventType,
      metric: inputAttributes.metric,
      value: inputAttributes.value,
      delta: inputAttributes.delta,
      rating: inputAttributes.rating,
    };
    expectedStatus = 'ok';
  } else if (eventType === 'javascript_error') {
    const required = [...commonAttribute, 'errorName'];
    const allowed = [...required, 'path', 'line', 'column'];
    if (!hasKeys(inputAttributes, required, allowed) || !ERROR_NAMES.has(inputAttributes.errorName)) {
      throw invalidRequest();
    }
    safeAttributes = { eventType, errorName: inputAttributes.errorName };
    if (
      !validAttributePath(inputAttributes, safeAttributes)
      || !validOptionalLine(inputAttributes, 'line', safeAttributes)
      || !validOptionalLine(inputAttributes, 'column', safeAttributes)
      || span.startTime !== span.endTime
    ) {
      throw invalidRequest();
    }
    expectedStatus = 'error';
  } else if (eventType === 'unhandled_rejection') {
    const fields = [...commonAttribute, 'errorName'];
    if (!hasKeys(inputAttributes, fields, fields) || !ERROR_NAMES.has(inputAttributes.errorName)
      || span.startTime !== span.endTime) {
      throw invalidRequest();
    }
    safeAttributes = { eventType, errorName: inputAttributes.errorName };
    expectedStatus = 'error';
  } else {
    const required = [...commonAttribute, 'source', 'reason', 'method'];
    const allowed = [...required, 'httpStatus', 'path'];
    if (!hasKeys(inputAttributes, required, allowed)
      || !['fetch', 'xhr'].includes(inputAttributes.source)
      || !['network', 'http'].includes(inputAttributes.reason)
      || !HTTP_METHODS.has(inputAttributes.method)
      || !validAttributePath(inputAttributes, {})) {
      throw invalidRequest();
    }

    const hasHttpStatus = Object.prototype.hasOwnProperty.call(inputAttributes, 'httpStatus');
    if (
      (inputAttributes.reason === 'http'
        && (!hasHttpStatus
          || !Number.isSafeInteger(inputAttributes.httpStatus)
          || inputAttributes.httpStatus < 100
          || inputAttributes.httpStatus > 599
          || (inputAttributes.httpStatus >= 200 && inputAttributes.httpStatus < 300)))
      || (inputAttributes.reason === 'network' && hasHttpStatus)
    ) {
      throw invalidRequest();
    }
    safeAttributes = {
      eventType,
      source: inputAttributes.source,
      reason: inputAttributes.reason,
      method: inputAttributes.method,
      ...(hasHttpStatus ? { httpStatus: inputAttributes.httpStatus } : {}),
      ...(Object.prototype.hasOwnProperty.call(inputAttributes, 'path') ? { path: inputAttributes.path } : {}),
    };
    expectedStatus = 'error';
  }

  if (span.status !== expectedStatus) throw invalidRequest();
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(hasParentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    service: SERVICE,
    operation: EVENT_OPERATION[eventType],
    startTime: span.startTime,
    endTime: span.endTime,
    status: expectedStatus,
    attributes: safeAttributes,
  };
}

function validateContentHeaders(req) {
  const contentTypes = headerValues(req, 'content-type');
  if (
    contentTypes.length !== 1
    || typeof contentTypes[0] !== 'string'
    || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentTypes[0])
  ) {
    throw invalidRequest();
  }

  const encodings = headerValues(req, 'content-encoding');
  if (encodings.length > 1 || (encodings.length === 1 && encodings[0].toLowerCase() !== 'identity')) {
    throw invalidRequest();
  }

  const lengths = headerValues(req, 'content-length');
  const transferEncodings = headerValues(req, 'transfer-encoding');
  if (lengths.length > 1 || (lengths.length > 0 && transferEncodings.length > 0)) {
    throw invalidRequest();
  }
  if (lengths.length === 1) {
    if (!/^[0-9]+$/.test(lengths[0])) throw invalidRequest();
    const length = Number(lengths[0]);
    if (!Number.isSafeInteger(length)) throw invalidRequest();
    if (length > MAX_BODY_BYTES) throw new RelayError(413, 'Browser span request is too large');
  }
}

function readRequestBody(req, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      req.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.pause?.();
      reject(error);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) {
        fail(new RelayError(413, 'Browser span request is too large'));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size).toString('utf8'));
    };
    const onAborted = () => fail(invalidRequest());
    const onError = () => fail(invalidRequest());
    const onAbort = () => fail(new RelayError(504, 'Browser span relay timed out'));

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function safeTraceHeader(req) {
  const values = headerValues(req, 'x-trace-id');
  return values.length === 1
    && typeof values[0] === 'string'
    && TRACE_ID_PATTERN.test(values[0])
    ? values[0]
    : undefined;
}

function sendJson(req, res, status, payload, closeConnection = false) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (closeConnection) res.setHeader('connection', 'close');
  const body = JSON.stringify(payload);
  res.end(body);
}

function cancelResponseBody(response) {
  try {
    const cancellation = response?.body?.cancel?.();
    if (cancellation && typeof cancellation.catch === 'function') {
      void cancellation.catch(() => undefined);
    }
  } catch {
    // The upstream body is intentionally never inspected or forwarded.
  }
}

function createBrowserSpanRelay(options = {}) {
  const projectKey = typeof options.projectKey === 'string' ? options.projectKey : '';
  const apiPort = parseApiPort(options.apiPort === undefined ? 3001 : options.apiPort);
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, DEFAULT_TIMEOUT_MS);
  const maxInFlight = boundedInteger(options.maxInFlight, DEFAULT_MAX_IN_FLIGHT, 1, 32);
  const maxRequestsPerMinute = boundedInteger(
    options.maxRequestsPerMinute,
    DEFAULT_MAX_REQUESTS_PER_MINUTE,
    1,
    1_000,
  );
  const fetchImpl = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : globalThis.fetch?.bind(globalThis);
  const configured = PROJECT_KEY_PATTERN.test(projectKey) && apiPort !== undefined && fetchImpl;

  let inFlight = 0;
  let rateWindowStartedAt = 0;
  let rateWindowCount = 0;

  function takeRateToken() {
    const now = Date.now();
    if (rateWindowStartedAt === 0 || now - rateWindowStartedAt >= 60_000 || now < rateWindowStartedAt) {
      rateWindowStartedAt = now;
      rateWindowCount = 0;
    }
    if (rateWindowCount >= maxRequestsPerMinute) return false;
    rateWindowCount += 1;
    return true;
  }

  async function handleRequest(req, res) {
    inFlight += 1;
    const controller = new AbortController();
    let timeoutHandle;
    const timeoutPromise = new Promise((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new RelayError(504, 'Browser span relay timed out'));
      }, timeoutMs);
      timeoutHandle.unref?.();
    });

    const operation = (async () => {
      if (!configured) throw new RelayError(503, 'Browser span relay is unavailable');
      validateContentHeaders(req);

      const rawBody = await readRequestBody(req, controller.signal);
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw invalidRequest();
      }
      if (
        !hasKeys(body, ['environment', 'spans'], ['environment', 'spans'])
        || body.environment !== 'dev'
        || !Array.isArray(body.spans)
        || body.spans.length < 1
        || body.spans.length > MAX_BATCH_SIZE
      ) {
        throw invalidRequest();
      }

      const spans = body.spans.map(buildSafeSpan);
      const upstreamHeaders = { 'content-type': 'application/json' };
      const traceId = safeTraceHeader(req);
      if (traceId) upstreamHeaders['x-trace-id'] = traceId;

      let upstream;
      try {
        upstream = await fetchImpl(
          'http://127.0.0.1:' + apiPort + '/api/v1/spans',
          {
            method: 'POST',
            redirect: 'manual',
            headers: upstreamHeaders,
            body: JSON.stringify({ projectKey, environment: 'dev', spans }),
            signal: controller.signal,
          },
        );
      } catch {
        throw new RelayError(503, 'Browser span relay is unavailable');
      }
      cancelResponseBody(upstream);
      if (!upstream || upstream.status !== 202) {
        throw new RelayError(503, 'Browser span relay is unavailable');
      }
      return {
        status: 'queued',
        delivery: 'queued_in_memory',
        durability: 'best_effort',
        acceptedSpans: spans.length,
      };
    })();

    try {
      const result = await Promise.race([operation, timeoutPromise]);
      sendJson(req, res, 202, result);
    } catch (error) {
      if (error instanceof RelayError) {
        sendJson(
          req,
          res,
          error.status,
          { status: 'rejected', message: error.message },
          error.closeConnection,
        );
      } else {
        sendJson(req, res, 503, { status: 'rejected', message: 'Browser span relay is unavailable' }, true);
      }
    } finally {
      clearTimeout(timeoutHandle);
      inFlight -= 1;
    }
  }

  return function browserSpanRelay(req, res, next) {
    if (req.method !== 'POST') return next();
    const requestTarget = typeof req.url === 'string' ? req.url : '';
    if (requestTarget !== ROUTE) {
      if (requestTarget.startsWith(ROUTE + '?')) {
        sendJson(req, res, 400, { status: 'rejected', message: 'Invalid browser span request' }, true);
        return undefined;
      }
      return next();
    }
    if (!isLoopbackSocket(req) || !validHostAndOrigin(req)) {
      sendJson(req, res, 403, { status: 'rejected', message: 'Request is not allowed' }, true);
      return undefined;
    }
    if (!takeRateToken() || inFlight >= maxInFlight) {
      sendJson(req, res, 429, { status: 'rejected', message: 'Browser span relay is busy' }, true);
      return undefined;
    }
    return handleRequest(req, res);
  };
}

module.exports = { createBrowserSpanRelay };
