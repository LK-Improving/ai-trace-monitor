import { BadRequestException } from '@nestjs/common';
import { parseProjectId } from '../projects/project.validation';

export const OVERVIEW_RANGES = {
  '1h': { durationMs: 60 * 60 * 1_000, bucketMs: 60 * 1_000, bucketInterval: 'INTERVAL 1 MINUTE' },
  '24h': { durationMs: 24 * 60 * 60 * 1_000, bucketMs: 15 * 60 * 1_000, bucketInterval: 'INTERVAL 15 MINUTE' },
  '7d': { durationMs: 7 * 24 * 60 * 60 * 1_000, bucketMs: 60 * 60 * 1_000, bucketInterval: 'INTERVAL 1 HOUR' },
} as const;

export type OverviewRangeKey = keyof typeof OVERVIEW_RANGES;
export type OverviewEnvironment = 'dev' | 'staging' | 'prod' | 'all';

export interface OverviewQuery {
  projectId: string;
  environment: OverviewEnvironment;
  range: OverviewRangeKey;
}

const allowedEnvironments: readonly OverviewEnvironment[] = ['dev', 'staging', 'prod', 'all'];
const allowedRangeKeys = Object.keys(OVERVIEW_RANGES) as OverviewRangeKey[];

function badRequest(): never {
  throw new BadRequestException('Invalid overview query');
}

export function parseOverviewQuery(value: unknown): OverviewQuery {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return badRequest();
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some((key) => !['projectId', 'environment', 'range'].includes(key))) return badRequest();
  if (typeof query.projectId !== 'string') return badRequest();

  let projectId: string;
  try {
    projectId = parseProjectId(query.projectId).toLowerCase();
  } catch {
    return badRequest();
  }

  const environment = query.environment === undefined ? 'all' : query.environment;
  const range = query.range === undefined ? '24h' : query.range;
  if (typeof environment !== 'string' || !allowedEnvironments.includes(environment as OverviewEnvironment)) return badRequest();
  if (typeof range !== 'string' || !allowedRangeKeys.includes(range as OverviewRangeKey)) return badRequest();

  return {
    projectId,
    environment: environment as OverviewEnvironment,
    range: range as OverviewRangeKey,
  };
}
