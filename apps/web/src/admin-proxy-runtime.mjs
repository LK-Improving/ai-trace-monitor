import { request as httpRequest } from 'node:http';

const MAX_QUERY_LENGTH = 4096;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ALERT_STATE_BODY_BYTES = 1024;
const MAX_ALERT_CHANNEL_BODY_BYTES = 8192;
const MAX_ALERT_ACTION_BODY_BYTES = 512;
const MAX_PROJECT_SERVICE_BODY_BYTES = 1024;
const MAX_PROJECT_KEY_BODY_BYTES = 4096;
const MAX_PROJECT_PRIVACY_BODY_BYTES = 32 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PARENT_SPAN_ID_PATTERN = /^[a-f0-9]{32}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ENVIRONMENTS = new Set(['dev', 'staging', 'prod']);
const OVERVIEW_ENVIRONMENTS = new Set(['dev', 'staging', 'prod', 'all']);
const METRIC_RANGES = new Set(['1h', '24h', '7d']);
const ALERT_STATES = new Set(['active', 'acknowledged', 'resolved', 'all']);
const ALERT_LEVELS = new Set(['info', 'warning', 'critical', 'all']);
const CHANNEL_TYPES = new Set(['webhook', 'email']);
const CHANNEL_ENVIRONMENTS = new Set(['all', 'dev', 'staging', 'prod']);
const DELIVERY_STATUSES = new Set(['all', 'queued', 'sending', 'retrying', 'sent', 'failed', 'canceled']);
const DELIVERY_LEVELS = new Set(['info', 'warning', 'critical']);

const ADMIN_PATH_PREFIXES = [
  '/api/v1/projects',
  '/api/v1/overview',
  '/api/v1/metrics',
  '/api/v1/traces',
  '/api/v1/alerts',
  '/api/v1/ops',
];

const SAFE_ERRORS = {
  badTarget: {
    status: 400,
    error: 'invalid_admin_request',
    message: '管理查询的请求路径或参数无效。',
  },
  forbidden: {
    status: 403,
    error: 'local_same_origin_required',
    message: '管理请求仅允许来自本机同源开发页面。',
  },
  method: {
    status: 405,
    error: 'method_not_allowed',
    message: '本地管理代理仅允许白名单读取和配置变更。',
  },
  notAllowed: {
    status: 404,
    error: 'admin_route_not_allowed',
    message: '该管理 API 路径不在本地代理白名单中。',
  },
  bodyNotAllowed: {
    status: 400,
    error: 'request_body_not_allowed',
    message: '本地管理查询不接受请求体。',
  },
  invalidAlertStateBody: {
    status: 400,
    error: 'invalid_alert_state_body',
    message: '告警状态请求体必须是仅包含有效 state 字段的 JSON 对象。',
  },
  invalidAlertChannelBody: {
    status: 400,
    error: 'invalid_alert_channel_body',
    message: '告警通知渠道请求体无效或包含未允许的字段。',
  },
  invalidAlertActionBody: {
    status: 400,
    error: 'invalid_alert_action_body',
    message: '告警通知操作请求体必须只包含有效的 projectId。',
  },
  invalidProjectServiceBody: {
    status: 400,
    error: 'invalid_project_service_body',
    message: '服务请求体必须只包含有效的 name 与 environment。',
  },
  invalidProjectPrivacyBody: {
    status: 400,
    error: 'invalid_project_privacy_body',
    message: '隐私策略请求体必须只包含有效的 additionalRedactedFields。',
  },
  invalidProjectKeyBody: {
    status: 400,
    error: 'invalid_project_key_body',
    message: '项目凭证请求体必须只包含有效的 name 与 scopes。',
  },
  missingCredential: {
    status: 401,
    error: 'admin_proxy_not_configured',
    message: '本地管理查询代理未配置 PLATFORM_ADMIN_TOKEN，已安全拒绝请求。请仅在可信本地服务端设置该变量；生产环境请使用正式 BFF。',
  },
  upstreamUnavailable: {
    status: 502,
    error: 'admin_upstream_unavailable',
    message: '本地管理 API 暂时无法完成查询。',
  },
  upstreamTimeout: {
    status: 504,
    error: 'admin_upstream_timeout',
    message: '本地管理 API 查询超时，请稍后重试。',
  },
};

function hasPathBoundary(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return false;
  if (pathname === prefix) return true;
  const next = pathname[prefix.length];
  return next === '/' || next === '?' || next === '#' || next === '\\' || next === '%' || next === ';';
}

function isAdminPathCandidate(pathname) {
  return ADMIN_PATH_PREFIXES.some((prefix) => hasPathBoundary(pathname, prefix));
}

function exactRoute(pathname) {
  if (pathname === '/api/v1/projects') return { name: 'projects', path: pathname };

  const projectAuditMatch = pathname.match(/^\/api\/v1\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/audit-logs$/i);
  if (projectAuditMatch) return { name: 'projectAuditLogs', path: pathname, projectId: projectAuditMatch[1] };
  const projectKeyRotateMatch = pathname.match(/^\/api\/v1\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/keys\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/rotate$/i);
  if (projectKeyRotateMatch) return { name: 'projectKeyRotate', path: pathname, projectId: projectKeyRotateMatch[1], keyId: projectKeyRotateMatch[2] };
  const projectKeyMatch = pathname.match(/^\/api\/v1\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/keys(?:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/i);
  if (projectKeyMatch) return {
    name: projectKeyMatch[2] ? 'projectKey' : 'projectKeys',
    path: pathname,
    projectId: projectKeyMatch[1],
    ...(projectKeyMatch[2] ? { keyId: projectKeyMatch[2] } : {}),
  };
  const projectPrivacyMatch = pathname.match(/^\/api\/v1\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/privacy$/i);
  if (projectPrivacyMatch) return { name: 'projectPrivacy', path: pathname, projectId: projectPrivacyMatch[1] };
  const projectServicesMatch = pathname.match(/^\/api\/v1\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/services$/i);
  if (projectServicesMatch) return { name: 'projectServices', path: pathname, projectId: projectServicesMatch[1] };

  if (pathname === '/api/v1/overview') return { name: 'overview', path: pathname };
  if (pathname === '/api/v1/metrics/overview') return { name: 'metricsOverview', path: pathname };
  if (pathname === '/api/v1/metrics/ai') return { name: 'metricsAi', path: pathname };
  if (pathname === '/api/v1/traces') return { name: 'traces', path: pathname };
  if (pathname === '/api/v1/alerts') return { name: 'alerts', path: pathname };
  if (pathname === '/api/v1/alerts/summary') return { name: 'alertSummary', path: pathname };
  if (pathname === '/api/v1/ops/health') return { name: 'opsHealth', path: pathname };
  if (pathname === '/api/v1/alerts/channels') return { name: 'alertChannels', path: pathname };
  if (pathname === '/api/v1/alerts/deliveries') return { name: 'alertDeliveries', path: pathname };

  const channelTestMatch = pathname.match(/^\/api\/v1\/alerts\/channels\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/test$/i);
  if (channelTestMatch) return { name: 'alertChannelTest', path: pathname, channelId: channelTestMatch[1] };
  const channelMatch = pathname.match(/^\/api\/v1\/alerts\/channels\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (channelMatch) return { name: 'alertChannel', path: pathname, channelId: channelMatch[1] };
  const deliveryRetryMatch = pathname.match(/^\/api\/v1\/alerts\/deliveries\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/retry$/i);
  if (deliveryRetryMatch) return { name: 'alertDeliveryRetry', path: pathname, deliveryId: deliveryRetryMatch[1] };

  const alertStateMatch = pathname.match(/^\/api\/v1\/alerts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/state$/i);
  if (alertStateMatch) return { name: 'alertState', path: pathname, alertId: alertStateMatch[1] };

  const detailPrefix = '/api/v1/traces/';
  if (pathname.startsWith(detailPrefix)) {
    const traceId = pathname.slice(detailPrefix.length);
    if (traceId && !traceId.includes('/')) return { name: 'traceDetail', path: pathname, traceId };
  }
  return undefined;
}

/**
 * Recognize a potential management request without normalizing an accepted
 * path. Every path that can receive a credential must be exact origin-form.
 */
export function inspectAdminRequestTarget(target) {
  if (typeof target !== 'string' || target.length === 0) return undefined;

  const originForm = target.startsWith('/') && !target.startsWith('//');
  let pathname;
  let rawQuery = '';
  if (originForm) {
    const queryIndex = target.indexOf('?');
    pathname = queryIndex === -1 ? target : target.slice(0, queryIndex);
    rawQuery = queryIndex === -1 ? '' : target.slice(queryIndex + 1);
  } else {
    try {
      pathname = new URL(target, 'http://vite.local').pathname;
    } catch {
      return undefined;
    }
  }

  if (!isAdminPathCandidate(pathname)) return undefined;
  if (!originForm || /[^\x21-\x7e]|[\\#]/.test(target)) {
    return { candidate: true, valid: false, reason: 'origin-form' };
  }

  const route = exactRoute(pathname);
  if (!route) return { candidate: true, valid: false, reason: 'route' };
  if (route.name === 'opsHealth' && target.includes('?')) return { candidate: true, valid: false, reason: 'origin-form' };
  return { candidate: true, valid: true, route, rawQuery };
}

function invalidQuery() {
  return { valid: false, status: 400, error: 'invalid_admin_query', message: '管理查询参数无效或包含未允许的字段。' };
}

function queryMap(rawQuery) {
  if (typeof rawQuery !== 'string' || rawQuery.length > MAX_QUERY_LENGTH) return undefined;
  if (rawQuery === '') return new Map();

  const result = new Map();
  for (const part of rawQuery.split('&')) {
    if (!part) return undefined;
    const equalIndex = part.indexOf('=');
    const rawKey = equalIndex === -1 ? part : part.slice(0, equalIndex);
    const rawValue = equalIndex === -1 ? '' : part.slice(equalIndex + 1);
    let key;
    let value;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      return undefined;
    }
    if (!key || result.has(key)) return undefined;
    result.set(key, value);
  }
  return result;
}

function hasOnlyKeys(query, allowed) {
  for (const key of query.keys()) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = value.length === 20 ? value.replace('Z', '.000Z') : value;
  return new Date(parsed).toISOString() === canonical;
}

function validWindow(from, to) {
  if (!validTimestamp(from) || !validTimestamp(to)) return false;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  return fromMs < toMs && toMs - fromMs <= 30 * 24 * 60 * 60 * 1000;
}

function validMetricQuery(query) {
  const allowed = new Set(['projectId', 'environment', 'range', 'service', 'from', 'to', 'groupBy']);
  if (!hasOnlyKeys(query, allowed) || !UUID_PATTERN.test(query.get('projectId') ?? '')) return false;

  const environment = query.get('environment');
  if (environment !== undefined && !OVERVIEW_ENVIRONMENTS.has(environment)) return false;
  const range = query.get('range');
  if (range !== undefined && !METRIC_RANGES.has(range)) return false;
  const groupBy = query.get('groupBy');
  if (groupBy !== undefined && groupBy !== 'service') return false;

  const service = query.get('service');
  if (service !== undefined && (service.length > 120 || /[\u0000-\u001f\u007f]/.test(service) || service.trim() !== service)) {
    return false;
  }

  const from = query.get('from');
  const to = query.get('to');
  if ((from === undefined) !== (to === undefined)) return false;
  if (from !== undefined && (range !== undefined || !validWindow(from, to))) return false;
  return true;
}

function validOverviewQuery(query) {
  const allowed = new Set(['projectId', 'environment', 'range']);
  if (!hasOnlyKeys(query, allowed) || !UUID_PATTERN.test(query.get('projectId') ?? '')) return false;
  const environment = query.get('environment');
  const range = query.get('range');
  return (environment === undefined || OVERVIEW_ENVIRONMENTS.has(environment))
    && (range === undefined || METRIC_RANGES.has(range));
}

function validPositiveInteger(value, maximum) {
  return typeof value === 'string' && /^[1-9]\d{0,5}$/.test(value) && Number(value) <= maximum;
}

function validTraceListQuery(query) {
  const allowed = new Set(['projectId', 'environment', 'from', 'to', 'traceId', 'service', 'status', 'page', 'pageSize']);
  if (!hasOnlyKeys(query, allowed) || !UUID_PATTERN.test(query.get('projectId') ?? '')) return false;

  const environment = query.get('environment');
  if (environment !== undefined && !OVERVIEW_ENVIRONMENTS.has(environment)) return false;
  if (!validWindow(query.get('from'), query.get('to'))) return false;

  const traceId = query.get('traceId');
  if (traceId !== undefined && !TRACE_ID_PATTERN.test(traceId)) return false;
  const service = query.get('service');
  if (service !== undefined && (service.length < 1 || service.length > 120)) return false;
  const status = query.get('status');
  if (status !== undefined && status !== 'ok' && status !== 'error') return false;

  const page = query.get('page') ?? '1';
  const pageSize = query.get('pageSize') ?? '20';
  if (!validPositiveInteger(page, 1000) || !validPositiveInteger(pageSize, 100)) return false;
  return (Number(page) - 1) * Number(pageSize) <= 10000;
}

function validTraceDetailQuery(route, query) {
  const allowed = new Set(['projectId', 'environment', 'from', 'to', 'includeContent']);
  if (!hasOnlyKeys(query, allowed) || !UUID_PATTERN.test(query.get('projectId') ?? '')) return false;
  if (!TRACE_ID_PATTERN.test(route.traceId)) return false;
  if (!ENVIRONMENTS.has(query.get('environment'))) return false;

  const includeContent = query.get('includeContent');
  if (includeContent === 'true') {
    return { valid: false, status: 403, error: 'trace_content_unavailable', message: 'Trace 内容读取已禁用。' };
  }
  if (includeContent !== undefined && includeContent !== 'false') return false;

  const from = query.get('from');
  const to = query.get('to');
  if ((from === undefined) !== (to === undefined)) return false;
  return from === undefined || validWindow(from, to);
}

function validAlertListQuery(query) {
  const allowed = new Set(['projectId', 'environment', 'state', 'level', 'page', 'pageSize']);
  if (!hasOnlyKeys(query, allowed) || !UUID_PATTERN.test(query.get('projectId') ?? '')) return false;

  const environment = query.get('environment');
  if (environment === undefined || !OVERVIEW_ENVIRONMENTS.has(environment)) return false;
  const state = query.get('state') ?? 'all';
  const level = query.get('level') ?? 'all';
  if (!ALERT_STATES.has(state) || !ALERT_LEVELS.has(level)) return false;

  const page = query.get('page') ?? '1';
  const pageSize = query.get('pageSize') ?? '20';
  if (!validPositiveInteger(page, 1000) || !validPositiveInteger(pageSize, 100)) return false;
  return (Number(page) - 1) * Number(pageSize) <= 10_000;
}

function validAlertSummaryQuery(query) {
  const allowed = new Set(['projectId', 'environment']);
  return hasOnlyKeys(query, allowed)
    && UUID_PATTERN.test(query.get('projectId') ?? '')
    && OVERVIEW_ENVIRONMENTS.has(query.get('environment'));
}

function validProjectQuery(query) {
  return hasOnlyKeys(query, new Set(['projectId'])) && UUID_PATTERN.test(query.get('projectId') ?? '');
}

function validAlertDeliveryQuery(query) {
  const allowed = new Set(['projectId', 'status', 'page', 'pageSize']);
  if (!hasOnlyKeys(query, allowed) || !UUID_PATTERN.test(query.get('projectId') ?? '')
    || !DELIVERY_STATUSES.has(query.get('status'))) return false;
  const page = query.get('page');
  const pageSize = query.get('pageSize');
  if (!validPositiveInteger(page, 1000) || !validPositiveInteger(pageSize, 100)) return false;
  return (Number(page) - 1) * Number(pageSize) <= 10_000;
}

/** Parse a deliberately narrow JSON shape so duplicate or extra keys cannot be hidden by JSON.parse. */
export function validateAlertStateBody(rawBody) {
  if (typeof rawBody !== 'string' || Buffer.byteLength(rawBody, 'utf8') > MAX_ALERT_STATE_BODY_BYTES) {
    return SAFE_ERRORS.invalidAlertStateBody;
  }
  const match = rawBody.match(/^\s*\{\s*"state"\s*:\s*"(active|acknowledged|resolved)"\s*\}\s*$/);
  return match
    ? { valid: true, state: match[1] }
    : SAFE_ERRORS.invalidAlertStateBody;
}

function parseStrictJsonObject(rawBody, maximumBytes) {
  if (typeof rawBody !== 'string' || Buffer.byteLength(rawBody, 'utf8') > maximumBytes) return undefined;
  let index = 0;
  const skipWhitespace = () => {
    while (index < rawBody.length && /\s/.test(rawBody[index])) index += 1;
  };
  const readString = () => {
    if (rawBody[index] !== '"') return undefined;
    const start = index++;
    while (index < rawBody.length) {
      const character = rawBody[index++];
      if (character === '"') {
        try {
          return JSON.parse(rawBody.slice(start, index));
        } catch {
          return undefined;
        }
      }
      if (character === '\\') index += 1;
      else if (character.charCodeAt(0) < 0x20) return undefined;
    }
    return undefined;
  };

  skipWhitespace();
  if (rawBody[index++] !== '{') return undefined;
  const result = Object.create(null);
  const keys = new Set();
  skipWhitespace();
  if (rawBody[index] === '}') index += 1;
  else {
    while (index < rawBody.length) {
      skipWhitespace();
      const key = readString();
      if (typeof key !== 'string' || keys.has(key)) return undefined;
      keys.add(key);
      skipWhitespace();
      if (rawBody[index++] !== ':') return undefined;
      skipWhitespace();
      let value;
      if (rawBody[index] === '"') value = readString();
      else if (rawBody[index] === '[') {
        index += 1;
        value = [];
        skipWhitespace();
        if (rawBody[index] !== ']') {
          while (index < rawBody.length) {
            skipWhitespace();
            const entry = readString();
            if (typeof entry !== 'string') return undefined;
            value.push(entry);
            skipWhitespace();
            if (rawBody[index] === ']') break;
            if (rawBody[index++] !== ',') return undefined;
          }
        }
        if (rawBody[index++] !== ']') return undefined;
      }
      else if (rawBody.startsWith('true', index)) {
        value = true;
        index += 4;
      } else if (rawBody.startsWith('false', index)) {
        value = false;
        index += 5;
      } else return undefined;
      if (value === undefined) return undefined;
      result[key] = value;
      skipWhitespace();
      if (rawBody[index] === '}') {
        index += 1;
        break;
      }
      if (rawBody[index++] !== ',') return undefined;
    }
  }
  skipWhitespace();
  return index === rawBody.length ? result : undefined;
}

function validChannelDestination(type, value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > (type === 'webhook' ? 2048 : 254)
    || /[\u0000-\u001f\u007f]/.test(value) || value.trim() !== value) return false;
  if (type === 'email') {
    if (/\s/.test(value)) return false;
    const separator = value.indexOf('@');
    const domain = value.slice(separator + 1);
    return separator > 0 && separator === value.lastIndexOf('@') && domain.includes('.')
      && !domain.startsWith('.') && !domain.endsWith('.');
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function validChannelName(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 120
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

export function validateAlertChannelBody(rawBody, operation) {
  const body = parseStrictJsonObject(rawBody, MAX_ALERT_CHANNEL_BODY_BYTES);
  if (!body) return SAFE_ERRORS.invalidAlertChannelBody;
  const common = new Set(['projectId', 'name', 'type', 'environment', 'minLevel', 'enabled', 'webhookUrl', 'recipient']);
  if (!UUID_PATTERN.test(body.projectId ?? '')) return SAFE_ERRORS.invalidAlertChannelBody;

  if (operation === 'create') {
    if (Object.keys(body).length !== 6 + (body.type === 'webhook' || body.type === 'email' ? 1 : 0)
      || !['projectId', 'name', 'type', 'environment', 'minLevel', 'enabled'].every((key) => key in body)
      || !validChannelName(body.name) || !CHANNEL_TYPES.has(body.type)
      || !CHANNEL_ENVIRONMENTS.has(body.environment) || !DELIVERY_LEVELS.has(body.minLevel)
      || typeof body.enabled !== 'boolean') return SAFE_ERRORS.invalidAlertChannelBody;
    const targetKey = body.type === 'webhook' ? 'webhookUrl' : 'recipient';
    const otherKey = body.type === 'webhook' ? 'recipient' : 'webhookUrl';
    if (!(targetKey in body) || otherKey in body || !validChannelDestination(body.type, body[targetKey])) {
      return SAFE_ERRORS.invalidAlertChannelBody;
    }
  } else if (operation === 'patch') {
    if (Object.keys(body).length < 2 || !Object.keys(body).every((key) => common.has(key))
      || 'type' in body
      || ('name' in body && !validChannelName(body.name))
      || ('type' in body && !CHANNEL_TYPES.has(body.type))
      || ('environment' in body && !CHANNEL_ENVIRONMENTS.has(body.environment))
      || ('minLevel' in body && !DELIVERY_LEVELS.has(body.minLevel))
      || ('enabled' in body && typeof body.enabled !== 'boolean')
      || ('webhookUrl' in body && !validChannelDestination('webhook', body.webhookUrl))
      || ('recipient' in body && !validChannelDestination('email', body.recipient))
      || ('webhookUrl' in body && 'recipient' in body)
      || ('webhookUrl' in body && body.type === 'email')
      || ('recipient' in body && body.type === 'webhook')) return SAFE_ERRORS.invalidAlertChannelBody;
  } else return SAFE_ERRORS.invalidAlertChannelBody;

  return { valid: true, value: Object.fromEntries(Object.entries(body)) };
}

export function validateAlertActionBody(rawBody) {
  const body = parseStrictJsonObject(rawBody, MAX_ALERT_ACTION_BODY_BYTES);
  return body && Object.keys(body).length === 1 && UUID_PATTERN.test(body.projectId ?? '')
    ? { valid: true, value: { projectId: body.projectId } }
    : SAFE_ERRORS.invalidAlertActionBody;
}

export function validateProjectServiceBody(rawBody) {
  const body = parseStrictJsonObject(rawBody, MAX_PROJECT_SERVICE_BODY_BYTES);
  return body && Object.keys(body).length === 2 && Object.keys(body).every((key) => key === 'name' || key === 'environment')
    && validChannelName(body.name) && ENVIRONMENTS.has(body.environment)
    ? { valid: true, value: { name: body.name, environment: body.environment } }
    : SAFE_ERRORS.invalidProjectServiceBody;
}

export function validateProjectPrivacyBody(rawBody) {
  const body = parseStrictJsonObject(rawBody, MAX_PROJECT_PRIVACY_BODY_BYTES);
  if (!body || Object.keys(body).length !== 1 || !Array.isArray(body.additionalRedactedFields)
    || body.additionalRedactedFields.length > 64) return SAFE_ERRORS.invalidProjectPrivacyBody;
  const normalized = new Set();
  for (const field of body.additionalRedactedFields) {
    if (typeof field !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(field)) return SAFE_ERRORS.invalidProjectPrivacyBody;
    const key = field.toLocaleLowerCase('en-US');
    if (normalized.has(key)) return SAFE_ERRORS.invalidProjectPrivacyBody;
    normalized.add(key);
  }
  return { valid: true, value: { additionalRedactedFields: body.additionalRedactedFields } };
}

export function validateProjectKeyBody(rawBody) {
  const body = parseStrictJsonObject(rawBody, MAX_PROJECT_KEY_BODY_BYTES);
  const allowedScopes = new Set(['spans:write', 'trace:read']);
  return body && Object.keys(body).length === 2 && Object.keys(body).every((key) => key === 'name' || key === 'scopes')
    && validChannelName(body.name) && Array.isArray(body.scopes) && body.scopes.length === 1
    && body.scopes.every((scope) => typeof scope === 'string' && allowedScopes.has(scope))
    && new Set(body.scopes).size === body.scopes.length
    ? { valid: true, value: { name: body.name, scopes: body.scopes } }
    : SAFE_ERRORS.invalidProjectKeyBody;
}

/** Validate query values against the matching backend controller DTO rules. */
export function validateAdminQuery(route, rawQuery, method) {
  const query = queryMap(rawQuery);
  if (!query || !route) return invalidQuery();

  let result = false;
  switch (route.name) {
    case 'projects':
      result = query.size === 0;
      break;
    case 'opsHealth':
      result = query.size === 0;
      break;
    case 'projectServices':
    case 'projectPrivacy':
    case 'projectKeys':
    case 'projectKey':
    case 'projectKeyRotate':
      result = UUID_PATTERN.test(route.projectId ?? '')
        && (route.keyId === undefined || UUID_PATTERN.test(route.keyId))
        && query.size === 0;
      break;
    case 'projectAuditLogs':
      result = UUID_PATTERN.test(route.projectId ?? '') && query.size === 2
        && query.get('page') === '1' && query.get('pageSize') === '20';
      break;
    case 'overview':
      result = validOverviewQuery(query);
      break;
    case 'metricsOverview':
    case 'metricsAi':
      result = validMetricQuery(query);
      break;
    case 'traces':
      result = validTraceListQuery(query);
      break;
    case 'traceDetail':
      result = validTraceDetailQuery(route, query);
      if (typeof result === 'object') return result;
      break;
    case 'alerts':
      result = validAlertListQuery(query);
      break;
    case 'alertSummary':
      result = validAlertSummaryQuery(query);
      break;
    case 'alertChannels':
      result = method === 'POST' ? query.size === 0 : method === 'GET' ? validProjectQuery(query)
        : query.size === 0 || validProjectQuery(query);
      break;
    case 'alertChannel':
      result = UUID_PATTERN.test(route.channelId ?? '') && (method === 'PATCH' ? query.size === 0
        : method === 'DELETE' ? validProjectQuery(query) : query.size === 0 || validProjectQuery(query));
      break;
    case 'alertChannelTest':
      result = UUID_PATTERN.test(route.channelId ?? '') && query.size === 0;
      break;
    case 'alertDeliveries':
      result = validAlertDeliveryQuery(query);
      break;
    case 'alertDeliveryRetry':
      result = UUID_PATTERN.test(route.deliveryId ?? '') && query.size === 0;
      break;
    case 'alertState':
      result = query.size === 0 && UUID_PATTERN.test(route.alertId ?? '');
      break;
    default:
      return invalidQuery();
  }

  if (!result) return invalidQuery();
  return {
    valid: true,
    entries: [...query.entries()],
    search: new URLSearchParams([...query.entries()]).toString(),
  };
}

function rawHeaderValues(request, name) {
  const values = [];
  const rawHeaders = request.rawHeaders;
  if (Array.isArray(rawHeaders)) {
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      if (String(rawHeaders[index]).toLowerCase() === name) values.push(String(rawHeaders[index + 1]));
    }
    return values;
  }

  const value = request.headers?.[name];
  if (Array.isArray(value)) return value.map(String);
  return value === undefined ? values : [String(value)];
}

function validatedTraceContextHeader(request, name, pattern) {
  const values = rawHeaderValues(request, name);
  if (values.length !== 1 || !pattern.test(values[0])) return undefined;
  return values[0];
}

function oneHeader(request, name) {
  const values = rawHeaderValues(request, name);
  if (values.length > 1) return { valid: false, present: true };
  if (values.length === 0) return { valid: true, present: false, value: undefined };
  const value = values[0];
  return { valid: value === value.trim() && !/[\r\n]/.test(value), present: true, value };
}

function loopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Enforce loopback Host and same-origin browser fetch metadata on admin
 * routes. Direct API navigation and headerless clients intentionally fail;
 * the app page's same-origin fetch is the supported browser entry point.
 */
export function validateLocalSameOrigin(request) {
  if (!loopbackAddress(request.socket?.remoteAddress)) return { ok: false, reason: 'remote-address' };

  const hostHeader = oneHeader(request, 'host');
  if (!hostHeader.valid || !hostHeader.present || !hostHeader.value) return { ok: false, reason: 'host' };

  let parsedHost;
  try {
    parsedHost = new URL(`http://${hostHeader.value}`);
  } catch {
    return { ok: false, reason: 'host' };
  }
  const hostname = parsedHost.hostname.toLowerCase();
  if (parsedHost.username || parsedHost.password || parsedHost.pathname !== '/' || parsedHost.search || parsedHost.hash
    || !['127.0.0.1', 'localhost', '[::1]'].includes(hostname)
    || !parsedHost.port || Number(parsedHost.port) !== request.socket?.localPort) {
    return { ok: false, reason: 'host' };
  }

  const origin = oneHeader(request, 'origin');
  if (!origin.valid) return { ok: false, reason: 'origin' };
  if (origin.present) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(origin.value);
    } catch {
      return { ok: false, reason: 'origin' };
    }
    if (parsedOrigin.protocol !== 'http:' || parsedOrigin.username || parsedOrigin.password
      || parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash
      || origin.value !== parsedOrigin.origin || parsedOrigin.origin !== parsedHost.origin) {
      return { ok: false, reason: 'origin' };
    }
  }

  const fetchSite = oneHeader(request, 'sec-fetch-site');
  if (!fetchSite.valid || !fetchSite.present || fetchSite.value !== 'same-origin') {
    return { ok: false, reason: 'sec-fetch-site' };
  }

  return { ok: true };
}

function sendJson(response, status, payload) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function sendSafeError(response, definition, statusOverride, messageOverride) {
  const status = statusOverride ?? definition.status;
  sendJson(response, status, {
    statusCode: status,
    error: definition.error,
    message: messageOverride ?? definition.message,
  });
}

function resolveOption(value, fallback) {
  return typeof value === 'function' ? value() : value ?? fallback;
}

function hasRequestBody(request) {
  const transferEncoding = rawHeaderValues(request, 'transfer-encoding');
  const expect = rawHeaderValues(request, 'expect');
  const contentLength = rawHeaderValues(request, 'content-length');
  if (transferEncoding.length > 0 || expect.length > 0 || contentLength.length > 1) return true;
  if (contentLength.length === 0) return false;
  return contentLength[0] !== '0';
}

function readJsonBody(request, options, maximumBytes, invalidBody, validator, callback) {
  const contentTypes = rawHeaderValues(request, 'content-type');
  const contentLengths = rawHeaderValues(request, 'content-length');
  const transferEncodings = rawHeaderValues(request, 'transfer-encoding');
  const contentEncodings = rawHeaderValues(request, 'content-encoding');
  const expectations = rawHeaderValues(request, 'expect');
  const contentType = contentTypes[0] ?? '';
  const contentLength = contentLengths[0];
  const validContentType = contentTypes.length === 1
    && /^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?$/i.test(contentType);
  const validLength = contentLengths.length === 1
    && /^(?:[1-9]\d{0,5})$/.test(contentLength ?? '')
    && Number(contentLength) <= maximumBytes;
  const validChunked = contentLengths.length === 0
    && transferEncodings.length === 1
    && transferEncodings[0].toLowerCase() === 'chunked';

  if (!validContentType || contentEncodings.length > 0 || expectations.length > 0
    || (transferEncodings.length > 0 && !validChunked)
    || (contentLengths.length > 0 && !validLength)
    || (!validLength && !validChunked)) {
    request.resume?.();
    callback(invalidBody);
    return;
  }

  let settled = false;
  let byteLength = 0;
  const chunks = [];
  const timeoutMs = Number.isInteger(options.bodyTimeoutMs) && options.bodyTimeoutMs > 0
    ? options.bodyTimeoutMs
    : DEFAULT_TIMEOUT_MS;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (result !== undefined && !result.valid) request.resume?.();
    callback(result);
  };
  const timeout = setTimeout(() => finish(invalidBody), timeoutMs);

  request.on('data', (chunk) => {
    if (settled) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.length;
    if (byteLength > maximumBytes) {
      finish(invalidBody);
      return;
    }
    chunks.push(buffer);
  });
  request.on('end', () => {
    if (settled) return;
    if (validLength && byteLength !== Number(contentLength)) {
      finish(invalidBody);
      return;
    }
    finish(validator(Buffer.concat(chunks).toString('utf8')));
  });
  request.on('aborted', () => finish(invalidBody));
  request.on('error', () => finish(invalidBody));
}

function validPort(value) {
  const source = String(value ?? '');
  if (!/^\d{1,5}$/.test(source)) return undefined;
  const port = Number(source);
  return port >= 1 && port <= 65535 ? port : undefined;
}

function proxyValidatedRequest(request, response, options, route, search, method, body) {
  const rawToken = resolveOption(options.adminToken, undefined);
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token || token.length > 8192 || !/^[\x21-\x7e]+$/.test(token)) {
    sendSafeError(response, SAFE_ERRORS.missingCredential);
    return;
  }

  const port = validPort(resolveOption(options.apiPort, '3001'));
  if (!port) {
    sendSafeError(response, SAFE_ERRORS.upstreamUnavailable);
    return;
  }

  let settled = false;
  let upstreamRequest;
  let deadlineTimer;
  const clearDeadline = () => {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
  };
  const finishError = (definition, status, message) => {
    if (settled) return false;
    settled = true;
    clearDeadline();
    sendSafeError(response, definition, status, message);
    return true;
  };
  const abortUpstream = (definition, status, message) => {
    if (finishError(definition, status, message)) upstreamRequest?.destroy();
  };

  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = Number.isInteger(options.maxResponseBytes) && options.maxResponseBytes > 0
    ? options.maxResponseBytes
    : DEFAULT_MAX_RESPONSE_BYTES;
  const upstreamPath = `${route.path}${search ? `?${search}` : ''}`;
  const traceId = validatedTraceContextHeader(request, 'x-trace-id', TRACE_ID_PATTERN);
  const parentSpanId = traceId
    ? validatedTraceContextHeader(request, 'x-parent-span-id', PARENT_SPAN_ID_PATTERN)
    : undefined;

  try {
    upstreamRequest = httpRequest({
      hostname: '127.0.0.1',
      port,
      method,
      path: upstreamPath,
      agent: false,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(traceId ? { 'x-trace-id': traceId } : {}),
        ...(parentSpanId ? { 'x-parent-span-id': parentSpanId } : {}),
        ...(body === undefined ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        }),
      },
    }, (upstreamResponse) => {
      upstreamResponse.on('error', () => abortUpstream(SAFE_ERRORS.upstreamUnavailable));
      const status = upstreamResponse.statusCode ?? 502;
      if (status < 200 || status >= 300) {
        const safeStatus = status >= 400 && status <= 599 ? status : 502;
        const definition = safeStatus < 500
          ? { error: 'admin_upstream_rejected', message: '本地管理 API 未接受该查询。' }
          : SAFE_ERRORS.upstreamUnavailable;
        abortUpstream(definition, safeStatus);
        return;
      }

      if (status === 204 && method !== 'GET') {
        settled = true;
        clearDeadline();
        response.statusCode = status;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.end();
        upstreamRequest.destroy();
        return;
      }

      const contentType = upstreamResponse.headers['content-type'];
      if (typeof contentType !== 'string' || !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;|$)/i.test(contentType)) {
        abortUpstream(SAFE_ERRORS.upstreamUnavailable);
        return;
      }

      const chunks = [];
      let byteLength = 0;
      upstreamResponse.on('data', (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += buffer.length;
        if (byteLength > maxResponseBytes) {
          abortUpstream(SAFE_ERRORS.upstreamUnavailable);
          return;
        }
        chunks.push(buffer);
      });
      upstreamResponse.on('end', () => {
        if (settled) return;
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          abortUpstream(SAFE_ERRORS.upstreamUnavailable);
          return;
        }
        settled = true;
        clearDeadline();
        sendJson(response, status, payload);
        upstreamRequest.destroy();
      });
      upstreamResponse.on('aborted', () => abortUpstream(SAFE_ERRORS.upstreamUnavailable));
    });
  } catch {
    finishError(SAFE_ERRORS.upstreamUnavailable);
    return;
  }

  upstreamRequest.setTimeout(timeoutMs, () => {
    abortUpstream(SAFE_ERRORS.upstreamTimeout);
  });
  upstreamRequest.on('error', () => abortUpstream(SAFE_ERRORS.upstreamUnavailable));
  deadlineTimer = setTimeout(() => {
    if (settled) return;
    abortUpstream(SAFE_ERRORS.upstreamTimeout);
  }, timeoutMs);
  request.on('aborted', () => {
    if (!settled) {
      settled = true;
      clearDeadline();
    }
    upstreamRequest.destroy();
  });
  response.on('close', () => {
    if (!response.writableEnded) {
      if (!settled) {
        settled = true;
        clearDeadline();
      }
      upstreamRequest.destroy();
    }
  });
  upstreamRequest.end(body);
}

/**
 * Vite-dev-only, same-origin, narrowly allowlisted admin middleware. It does
 * not mount in preview/production and never forwards client-supplied credentials.
 */
export function createAdminProxy(options = {}) {
  return (request, response, next) => {
    const inspected = inspectAdminRequestTarget(request.url);
    if (!inspected) {
      if (typeof request.url === 'string' && !request.url.startsWith('/') && /\/api\//i.test(request.url)) {
        sendSafeError(response, SAFE_ERRORS.badTarget);
        return;
      }
      next();
      return;
    }

    if (!validateLocalSameOrigin(request).ok) {
      request.resume?.();
      sendSafeError(response, SAFE_ERRORS.forbidden);
      return;
    }
    if (!inspected.valid) {
      request.resume?.();
      sendSafeError(response, inspected.reason === 'route' ? SAFE_ERRORS.notAllowed : SAFE_ERRORS.badTarget);
      return;
    }

    const allowedMethods = inspected.route.name === 'projectServices' ? ['GET', 'POST']
      : inspected.route.name === 'projectPrivacy' ? ['GET', 'PATCH']
        : inspected.route.name === 'projectKeys' ? ['GET', 'POST']
          : inspected.route.name === 'projectKey' ? ['DELETE']
            : inspected.route.name === 'projectKeyRotate' ? ['POST']
              : inspected.route.name === 'projectAuditLogs' ? ['GET']
                : inspected.route.name === 'alertState' ? ['PATCH']
      : inspected.route.name === 'alertChannels' ? ['GET', 'POST']
        : inspected.route.name === 'alertChannel' ? ['PATCH', 'DELETE']
          : inspected.route.name === 'alertChannelTest' || inspected.route.name === 'alertDeliveryRetry' ? ['POST']
            : ['GET'];
    if (!allowedMethods.includes(request.method)) {
      request.resume?.();
      response.setHeader('Allow', allowedMethods.join(', '));
      sendSafeError(response, SAFE_ERRORS.method);
      return;
    }

    const bodylessMethod = request.method === 'GET' || request.method === 'DELETE' || inspected.route.name === 'projectKeyRotate';
    if (bodylessMethod && hasRequestBody(request)) {
      request.resume?.();
      sendSafeError(response, SAFE_ERRORS.bodyNotAllowed);
      return;
    }

    const query = validateAdminQuery(inspected.route, inspected.rawQuery, request.method);
    if (!query.valid) {
      request.resume?.();
      sendSafeError(response, query, query.status, query.message);
      return;
    }

    const readAndForward = (maximumBytes, invalidBody, validator) => {
      readJsonBody(request, options, maximumBytes, invalidBody, validator, (bodyResult) => {
        if (!bodyResult?.valid) {
          sendSafeError(response, bodyResult ?? invalidBody);
          return;
        }
        proxyValidatedRequest(request, response, options, inspected.route, '', request.method, JSON.stringify(bodyResult.value));
      });
    };

    if (inspected.route.name === 'alertState') {
      readAndForward(MAX_ALERT_STATE_BODY_BYTES, SAFE_ERRORS.invalidAlertStateBody, (rawBody) => {
        const result = validateAlertStateBody(rawBody);
        return result.valid ? { valid: true, value: { state: result.state } } : result;
      });
      return;
    }
    if (request.method === 'POST' && inspected.route.name === 'alertChannels') {
      readAndForward(MAX_ALERT_CHANNEL_BODY_BYTES, SAFE_ERRORS.invalidAlertChannelBody,
        (rawBody) => validateAlertChannelBody(rawBody, 'create'));
      return;
    }
    if (request.method === 'PATCH' && inspected.route.name === 'alertChannel') {
      readAndForward(MAX_ALERT_CHANNEL_BODY_BYTES, SAFE_ERRORS.invalidAlertChannelBody,
        (rawBody) => validateAlertChannelBody(rawBody, 'patch'));
      return;
    }
    if (request.method === 'POST' && (inspected.route.name === 'alertChannelTest' || inspected.route.name === 'alertDeliveryRetry')) {
      readAndForward(MAX_ALERT_ACTION_BODY_BYTES, SAFE_ERRORS.invalidAlertActionBody, validateAlertActionBody);
      return;
    }
    if (request.method === 'POST' && inspected.route.name === 'projectServices') {
      readAndForward(MAX_PROJECT_SERVICE_BODY_BYTES, SAFE_ERRORS.invalidProjectServiceBody, validateProjectServiceBody);
      return;
    }
    if (request.method === 'PATCH' && inspected.route.name === 'projectPrivacy') {
      readAndForward(MAX_PROJECT_PRIVACY_BODY_BYTES, SAFE_ERRORS.invalidProjectPrivacyBody, validateProjectPrivacyBody);
      return;
    }
    if (request.method === 'POST' && inspected.route.name === 'projectKeys') {
      readAndForward(MAX_PROJECT_KEY_BODY_BYTES, SAFE_ERRORS.invalidProjectKeyBody, validateProjectKeyBody);
      return;
    }

    proxyValidatedRequest(request, response, options, inspected.route, query.search, request.method);
  };
}
