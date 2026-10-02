import { BadRequestException } from '@nestjs/common';
import { OVERVIEW_RANGES, parseOverviewQuery } from '../overview/overview-query';

export function parseMetricsQuery(raw: unknown, nowMs = Date.now()) {
  const invalid = (): never => { throw new BadRequestException('Invalid metrics query'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const query = raw as Record<string, unknown>;
  if (Object.keys(query).some(key => !['projectId', 'environment', 'range', 'service', 'from', 'to', 'groupBy'].includes(key))) return invalid();
  if (query.groupBy !== undefined && query.groupBy !== 'service') return invalid();
  const service = query.service === undefined ? '' : query.service;
  if (typeof service !== 'string' || service.length > 120 || /[\u0000-\u001f\u007f]/.test(service)
    || (service !== '' && service.trim() !== service)) return invalid();
  let scope;
  try { scope = parseOverviewQuery({ projectId: query.projectId, environment: query.environment, range: query.range }); }
  catch { return invalid(); }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return invalid();
  const definition = OVERVIEW_RANGES[scope.range];
  let fromMs = nowMs - definition.durationMs, toMs = nowMs;
  let range: typeof scope.range | 'custom' = scope.range;
  let bucketMs: number = definition.bucketMs;
  let bucketInterval: string = definition.bucketInterval;
  if (query.from !== undefined || query.to !== undefined) {
    if (query.range !== undefined) return invalid();
    const timestamp = (value: unknown): number => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return invalid();
      const parsed = Date.parse(value);
      if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== (value.length === 20 ? value.replace('Z', '.000Z') : value)) return invalid();
      return parsed;
    };
    fromMs = timestamp(query.from); toMs = timestamp(query.to);
    const duration = toMs - fromMs;
    if (duration <= 0 || duration > 30 * 24 * 3600000) return invalid();
    range = 'custom';
    if (duration <= OVERVIEW_RANGES['1h'].durationMs) { bucketMs = 60000; bucketInterval = 'INTERVAL 1 MINUTE'; }
    else if (duration <= OVERVIEW_RANGES['24h'].durationMs) { bucketMs = 900000; bucketInterval = 'INTERVAL 15 MINUTE'; }
    else if (duration <= OVERVIEW_RANGES['7d'].durationMs) { bucketMs = 3600000; bucketInterval = 'INTERVAL 1 HOUR'; }
    else { bucketMs = 21600000; bucketInterval = 'INTERVAL 6 HOUR'; }
  }
  return { ...scope, range, service, fromMs, toMs, bucketMs, bucketInterval,
    ...(query.groupBy === 'service' ? { groupBy: 'service' as const } : {}) };
}

export type MetricsQuery = ReturnType<typeof parseMetricsQuery>;
