import { apiFetch } from './api';
import type { OverviewEnvironment } from './overview-api';
import type { TraceEnvironment } from './chain-api';

export type AlertLevel = 'info' | 'warning' | 'critical';
export type AlertState = 'active' | 'acknowledged' | 'resolved';
export type AlertStateFilter = AlertState | 'all';
export type AlertLevelFilter = AlertLevel | 'all';

export interface AlertItem {
  id: string;
  title: string;
  message: string;
  rule: string;
  service: string;
  environment: TraceEnvironment;
  level: AlertLevel;
  state: AlertState;
  traceId: string;
  spanId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  triggerCount: number;
}

export interface AlertListResponse {
  items: AlertItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AlertSummary {
  total: number;
  active: number;
  acknowledged: number;
  resolved: number;
  criticalActive: number;
}

export interface AlertListQuery {
  projectId: string;
  environment: OverviewEnvironment;
  state: AlertStateFilter;
  level: AlertLevelFilter;
  page: number;
  pageSize: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENVIRONMENTS = new Set<OverviewEnvironment>(['dev', 'staging', 'prod', 'all']);
const CONCRETE_ENVIRONMENTS = new Set<TraceEnvironment>(['dev', 'staging', 'prod']);
const ALERT_LEVELS = new Set<AlertLevel>(['info', 'warning', 'critical']);
const ALERT_STATES = new Set<AlertState>(['active', 'acknowledged', 'resolved']);

export class AlertApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'AlertApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function invalidResponse(): AlertApiError {
  return new AlertApiError('告警接口响应与约定不一致，请联系后端确认。');
}

function parseAlertItem(value: unknown): AlertItem {
  if (!isRecord(value) || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id)
    || !isText(value.title, 160) || !isText(value.message, 500) || !isText(value.rule, 64)
    || !isText(value.service, 120) || typeof value.environment !== 'string'
    || !CONCRETE_ENVIRONMENTS.has(value.environment as TraceEnvironment)
    || typeof value.level !== 'string' || !ALERT_LEVELS.has(value.level as AlertLevel)
    || typeof value.state !== 'string' || !ALERT_STATES.has(value.state as AlertState)
    || !isText(value.traceId, 128) || !TRACE_ID_PATTERN.test(value.traceId)
    || !isText(value.spanId, 128)
    || !isTimestamp(value.firstSeenAt) || !isTimestamp(value.lastSeenAt)
    || !Number.isSafeInteger(value.triggerCount) || (value.triggerCount as number) < 1) {
    throw invalidResponse();
  }
  return value as unknown as AlertItem;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseAlertListPayload(value: unknown, expected: Pick<AlertListQuery, 'page' | 'pageSize'>): AlertListResponse {
  if (!isRecord(value) || !Array.isArray(value.items) || !isCount(value.total)
    || value.page !== expected.page || value.pageSize !== expected.pageSize
    || value.items.length > expected.pageSize) {
    throw invalidResponse();
  }
  return {
    items: value.items.map(parseAlertItem),
    total: value.total,
    page: value.page as number,
    pageSize: value.pageSize as number,
  };
}

export function parseAlertSummaryPayload(value: unknown): AlertSummary {
  if (!isRecord(value) || !isCount(value.total) || !isCount(value.active)
    || !isCount(value.acknowledged) || !isCount(value.resolved) || !isCount(value.criticalActive)) {
    throw invalidResponse();
  }
  return {
    total: value.total,
    active: value.active,
    acknowledged: value.acknowledged,
    resolved: value.resolved,
    criticalActive: value.criticalActive,
  };
}

function assertListQuery(query: AlertListQuery): void {
  if (!UUID_PATTERN.test(query.projectId) || !ENVIRONMENTS.has(query.environment)
    || !(query.state === 'all' || ALERT_STATES.has(query.state))
    || !(query.level === 'all' || ALERT_LEVELS.has(query.level))
    || !Number.isSafeInteger(query.page) || query.page < 1 || query.page > 1000
    || !Number.isSafeInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 100
    || (query.page - 1) * query.pageSize > 10_000) {
    throw new TypeError('Invalid alert filters');
  }
}

function statusMessage(status: number): string {
  if (status === 401) return '未授权（401）：请检查本地 Vite 服务端的 PLATFORM_ADMIN_TOKEN 配置；令牌不会保存在浏览器。';
  if (status === 403) return '当前凭证无权访问该项目的告警数据（403）。';
  if (status === 404) return '告警接口暂不可用（404），请确认后端服务及当前项目。';
  if (status >= 500) return `告警服务暂时不可用（HTTP ${status}），请稍后重试。`;
  return `告警请求失败（HTTP ${status}）。`;
}

function networkMessage(): string {
  return '无法连接告警 API 服务，请确认本地 API 已启动后重试。';
}

async function requestJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await apiFetch(path, { signal });
  } catch {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    throw new AlertApiError(networkMessage());
  }
  if (!response.ok) throw new AlertApiError(statusMessage(response.status), response.status);
  try {
    return await response.json() as unknown;
  } catch {
    throw invalidResponse();
  }
}

export async function fetchAlerts(query: AlertListQuery, signal?: AbortSignal): Promise<AlertListResponse> {
  assertListQuery(query);
  const params = new URLSearchParams({
    projectId: query.projectId,
    environment: query.environment,
    state: query.state,
    level: query.level,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return parseAlertListPayload(await requestJson(`/api/v1/alerts?${params.toString()}`, signal), query);
}

export async function fetchAlertSummary(projectId: string, environment: OverviewEnvironment, signal?: AbortSignal): Promise<AlertSummary> {
  if (!UUID_PATTERN.test(projectId) || !ENVIRONMENTS.has(environment)) throw new TypeError('Invalid alert summary filters');
  const params = new URLSearchParams({ projectId, environment });
  return parseAlertSummaryPayload(await requestJson(`/api/v1/alerts/summary?${params.toString()}`, signal));
}

export async function updateAlertState(id: string, state: AlertState, signal?: AbortSignal): Promise<void> {
  if (!UUID_PATTERN.test(id) || !ALERT_STATES.has(state)) throw new TypeError('Invalid alert state update');
  let response: Response;
  try {
    response = await apiFetch(`/api/v1/alerts/${encodeURIComponent(id)}/state`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state }),
      signal,
    });
  } catch {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    throw new AlertApiError(networkMessage());
  }
  if (!response.ok) throw new AlertApiError(statusMessage(response.status), response.status);
}
