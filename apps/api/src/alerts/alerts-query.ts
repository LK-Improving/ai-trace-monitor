import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

export const ALERT_ENVIRONMENTS = ['dev', 'staging', 'prod', 'all'] as const;
export const ALERT_STATES = ['active', 'acknowledged', 'resolved', 'all'] as const;
export const ALERT_LEVELS = ['info', 'warning', 'critical', 'all'] as const;
export const ALERT_MUTABLE_STATES = ['active', 'acknowledged', 'resolved'] as const;

export type AlertEnvironment = (typeof ALERT_ENVIRONMENTS)[number];
export type AlertStateFilter = (typeof ALERT_STATES)[number];
export type AlertLevelFilter = (typeof ALERT_LEVELS)[number];
export type AlertState = (typeof ALERT_MUTABLE_STATES)[number];

const projectIdSchema = z.string().uuid();

function asQueryRecord(raw: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('Invalid alerts query');
  }
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    throw new BadRequestException('Invalid alerts query');
  }
  return record;
}

function parseProjectId(value: unknown): string {
  const parsed = projectIdSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid alerts query');
  return parsed.data.toLowerCase();
}

function parseEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== 'string' || !allowed.includes(candidate)) {
    throw new BadRequestException('Invalid alerts query');
  }
  return candidate;
}

function parsePositiveInteger(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new BadRequestException('Invalid alerts query');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new BadRequestException('Invalid alerts query');
  }
  return parsed;
}

function parseWindow(query: Record<string, unknown>): { from?: string; to?: string } {
  if (query.from === undefined && query.to === undefined) return {};
  if (typeof query.from !== 'string' || typeof query.to !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(query.from)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(query.to)) {
    throw new BadRequestException('Invalid alerts query');
  }
  const from = Date.parse(query.from);
  const to = Date.parse(query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)
    || new Date(from).toISOString() !== query.from || new Date(to).toISOString() !== query.to
    || from >= to || to - from > 30 * 24 * 60 * 60 * 1000) {
    throw new BadRequestException('Invalid alerts query');
  }
  return { from: query.from, to: query.to };
}

export function parseAlertsListQuery(raw: unknown) {
  const query = asQueryRecord(raw, ['projectId', 'environment', 'state', 'level', 'page', 'pageSize', 'from', 'to']);
  const page = parsePositiveInteger(query.page, 1, 1_000_000);
  const pageSize = parsePositiveInteger(query.pageSize, 20, 100);
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset) || offset > 1_000_000) {
    throw new BadRequestException('Invalid alerts query');
  }

  return {
    projectId: parseProjectId(query.projectId),
    environment: parseEnum(query.environment, ALERT_ENVIRONMENTS, 'all'),
    state: parseEnum(query.state, ALERT_STATES, 'all'),
    level: parseEnum(query.level, ALERT_LEVELS, 'all'),
    page,
    pageSize,
    offset,
    ...parseWindow(query),
  };
}

export function parseAlertsSummaryQuery(raw: unknown) {
  const query = asQueryRecord(raw, ['projectId', 'environment', 'from', 'to']);
  return {
    projectId: parseProjectId(query.projectId),
    environment: parseEnum(query.environment, ALERT_ENVIRONMENTS, 'all'),
    ...parseWindow(query),
  };
}

export function parseAlertId(raw: unknown): string {
  const parsed = projectIdSchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException('Invalid alert id');
  return parsed.data.toLowerCase();
}

export function parseAlertState(raw: unknown): AlertState {
  if (
    raw === null
    || typeof raw !== 'object'
    || Array.isArray(raw)
    || Object.keys(raw).some((key) => key !== 'state')
  ) {
    throw new BadRequestException('Invalid alert state');
  }
  const state = (raw as Record<string, unknown>).state;
  if (typeof state !== 'string' || !ALERT_MUTABLE_STATES.includes(state as AlertState)) {
    throw new BadRequestException('Invalid alert state');
  }
  return state as AlertState;
}
