import { BadRequestException } from '@nestjs/common';

export type AlertChannelType = 'webhook' | 'email';
export type AlertChannelEnvironment = 'all' | 'dev' | 'staging' | 'prod';
export type AlertChannelLevel = 'info' | 'warning' | 'critical';
export type AlertDeliveryStatus = 'queued' | 'sending' | 'retrying' | 'sent' | 'failed' | 'canceled';
export type AlertDeliveryStatusFilter = AlertDeliveryStatus | 'all';

export interface AlertChannelInput {
  projectId: string;
  name: string;
  type: AlertChannelType;
  environment: AlertChannelEnvironment;
  minLevel: AlertChannelLevel;
  enabled: boolean;
  webhookUrl?: string;
  recipient?: string;
}

export interface AlertChannelPatch {
  projectId: string;
  name?: string;
  environment?: AlertChannelEnvironment;
  minLevel?: AlertChannelLevel;
  enabled?: boolean;
  webhookUrl?: string;
  recipient?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_TYPES = new Set<AlertChannelType>(['webhook', 'email']);
const ENVIRONMENTS = new Set<AlertChannelEnvironment>(['all', 'dev', 'staging', 'prod']);
const LEVELS = new Set<AlertChannelLevel>(['info', 'warning', 'critical']);
const DELIVERY_STATUSES = new Set<AlertDeliveryStatusFilter>([
  'all', 'queued', 'sending', 'retrying', 'sent', 'failed', 'canceled',
]);

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

function validText(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function validEmail(value: unknown): value is string {
  if (!validText(value, 254) || /\s/.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2 || parts[0]!.length > 64) return false;
  const [local, domain] = parts as [string, string];
  return local.length > 0 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..')
    && domain.length > 0 && domain.length <= 253 && domain.includes('.')
    && domain.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function validWebhookUrl(value: unknown, allowPrivateTargets: boolean): value is string {
  if (!validText(value, 2048)) return false;
  try {
    const url = new URL(value);
    const permittedProtocol = url.protocol === 'https:' || (allowPrivateTargets && url.protocol === 'http:');
    return permittedProtocol && url.hostname.length > 0 && !url.username && !url.password
      && !url.hash && url.port.length <= 5;
  } catch {
    return false;
  }
}

function projectId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function parseProjectQuery(value: unknown): string {
  if (!record(value) || !exactKeys(value, ['projectId'], ['projectId']) || !projectId(value.projectId)) {
    throw new BadRequestException('Invalid project filter');
  }
  return value.projectId;
}

export function parseCreateAlertChannel(value: unknown, allowPrivateTargets: boolean): AlertChannelInput {
  const keys = ['projectId', 'name', 'type', 'environment', 'minLevel', 'enabled', 'webhookUrl', 'recipient'];
  if (!record(value) || !exactKeys(value, keys, ['projectId', 'name', 'type', 'environment', 'minLevel', 'enabled'])
    || !projectId(value.projectId) || !validText(value.name, 120)
    || typeof value.type !== 'string' || !CHANNEL_TYPES.has(value.type as AlertChannelType)
    || typeof value.environment !== 'string' || !ENVIRONMENTS.has(value.environment as AlertChannelEnvironment)
    || typeof value.minLevel !== 'string' || !LEVELS.has(value.minLevel as AlertChannelLevel)
    || typeof value.enabled !== 'boolean') {
    throw new BadRequestException('Invalid alert channel');
  }
  if (value.type === 'webhook') {
    if (!Object.hasOwn(value, 'webhookUrl') || Object.hasOwn(value, 'recipient')
      || !validWebhookUrl(value.webhookUrl, allowPrivateTargets)) {
      throw new BadRequestException('Invalid alert channel');
    }
  } else if (!Object.hasOwn(value, 'recipient') || Object.hasOwn(value, 'webhookUrl') || !validEmail(value.recipient)) {
    throw new BadRequestException('Invalid alert channel');
  }
  return value as unknown as AlertChannelInput;
}

export function parsePatchAlertChannel(value: unknown, allowPrivateTargets: boolean): AlertChannelPatch {
  const keys = ['projectId', 'name', 'environment', 'minLevel', 'enabled', 'webhookUrl', 'recipient'];
  if (!record(value) || !exactKeys(value, keys, ['projectId']) || !projectId(value.projectId)
    || Object.keys(value).length < 2
    || (Object.hasOwn(value, 'name') && !validText(value.name, 120))
    || (Object.hasOwn(value, 'environment') && (typeof value.environment !== 'string' || !ENVIRONMENTS.has(value.environment as AlertChannelEnvironment)))
    || (Object.hasOwn(value, 'minLevel') && (typeof value.minLevel !== 'string' || !LEVELS.has(value.minLevel as AlertChannelLevel)))
    || (Object.hasOwn(value, 'enabled') && typeof value.enabled !== 'boolean')
    || (Object.hasOwn(value, 'webhookUrl') && !validWebhookUrl(value.webhookUrl, allowPrivateTargets))
    || (Object.hasOwn(value, 'recipient') && !validEmail(value.recipient))
    || (Object.hasOwn(value, 'webhookUrl') && Object.hasOwn(value, 'recipient'))) {
    throw new BadRequestException('Invalid alert channel update');
  }
  return value as unknown as AlertChannelPatch;
}

export function parseDeliveryListQuery(value: unknown): {
  projectId: string;
  status: AlertDeliveryStatusFilter;
  page: number;
  pageSize: number;
  offset: number;
} {
  const keys = ['projectId', 'status', 'page', 'pageSize'];
  if (!record(value) || !exactKeys(value, keys, ['projectId']) || !projectId(value.projectId)) {
    throw new BadRequestException('Invalid delivery query');
  }
  const status = value.status ?? 'all';
  const pageText = value.page ?? '1';
  const pageSizeText = value.pageSize ?? '20';
  if (typeof status !== 'string' || !DELIVERY_STATUSES.has(status as AlertDeliveryStatusFilter)
    || typeof pageText !== 'string' || !/^[1-9]\d{0,5}$/.test(pageText)
    || typeof pageSizeText !== 'string' || !/^[1-9]\d{0,2}$/.test(pageSizeText)) {
    throw new BadRequestException('Invalid delivery query');
  }
  const page = Number(pageText);
  const pageSize = Number(pageSizeText);
  const offset = (page - 1) * pageSize;
  if (page > 1000 || pageSize > 100 || offset > 10_000) throw new BadRequestException('Invalid delivery query');
  return { projectId: value.projectId, status: status as AlertDeliveryStatusFilter, page, pageSize, offset };
}

export function parseId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new BadRequestException('Invalid resource ID');
  return value;
}

export function parseProjectAction(value: unknown): string {
  if (!record(value) || !exactKeys(value, ['projectId'], ['projectId']) || !projectId(value.projectId)) {
    throw new BadRequestException('Invalid project scope');
  }
  return value.projectId;
}
