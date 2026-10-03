import { apiFetch } from './api';
import type { OverviewEnvironment } from './overview-api';

export type AlertChannelType = 'webhook' | 'email';
export type AlertChannelEnvironment = OverviewEnvironment;
export type AlertChannelLevel = 'info' | 'warning' | 'critical';
export type AlertDeliveryStatus = 'queued' | 'sending' | 'retrying' | 'sent' | 'failed' | 'canceled';
export type AlertDeliveryStatusFilter = AlertDeliveryStatus | 'all';

export interface AlertChannel {
  id: string;
  projectId: string;
  name: string;
  type: AlertChannelType;
  environment: AlertChannelEnvironment;
  minLevel: AlertChannelLevel;
  enabled: boolean;
  destinationHint: string;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AlertChannelInputBase {
  projectId: string;
  name: string;
  environment: AlertChannelEnvironment;
  minLevel: AlertChannelLevel;
  enabled: boolean;
}

export type CreateAlertChannelInput = AlertChannelInputBase & (
  | { type: 'webhook'; webhookUrl: string }
  | { type: 'email'; recipient: string }
);

export interface PatchAlertChannelInput {
  projectId: string;
  name?: string;
  environment?: AlertChannelEnvironment;
  minLevel?: AlertChannelLevel;
  enabled?: boolean;
  webhookUrl?: string;
  recipient?: string;
}

export interface AlertDelivery {
  id: string;
  channelId: string;
  channelName: string;
  channelType: AlertChannelType;
  eventType: 'alert' | 'test';
  alertId: string | null;
  alertTitle: string | null;
  level: AlertChannelLevel | null;
  service: string | null;
  environment: Exclude<AlertChannelEnvironment, 'all'> | null;
  traceId: string | null;
  status: AlertDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
}

export interface AlertDeliveryQuery {
  projectId: string;
  status: AlertDeliveryStatusFilter;
  page: number;
  pageSize: number;
}

export interface AlertDeliveryListResponse {
  items: AlertDelivery[];
  total: number;
  page: number;
  pageSize: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENVIRONMENTS = new Set<AlertChannelEnvironment>(['all', 'dev', 'staging', 'prod']);
const LEVELS = new Set<AlertChannelLevel>(['info', 'warning', 'critical']);
const CHANNEL_TYPES = new Set<AlertChannelType>(['webhook', 'email']);
const DELIVERY_STATUSES = new Set<AlertDeliveryStatus>(['queued', 'sending', 'retrying', 'sent', 'failed', 'canceled']);
const PAGE_SIZE_LIMIT = 100;

export class AlertNotificationApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'AlertNotificationApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0)
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isNullableText(value: unknown, maximum: number): value is string | null {
  return value === null || isText(value, maximum, true);
}

function invalidResponse(): AlertNotificationApiError {
  return new AlertNotificationApiError('告警通知接口响应与约定不一致，请联系后端确认。');
}

function isValidWebhookUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.hostname.length > 0 && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function isValidRecipient(value: string): boolean {
  if (value.length > 254 || /\s/.test(value)) return false;
  const at = value.indexOf('@');
  return at > 0 && at === value.lastIndexOf('@') && at < value.length - 1
    && value.slice(at + 1).includes('.') && !value.slice(at + 1).startsWith('.')
    && !value.slice(at + 1).endsWith('.');
}

function assertProjectId(projectId: string): void {
  if (!UUID_PATTERN.test(projectId)) throw new TypeError('Invalid alert notification project');
}

function parseChannel(value: unknown, expectedProjectId: string): AlertChannel {
  if (!isRecord(value) || !UUID_PATTERN.test(String(value.id)) || value.projectId !== expectedProjectId
    || !isText(value.name, 120) || typeof value.type !== 'string' || !CHANNEL_TYPES.has(value.type as AlertChannelType)
    || typeof value.environment !== 'string' || !ENVIRONMENTS.has(value.environment as AlertChannelEnvironment)
    || typeof value.minLevel !== 'string' || !LEVELS.has(value.minLevel as AlertChannelLevel)
    || typeof value.enabled !== 'boolean' || !isText(value.destinationHint, 254, true)
    || typeof value.hasSecret !== 'boolean' || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)
    || 'webhookUrl' in value || 'recipient' in value || 'secret' in value || 'token' in value) {
    throw invalidResponse();
  }
  return {
    id: value.id as string,
    projectId: expectedProjectId,
    name: value.name,
    type: value.type as AlertChannelType,
    environment: value.environment as AlertChannelEnvironment,
    minLevel: value.minLevel as AlertChannelLevel,
    enabled: value.enabled,
    destinationHint: value.destinationHint,
    hasSecret: value.hasSecret,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function parseAlertChannelsPayload(value: unknown, projectId: string): AlertChannel[] {
  assertProjectId(projectId);
  if (!isRecord(value) || !Array.isArray(value.items)) throw invalidResponse();
  return value.items.map((item) => parseChannel(item, projectId));
}

function parseDelivery(value: unknown): AlertDelivery {
  if (!isRecord(value) || !UUID_PATTERN.test(String(value.id)) || !UUID_PATTERN.test(String(value.channelId))
    || !isText(value.channelName, 120) || typeof value.channelType !== 'string'
    || !CHANNEL_TYPES.has(value.channelType as AlertChannelType)
    || (value.eventType !== 'alert' && value.eventType !== 'test')
    || !(value.alertId === null || UUID_PATTERN.test(String(value.alertId)))
    || !isNullableText(value.alertTitle, 160)
    || !(value.level === null || (typeof value.level === 'string' && LEVELS.has(value.level as AlertChannelLevel)))
    || !isNullableText(value.service, 120)
    || !(value.environment === null || (typeof value.environment === 'string' && ['dev', 'staging', 'prod'].includes(value.environment)))
    || !isNullableText(value.traceId, 128)
    || typeof value.status !== 'string' || !DELIVERY_STATUSES.has(value.status as AlertDeliveryStatus)
    || !Number.isSafeInteger(value.attemptCount) || (value.attemptCount as number) < 0
    || !isNullableTimestamp(value.nextAttemptAt) || !isNullableTimestamp(value.lastAttemptAt)
    || !isNullableTimestamp(value.deliveredAt)
    || !(value.lastErrorCode === null || (typeof value.lastErrorCode === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value.lastErrorCode)))
    || !isTimestamp(value.createdAt)) {
    throw invalidResponse();
  }
  return {
    id: value.id as string,
    channelId: value.channelId as string,
    channelName: value.channelName,
    channelType: value.channelType as AlertChannelType,
    eventType: value.eventType,
    alertId: value.alertId as string | null,
    alertTitle: value.alertTitle,
    level: value.level as AlertChannelLevel | null,
    service: value.service,
    environment: value.environment as AlertDelivery['environment'],
    traceId: value.traceId,
    status: value.status as AlertDeliveryStatus,
    attemptCount: value.attemptCount as number,
    nextAttemptAt: value.nextAttemptAt as string | null,
    lastAttemptAt: value.lastAttemptAt as string | null,
    deliveredAt: value.deliveredAt as string | null,
    lastErrorCode: value.lastErrorCode as string | null,
    createdAt: value.createdAt,
  };
}

export function parseAlertDeliveriesPayload(value: unknown, expected: Pick<AlertDeliveryQuery, 'page' | 'pageSize'>): AlertDeliveryListResponse {
  if (!isRecord(value) || !Array.isArray(value.items) || !Number.isSafeInteger(value.total) || (value.total as number) < 0
    || value.page !== expected.page || value.pageSize !== expected.pageSize || value.items.length > expected.pageSize) {
    throw invalidResponse();
  }
  return {
    items: value.items.map(parseDelivery),
    total: value.total as number,
    page: expected.page,
    pageSize: expected.pageSize,
  };
}

function statusMessage(status: number): string {
  if (status === 401) return '未授权（401）：请检查本地服务端 PLATFORM_ADMIN_TOKEN 配置；令牌不会发送到浏览器以外的 API。';
  if (status === 403) return '当前凭证无权管理该项目的告警通知（403）。';
  if (status === 404) return '告警通知接口暂不可用（404），请确认后端已提供对应接口。';
  if (status >= 500) return `告警通知服务暂时不可用（HTTP ${status}），请稍后重试。`;
  return `告警通知请求失败（HTTP ${status}）。`;
}

async function requestJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await apiFetch(path, { signal });
  } catch {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    throw new AlertNotificationApiError('无法连接告警通知 API 服务，请确认本地 API 已启动后重试。');
  }
  if (!response.ok) throw new AlertNotificationApiError(statusMessage(response.status), response.status);
  try {
    return await response.json() as unknown;
  } catch {
    throw invalidResponse();
  }
}

async function mutate(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await apiFetch(path, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      signal,
    });
  } catch {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    throw new AlertNotificationApiError('无法连接告警通知 API 服务，请确认本地 API 已启动后重试。');
  }
  if (!response.ok) throw new AlertNotificationApiError(statusMessage(response.status), response.status);
}

function assertChannelBase(input: AlertChannelInputBase): void {
  assertProjectId(input.projectId);
  if (typeof input.name !== 'string' || input.name.trim() !== input.name || input.name.length < 1 || input.name.length > 120
    || !ENVIRONMENTS.has(input.environment) || !LEVELS.has(input.minLevel) || typeof input.enabled !== 'boolean') {
    throw new TypeError('Invalid alert channel fields');
  }
}

function assertDestination(type: AlertChannelType, destination: string): void {
  if (type === 'webhook' ? (!isText(destination, 2048) || !isValidWebhookUrl(destination))
    : (!isText(destination, 254) || !isValidRecipient(destination))) {
    throw new TypeError('Invalid alert channel destination');
  }
}

export async function fetchAlertChannels(projectId: string, signal?: AbortSignal): Promise<AlertChannel[]> {
  assertProjectId(projectId);
  const params = new URLSearchParams({ projectId });
  return parseAlertChannelsPayload(await requestJson(`/api/v1/alerts/channels?${params}`, signal), projectId);
}

export async function createAlertChannel(input: CreateAlertChannelInput, signal?: AbortSignal): Promise<void> {
  assertChannelBase(input);
  if (!CHANNEL_TYPES.has(input.type)) throw new TypeError('Invalid alert channel type');
  const destination = input.type === 'webhook' ? input.webhookUrl : input.recipient;
  assertDestination(input.type, destination);
  await mutate('/api/v1/alerts/channels', 'POST', { ...input }, signal);
}

export async function patchAlertChannel(id: string, input: PatchAlertChannelInput, signal?: AbortSignal): Promise<void> {
  if (!UUID_PATTERN.test(id)) throw new TypeError('Invalid alert channel id');
  assertProjectId(input.projectId);
  const { projectId, ...fields } = input;
  if (Object.keys(fields).length === 0
    || (input.name !== undefined && (input.name.trim() !== input.name || input.name.length < 1 || input.name.length > 120))
    || (input.environment !== undefined && !ENVIRONMENTS.has(input.environment))
    || (input.minLevel !== undefined && !LEVELS.has(input.minLevel))
    || (input.enabled !== undefined && typeof input.enabled !== 'boolean')
    || (input.webhookUrl !== undefined && !isValidWebhookUrl(input.webhookUrl))
    || (input.recipient !== undefined && !isValidRecipient(input.recipient))
    || (input.webhookUrl !== undefined && input.recipient !== undefined)) {
    throw new TypeError('Invalid alert channel patch');
  }
  await mutate(`/api/v1/alerts/channels/${encodeURIComponent(id)}`, 'PATCH', input, signal);
}

export async function deleteAlertChannel(id: string, projectId: string, signal?: AbortSignal): Promise<void> {
  if (!UUID_PATTERN.test(id)) throw new TypeError('Invalid alert channel id');
  assertProjectId(projectId);
  const params = new URLSearchParams({ projectId });
  await mutate(`/api/v1/alerts/channels/${encodeURIComponent(id)}?${params}`, 'DELETE', undefined, signal);
}

export async function testAlertChannel(id: string, projectId: string, signal?: AbortSignal): Promise<void> {
  if (!UUID_PATTERN.test(id)) throw new TypeError('Invalid alert channel id');
  assertProjectId(projectId);
  await mutate(`/api/v1/alerts/channels/${encodeURIComponent(id)}/test`, 'POST', { projectId }, signal);
}

export async function fetchAlertDeliveries(query: AlertDeliveryQuery, signal?: AbortSignal): Promise<AlertDeliveryListResponse> {
  assertProjectId(query.projectId);
  if (!(query.status === 'all' || DELIVERY_STATUSES.has(query.status))
    || !Number.isSafeInteger(query.page) || query.page < 1 || query.page > 1000
    || !Number.isSafeInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > PAGE_SIZE_LIMIT
    || (query.page - 1) * query.pageSize > 10_000) {
    throw new TypeError('Invalid alert delivery filters');
  }
  const params = new URLSearchParams({
    projectId: query.projectId,
    status: query.status,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return parseAlertDeliveriesPayload(await requestJson(`/api/v1/alerts/deliveries?${params}`, signal), query);
}

export async function retryAlertDelivery(id: string, projectId: string, signal?: AbortSignal): Promise<void> {
  if (!UUID_PATTERN.test(id)) throw new TypeError('Invalid alert delivery id');
  assertProjectId(projectId);
  await mutate(`/api/v1/alerts/deliveries/${encodeURIComponent(id)}/retry`, 'POST', { projectId }, signal);
}
