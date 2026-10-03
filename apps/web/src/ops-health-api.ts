export type OpsHealthStatus = 'healthy' | 'degraded' | 'unavailable';
export type OpsRuntimeStatus = 'running' | 'degraded' | 'unavailable';
export type OpsProducerState = 'idle' | 'connecting' | 'ready' | 'unavailable' | 'closing' | 'closed';

export interface OpsHealthResponse {
  status: OpsHealthStatus;
  checkedAt: string;
  processUptimeSeconds: number;
  postgres: {
    status: 'healthy' | 'unavailable';
    latencyMs: number | null;
  };
  kafka: {
    status: OpsHealthStatus;
    topic: string;
    consumerGroup: string;
    totalLag: number | null;
    partitions: Array<{ partition: number; lag: number | null }>;
  };
  collector: {
    status: OpsRuntimeStatus;
    topic: string;
    consumerGroup: string;
    uptimeSeconds: number | null;
    processedMessages: number | null;
    insertedSpans: number | null;
    invalidMessages: number | null;
    failedBatches: number | null;
    clickhouseWriteFailures: number | null;
    committedBatches: number | null;
    lastCommitAt: string | null;
    lastClickHouseWriteAt: string | null;
  };
  clickhouse: {
    status: 'healthy' | 'unavailable';
    pingLatencyMs: number | null;
    queryLatency: {
      windowSeconds: 300;
      sampleCount: number;
      errorCount: number;
      p50Ms: number | null;
      p95Ms: number | null;
      p99Ms: number | null;
    };
  };
  spanQueue: {
    producerState: OpsProducerState;
    depth: number;
    capacity: number;
    queueBytes: number | null;
    maxQueueBytes: number | null;
    accepted: number;
    published: number;
    dropped: number;
    publishErrors: number;
    retries: number;
  };
}

const rootKeys = [
  'status', 'checkedAt', 'processUptimeSeconds', 'postgres', 'kafka', 'collector', 'clickhouse', 'spanQueue',
];
const collectorCounterKeys = [
  'processedMessages', 'insertedSpans', 'invalidMessages', 'failedBatches', 'clickhouseWriteFailures', 'committedBatches',
] as const;
const safeIdentifierPattern = /^[A-Za-z0-9._-]{1,249}$/;
const isoTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

export class OpsHealthPayloadError extends Error {
  constructor() {
    super('Invalid platform operations health payload');
    this.name = 'OpsHealthPayloadError';
  }
}

export class OpsHealthHttpError extends Error {
  constructor(readonly statusCode: number) {
    super('Platform operations health request failed');
    this.name = 'OpsHealthHttpError';
  }
}

function invalidPayload(): never {
  throw new OpsHealthPayloadError();
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === 'string' && keys.includes(key));
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nullableMetric(value: unknown): number | null {
  if (value === null) return null;
  return finiteNonnegative(value) ? value : invalidPayload();
}

function nullableCounter(value: unknown): number | null {
  if (value === null) return null;
  return nonnegativeInteger(value) ? value : invalidPayload();
}

function requireCounter(value: unknown): number {
  return nonnegativeInteger(value) ? value : invalidPayload();
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = isoTimestampPattern.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z' && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false;
  return true;
}

function requireTimestamp(value: unknown): string {
  return validTimestamp(value) ? value : invalidPayload();
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null) return null;
  return validTimestamp(value) ? value : invalidPayload();
}

function requireIdentifier(value: unknown): string {
  return typeof value === 'string' && safeIdentifierPattern.test(value) ? value : invalidPayload();
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : invalidPayload();
}

function parsePartitions(value: unknown): Array<{ partition: number; lag: number | null }> {
  if (!Array.isArray(value)) return invalidPayload();
  return value.map((entry) => {
    if (!isExactRecord(entry, ['partition', 'lag']) || !nonnegativeInteger(entry.partition)) return invalidPayload();
    return { partition: entry.partition, lag: entry.lag === null ? null : nonnegativeInteger(entry.lag) ? entry.lag : invalidPayload() };
  });
}

/** Validate and copy the exact public health DTO; no unrecognized fields are retained. */
export function parseOpsHealthResponse(value: unknown): OpsHealthResponse {
  if (!isExactRecord(value, rootKeys)) return invalidPayload();
  const status = enumValue(value.status, ['healthy', 'degraded', 'unavailable'] as const);
  const checkedAt = requireTimestamp(value.checkedAt);
  if (!finiteNonnegative(value.processUptimeSeconds)) return invalidPayload();

  if (!isExactRecord(value.postgres, ['status', 'latencyMs'])) return invalidPayload();
  const postgres = {
    status: enumValue(value.postgres.status, ['healthy', 'unavailable'] as const),
    latencyMs: nullableMetric(value.postgres.latencyMs),
  };

  if (!isExactRecord(value.kafka, ['status', 'topic', 'consumerGroup', 'totalLag', 'partitions'])) return invalidPayload();
  const kafka = {
    status: enumValue(value.kafka.status, ['healthy', 'degraded', 'unavailable'] as const),
    topic: requireIdentifier(value.kafka.topic),
    consumerGroup: requireIdentifier(value.kafka.consumerGroup),
    totalLag: value.kafka.totalLag === null ? null : nonnegativeInteger(value.kafka.totalLag) ? value.kafka.totalLag : invalidPayload(),
    partitions: parsePartitions(value.kafka.partitions),
  };

  const collectorKeys = [
    'status', 'topic', 'consumerGroup', 'uptimeSeconds', ...collectorCounterKeys, 'lastCommitAt', 'lastClickHouseWriteAt',
  ];
  if (!isExactRecord(value.collector, collectorKeys)) return invalidPayload();
  const collector: OpsHealthResponse['collector'] = {
    status: enumValue(value.collector.status, ['running', 'degraded', 'unavailable'] as const),
    topic: requireIdentifier(value.collector.topic),
    consumerGroup: requireIdentifier(value.collector.consumerGroup),
    uptimeSeconds: nullableMetric(value.collector.uptimeSeconds),
    processedMessages: nullableCounter(value.collector.processedMessages),
    insertedSpans: nullableCounter(value.collector.insertedSpans),
    invalidMessages: nullableCounter(value.collector.invalidMessages),
    failedBatches: nullableCounter(value.collector.failedBatches),
    clickhouseWriteFailures: nullableCounter(value.collector.clickhouseWriteFailures),
    committedBatches: nullableCounter(value.collector.committedBatches),
    lastCommitAt: nullableTimestamp(value.collector.lastCommitAt),
    lastClickHouseWriteAt: nullableTimestamp(value.collector.lastClickHouseWriteAt),
  };

  if (!isExactRecord(value.clickhouse, ['status', 'pingLatencyMs', 'queryLatency'])) return invalidPayload();
  if (!isExactRecord(value.clickhouse.queryLatency, ['windowSeconds', 'sampleCount', 'errorCount', 'p50Ms', 'p95Ms', 'p99Ms'])) return invalidPayload();
  if (value.clickhouse.queryLatency.windowSeconds !== 300
    || !nonnegativeInteger(value.clickhouse.queryLatency.sampleCount)
    || !nonnegativeInteger(value.clickhouse.queryLatency.errorCount)) return invalidPayload();
  const clickhouse = {
    status: enumValue(value.clickhouse.status, ['healthy', 'unavailable'] as const),
    pingLatencyMs: nullableMetric(value.clickhouse.pingLatencyMs),
    queryLatency: {
      windowSeconds: 300 as const,
      sampleCount: value.clickhouse.queryLatency.sampleCount,
      errorCount: value.clickhouse.queryLatency.errorCount,
      p50Ms: nullableMetric(value.clickhouse.queryLatency.p50Ms),
      p95Ms: nullableMetric(value.clickhouse.queryLatency.p95Ms),
      p99Ms: nullableMetric(value.clickhouse.queryLatency.p99Ms),
    },
  };

  const spanQueueKeys = ['producerState', 'depth', 'capacity', 'accepted', 'published', 'dropped', 'publishErrors', 'retries'] as const;
  const spanQueueByteKeys = [...spanQueueKeys, 'queueBytes', 'maxQueueBytes'] as const;
  const rawSpanQueue = value.spanQueue;
  if (!isExactRecord(rawSpanQueue, spanQueueByteKeys) && !isExactRecord(rawSpanQueue, spanQueueKeys)) return invalidPayload();
  const spanQueueRecord = rawSpanQueue as Record<string, unknown>;
  const hasQueueByteMetrics = isExactRecord(spanQueueRecord, spanQueueByteKeys);
  const producerState = enumValue(spanQueueRecord.producerState, ['idle', 'connecting', 'ready', 'unavailable', 'closing', 'closed'] as const);
  const spanQueue = {
    depth: requireCounter(spanQueueRecord.depth),
    capacity: requireCounter(spanQueueRecord.capacity),
    queueBytes: hasQueueByteMetrics ? nullableCounter(spanQueueRecord.queueBytes) : null,
    maxQueueBytes: hasQueueByteMetrics ? nullableCounter(spanQueueRecord.maxQueueBytes) : null,
    accepted: requireCounter(spanQueueRecord.accepted),
    published: requireCounter(spanQueueRecord.published),
    dropped: requireCounter(spanQueueRecord.dropped),
    publishErrors: requireCounter(spanQueueRecord.publishErrors),
    retries: requireCounter(spanQueueRecord.retries),
  };

  return {
    status,
    checkedAt,
    processUptimeSeconds: value.processUptimeSeconds,
    postgres,
    kafka,
    collector,
    clickhouse,
    spanQueue: { producerState, ...spanQueue },
  };
}

export function opsHealthErrorMessage(error: unknown): string {
  if (error instanceof OpsHealthPayloadError) return '健康检查接口返回的数据格式不符合预期。';
  if (error instanceof OpsHealthHttpError) {
    if (error.statusCode === 401 || error.statusCode === 403) return '本地平台管理员查询未通过授权检查。';
    if (error.statusCode === 504) return '健康检查等待超时，将在稍后自动重试。';
    if (error.statusCode === 502 || error.statusCode >= 500) return '平台健康查询暂不可用，将在稍后自动重试。';
    return '平台健康查询请求未被接受，请重试。';
  }
  return '无法连接平台健康查询接口，请检查本地 API 服务后重试。';
}

export async function fetchOpsHealth(signal?: AbortSignal): Promise<OpsHealthResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 12_000);

  try {
    const response = await fetch('/api/v1/ops/health', {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new OpsHealthHttpError(response.status);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      if (timedOut) throw new OpsHealthHttpError(504);
      throw new OpsHealthPayloadError();
    }
    return parseOpsHealthResponse(payload);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timedOut) throw new OpsHealthHttpError(504);
    if (error instanceof OpsHealthHttpError || error instanceof OpsHealthPayloadError) throw error;
    throw new Error('Platform operations health request failed');
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
