import { apiFetch } from './api';
import type { ProtocolEnvironment } from './api';

export type OverviewEnvironment = ProtocolEnvironment | 'all';
export type OverviewRange = '1h' | '24h' | '7d';

export interface ProjectOption {
  id: string;
  name: string;
  slug: string;
}

export interface OverviewMetrics {
  requestCount: number;
  errorCount: number;
  errorRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  totalTokens: number;
}

export interface OverviewSeriesPoint {
  bucketStart: string;
  requestCount: number;
  errorCount: number;
  errorRate: number;
  totalTokens: number;
}

export interface OverviewService {
  name: string;
  requestCount: number;
  errorCount: number;
  errorRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  lastSeenAt: string | null;
  status: 'healthy' | 'degraded' | 'no_data';
}

export interface OverviewRecentError {
  traceId: string;
  environment: Exclude<OverviewEnvironment, 'all'>;
  service: string;
  operation: string;
  startTime: string;
  durationMs: number;
}

export interface OverviewModel {
  model: string;
  callCount: number;
  totalTokens: number;
  p95LatencyMs: number;
}

export interface OverviewResponse {
  generatedAt: string;
  range: { key: OverviewRange; from: string; to: string };
  metrics: OverviewMetrics;
  series: OverviewSeriesPoint[];
  services: OverviewService[];
  recentErrors: OverviewRecentError[];
  topModels: OverviewModel[];
}

export interface OverviewQuery {
  projectId: string;
  environment: OverviewEnvironment;
  range: OverviewRange;
}

export class OverviewApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'OverviewApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSafeModel(value: unknown): value is string {
  return value === '(unknown)' || (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(value));
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRange(value: unknown): value is OverviewRange {
  return value === '1h' || value === '24h' || value === '7d';
}

function isEnvironment(value: unknown): value is OverviewEnvironment {
  return value === 'dev' || value === 'staging' || value === 'prod' || value === 'all';
}

function invalidPayload(): OverviewApiError {
  return new OverviewApiError('接口响应格式与约定不一致，请联系后端确认。');
}

export function parseProjectsPayload(value: unknown): ProjectOption[] {
  if (!Array.isArray(value)) throw invalidPayload();

  return value.map((item) => {
    if (!isRecord(item) || !isText(item.id) || !isText(item.name) || !isText(item.slug)) {
      throw invalidPayload();
    }
    return { id: item.id, name: item.name, slug: item.slug };
  });
}

export function parseOverviewPayload(value: unknown, expectedRange?: OverviewRange): OverviewResponse {
  if (!isRecord(value) || !isTimestamp(value.generatedAt) || !isRecord(value.range) || !isRange(value.range.key)
    || !isTimestamp(value.range.from) || !isTimestamp(value.range.to)
    || (expectedRange !== undefined && value.range.key !== expectedRange)
    || !isRecord(value.metrics) || !isNonNegativeNumber(value.metrics.requestCount)
    || !Number.isSafeInteger(value.metrics.requestCount)
    || !isNonNegativeNumber(value.metrics.errorCount) || !Number.isSafeInteger(value.metrics.errorCount)
    || value.metrics.errorCount > value.metrics.requestCount
    || !isNonNegativeNumber(value.metrics.errorRate) || value.metrics.errorRate > 1
    || !isNonNegativeNumber(value.metrics.p50LatencyMs) || !isNonNegativeNumber(value.metrics.p95LatencyMs)
    || !isNonNegativeNumber(value.metrics.p99LatencyMs) || !isNonNegativeNumber(value.metrics.totalTokens)
    || !Number.isSafeInteger(value.metrics.totalTokens)
    || !Array.isArray(value.series) || !Array.isArray(value.services)
    || !Array.isArray(value.recentErrors) || !Array.isArray(value.topModels)) {
    throw invalidPayload();
  }

  const series: OverviewSeriesPoint[] = value.series.map((point) => {
    if (!isRecord(point) || !isTimestamp(point.bucketStart) || !isNonNegativeNumber(point.requestCount)
      || !Number.isSafeInteger(point.requestCount) || !isNonNegativeNumber(point.errorCount)
      || !Number.isSafeInteger(point.errorCount) || point.errorCount > point.requestCount
      || !isNonNegativeNumber(point.errorRate) || point.errorRate > 1 || !isNonNegativeNumber(point.totalTokens)
      || !Number.isSafeInteger(point.totalTokens)) {
      throw invalidPayload();
    }
    return {
      bucketStart: point.bucketStart,
      requestCount: point.requestCount,
      errorCount: point.errorCount,
      errorRate: point.errorRate,
      totalTokens: point.totalTokens,
    };
  });

  const services: OverviewService[] = value.services.map((service) => {
    if (!isRecord(service) || !isText(service.name) || !isNonNegativeNumber(service.requestCount)
      || !Number.isSafeInteger(service.requestCount)
      || !isNonNegativeNumber(service.errorCount) || !Number.isSafeInteger(service.errorCount)
      || service.errorCount > service.requestCount
      || !isNonNegativeNumber(service.errorRate) || service.errorRate > 1
      || !isNonNegativeNumber(service.p50LatencyMs) || !isNonNegativeNumber(service.p95LatencyMs)
      || !isNonNegativeNumber(service.p99LatencyMs)
      || !(service.lastSeenAt === null || isTimestamp(service.lastSeenAt))
      || !(service.status === 'healthy' || service.status === 'degraded' || service.status === 'no_data')) {
      throw invalidPayload();
    }
    return {
      name: service.name,
      requestCount: service.requestCount,
      errorCount: service.errorCount,
      errorRate: service.errorRate,
      p50LatencyMs: service.p50LatencyMs,
      p95LatencyMs: service.p95LatencyMs,
      p99LatencyMs: service.p99LatencyMs,
      lastSeenAt: service.lastSeenAt,
      status: service.status,
    };
  });

  const recentErrors: OverviewRecentError[] = value.recentErrors.map((item) => {
    if (!isRecord(item) || typeof item.traceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.traceId)
      || !isEnvironment(item.environment) || item.environment === 'all'
      || !isText(item.service) || !isText(item.operation)
      || !isTimestamp(item.startTime) || !isNonNegativeNumber(item.durationMs)) {
      throw invalidPayload();
    }
    return {
      traceId: item.traceId,
      environment: item.environment,
      service: item.service,
      operation: item.operation,
      startTime: item.startTime,
      durationMs: item.durationMs,
    };
  });

  const topModels: OverviewModel[] = value.topModels.map((item) => {
    if (!isRecord(item) || !isSafeModel(item.model) || !isNonNegativeNumber(item.callCount)
      || !Number.isSafeInteger(item.callCount) || item.callCount === 0
      || !isNonNegativeNumber(item.totalTokens) || !Number.isSafeInteger(item.totalTokens)
      || !isNonNegativeNumber(item.p95LatencyMs)) {
      throw invalidPayload();
    }
    return {
      model: item.model,
      callCount: item.callCount,
      totalTokens: item.totalTokens,
      p95LatencyMs: item.p95LatencyMs,
    };
  });

  return {
    generatedAt: value.generatedAt,
    range: { key: value.range.key, from: value.range.from, to: value.range.to },
    metrics: {
      requestCount: value.metrics.requestCount,
      errorCount: value.metrics.errorCount,
      errorRate: value.metrics.errorRate,
      p50LatencyMs: value.metrics.p50LatencyMs,
      p95LatencyMs: value.metrics.p95LatencyMs,
      p99LatencyMs: value.metrics.p99LatencyMs,
      totalTokens: value.metrics.totalTokens,
    },
    series,
    services,
    recentErrors,
    topModels,
  };
}

function httpErrorMessage(status: number): string {
  if (status === 401) {
    return '未授权（401）：请检查本地 Vite 服务端的 PLATFORM_ADMIN_TOKEN 配置；令牌不会保存在浏览器。';
  }
  if (status === 403) return '当前凭证无权读取该项目数据（403）。';
  if (status === 404) return 'Metrics Overview 接口暂不可用（404），请确认后端已实现 /api/v1/metrics/overview。';
  if (status >= 500) return `服务暂时不可用（HTTP ${status}），请稍后重试。`;
  return `请求失败（HTTP ${status}）。`;
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await apiFetch(path, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new OverviewApiError('无法连接 API 服务，请确认本地后端正在运行。');
  }

  if (!response.ok) throw new OverviewApiError(httpErrorMessage(response.status), response.status);
  try {
    return await response.json() as unknown;
  } catch {
    throw new OverviewApiError('接口未返回有效 JSON 数据。', response.status);
  }
}

export async function fetchProjects(signal?: AbortSignal): Promise<ProjectOption[]> {
  return parseProjectsPayload(await getJson('/api/v1/projects', signal));
}

export async function fetchOverview(query: OverviewQuery, signal?: AbortSignal): Promise<OverviewResponse> {
  if (!isText(query.projectId) || !isEnvironment(query.environment) || !isRange(query.range)) {
    throw new TypeError('Invalid Overview query filters');
  }
  const params = new URLSearchParams({
    projectId: query.projectId,
    environment: query.environment,
    range: query.range,
  });
  return parseOverviewPayload(await getJson(`/api/v1/metrics/overview?${params.toString()}`, signal), query.range);
}

export function overviewErrorMessage(error: unknown): string {
  if (error instanceof OverviewApiError) return error.message;
  return '读取 Overview 数据失败，请稍后重试。';
}

export function hasOverviewData(data: OverviewResponse): boolean {
  return data.metrics.requestCount > 0
    || data.metrics.errorCount > 0
    || data.series.some((point) => point.requestCount > 0 || point.errorCount > 0)
    || data.services.some((service) => service.requestCount > 0 || service.status !== 'no_data')
    || data.topModels.length > 0
    || data.recentErrors.length > 0;
}
