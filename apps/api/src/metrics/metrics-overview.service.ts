import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EnvironmentSchema, TraceIdSchema } from '@trace-ops/contracts';
import { DatabaseService } from '../database/database.service';
import {
  ClickHouseQueryParams,
  ClickHouseService,
} from '../overview/clickhouse.service';
import { OVERVIEW_RANGES } from '../overview/overview-query';
import { metricsSpansSql, REQUEST_ROOT } from './metrics-sql';
import { MetricsQuery, parseMetricsQuery } from './metrics-query';

const ANALYTICS_UNAVAILABLE = 'Analytics data is unavailable';
const DEGRADED_ERROR_RATE = 0.01;
const MAX_RESULT_ROWS = 2_000;
const MAX_TOP_MODELS = 100;
const MAX_RECENT_ERRORS = 20;
const SAFE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const SAFE_MODEL_PATTERN_SQL = '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$';

interface MetricRow extends Record<string, unknown> {
  request_count: unknown;
  error_count: unknown;
  latency_quantiles: unknown;
  total_tokens: unknown;
}

interface SeriesRow extends Record<string, unknown> {
  bucket_start: unknown;
  service?: unknown;
  request_count: unknown;
  error_count: unknown;
  total_tokens: unknown;
}

interface ServiceRow extends Record<string, unknown> {
  name: unknown;
  request_count: unknown;
  error_count: unknown;
  latency_quantiles: unknown;
  last_seen_at: unknown;
}

interface RecentErrorRow extends Record<string, unknown> {
  trace_id: unknown;
  environment: unknown;
  service: unknown;
  operation: unknown;
  start_time: unknown;
  duration_ms: unknown;
}

interface TopModelRow extends Record<string, unknown> {
  model: unknown;
  call_count: unknown;
  total_tokens: unknown;
  latency_quantiles: unknown;
}

interface TraceRows {
  metrics: MetricRow[];
  series: SeriesRow[];
  services: ServiceRow[];
  recentErrors: RecentErrorRow[];
  topModels: TopModelRow[];
}

// One row per deduplicated trace. Root tests decide whether it is a request;
// errors inspect every span, and LLM tokens include selected rootless traces.
// A service filter is applied here after raw deduplication, so matching a
// service selects the whole trace instead of dropping its other spans.
const TRACE_ROWS_SQL = `trace_rows AS (
  SELECT
    project_id,
    environment,
    trace_id,
    countIf(${REQUEST_ROOT}) AS request_root_count,
    countIf(status = 'error') AS error_span_count,
    dateDiff('millisecond', min(start_time), max(end_time)) AS duration_ms,
    sumIf(total_tokens, operation = 'llm.generate') AS token_total,
    min(start_time) AS started_at,
    argMinIf(service, tuple(start_time, span_id, service), ${REQUEST_ROOT}) AS root_service,
    argMinIf(operation, tuple(start_time, span_id, operation), ${REQUEST_ROOT}) AS root_operation,
    if(
      countIf(${REQUEST_ROOT}) > 0,
      argMinIf(service, tuple(start_time, span_id, service), ${REQUEST_ROOT}),
      argMin(service, tuple(start_time, span_id, service))
    ) AS series_service
  FROM normalized_spans
  GROUP BY project_id, environment, trace_id
  HAVING {service:String} = '' OR countIf(service = {service:String}) > 0
)`;

function boundedBucket(query: MetricsQuery): { bucketMs: number; bucketInterval: string } {
  const knownBuckets = new Map<number, string>(
    Object.values(OVERVIEW_RANGES).map(({ bucketMs, bucketInterval }) => [bucketMs, bucketInterval]),
  );
  // Custom windows longer than seven days use six-hour buckets.
  knownBuckets.set(6 * 60 * 60 * 1_000, 'INTERVAL 6 HOUR');
  const interval = knownBuckets.get(query.bucketMs);
  if (!interval || interval !== query.bucketInterval) {
    throw new Error('Invalid analytics range');
  }
  return { bucketMs: query.bucketMs, bucketInterval: interval };
}

function parseNumber(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error('Invalid analytics result');
  return parsed;
}

function safeInteger(value: unknown): number {
  const parsed = parseNumber(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Invalid analytics result');
  }
  return parsed;
}

function nonNegativeNumber(value: unknown): number {
  const parsed = parseNumber(value);
  if (parsed < 0) throw new Error('Invalid analytics result');
  return parsed;
}

function safeString(value: unknown, maxLength: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('Invalid analytics result');
  }
  return value;
}

function isoTimestamp(value: unknown): string {
  let parsed: Date;
  if (value instanceof Date) {
    parsed = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    parsed = new Date(value);
  } else if (typeof value === 'string' && value.length > 0) {
    const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
      ? value
      : `${value.replace(' ', 'T')}Z`;
    parsed = new Date(normalized);
  } else {
    throw new Error('Invalid analytics result');
  }
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid analytics result');
  return parsed.toISOString();
}

function quantiles(value: unknown, expectedLength: number): number[] {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new Error('Invalid analytics result');
  }
  return value.map(nonNegativeNumber);
}

function checkedRows<T>(value: unknown, maxLength: number): T[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new Error('Invalid analytics result');
  }
  return value as T[];
}

function errorRate(requestCount: number, errorCount: number): number {
  if (errorCount > requestCount) throw new Error('Invalid analytics result');
  const rate = requestCount === 0 ? 0 : errorCount / requestCount;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error('Invalid analytics result');
  }
  return rate;
}

function isGroupedByService(query: MetricsQuery): boolean {
  return query.groupBy === 'service';
}

function queryParams(query: MetricsQuery): ClickHouseQueryParams {
  return {
    projectId: query.projectId,
    environment: query.environment,
    fromMs: query.fromMs,
    toMs: query.toMs,
    service: query.service,
  };
}

function metricsSql(): string {
  return `${metricsSpansSql()}, ${TRACE_ROWS_SQL},
    request_metrics AS (
      SELECT
        count() AS request_count,
        countIf(error_span_count > 0) AS error_count,
        if(count() = 0, [0., 0., 0.], quantilesExact(0.5, 0.95, 0.99)(duration_ms)) AS latency_quantiles
      FROM trace_rows
      WHERE request_root_count > 0
    ),
    token_metrics AS (
      SELECT sum(token_total) AS total_tokens
      FROM trace_rows
    )
  SELECT request_count, error_count, latency_quantiles, total_tokens
  FROM request_metrics CROSS JOIN token_metrics`;
}

function seriesSql(query: MetricsQuery, bucketInterval: string): string {
  const groupByService = isGroupedByService(query);
  const serviceColumn = groupByService ? 'series_service AS service,' : '';
  const groupBy = groupByService ? 'bucket_start, service' : 'bucket_start';
  // Clamp trace start times to the requested half-open range. This retains the
  // legacy partial first/last buckets even when a span started outside it.
  const clippedStart = `least(
    greatest(started_at, fromUnixTimestamp64Milli({fromMs:Int64}, 'UTC')),
    fromUnixTimestamp64Milli({toMs:Int64}, 'UTC') - INTERVAL 1 MILLISECOND
  )`;
  return `${metricsSpansSql()}, ${TRACE_ROWS_SQL}
  SELECT
    toStartOfInterval(${clippedStart}, ${bucketInterval}, 'UTC') AS bucket_start,
    ${serviceColumn}
    countIf(request_root_count > 0) AS request_count,
    countIf(request_root_count > 0 AND error_span_count > 0) AS error_count,
    sum(token_total) AS total_tokens
  FROM trace_rows
  GROUP BY ${groupBy}
  ORDER BY bucket_start ASC${groupByService ? ', service ASC' : ''}
  LIMIT ${MAX_RESULT_ROWS + 1}`;
}

function servicesSql(): string {
  // Service health intentionally counts deduplicated spans, matching the
  // legacy service-health meaning; these are not request counts.
  return `${metricsSpansSql()}, ${TRACE_ROWS_SQL},
    selected_spans AS (
      SELECT normalized_spans.service, normalized_spans.status,
        normalized_spans.duration_ms, normalized_spans.event_time
      FROM normalized_spans
      INNER JOIN trace_rows USING (project_id, environment, trace_id)
    )
  SELECT
    service AS name,
    count() AS request_count,
    countIf(status = 'error') AS error_count,
    if(count() = 0, [0., 0., 0.], quantilesExact(0.5, 0.95, 0.99)(duration_ms)) AS latency_quantiles,
    max(event_time) AS last_seen_at
  FROM selected_spans
  GROUP BY service
  ORDER BY service ASC
  LIMIT ${MAX_RESULT_ROWS + 1}`;
}

function recentErrorsSql(): string {
  return `${metricsSpansSql()}, ${TRACE_ROWS_SQL}
  SELECT
    trace_id,
    environment,
    root_service AS service,
    root_operation AS operation,
    started_at AS start_time,
    duration_ms
  FROM trace_rows
  WHERE request_root_count > 0 AND error_span_count > 0
  ORDER BY started_at DESC, trace_id ASC, environment ASC
  LIMIT ${MAX_RECENT_ERRORS}`;
}

function topModelsSql(): string {
  return `${metricsSpansSql()}, ${TRACE_ROWS_SQL},
    model_spans AS (
      SELECT
        if(match(normalized_spans.model, '${SAFE_MODEL_PATTERN_SQL}'), normalized_spans.model, '(unknown)') AS safe_model,
        normalized_spans.total_tokens,
        normalized_spans.duration_ms
      FROM normalized_spans
      INNER JOIN trace_rows USING (project_id, environment, trace_id)
      WHERE normalized_spans.operation = 'llm.generate'
    )
  SELECT
    safe_model AS model,
    count() AS call_count,
    sum(total_tokens) AS total_tokens,
    quantilesExact(0.95)(duration_ms) AS latency_quantiles
  FROM model_spans
  GROUP BY safe_model
  ORDER BY call_count DESC, total_tokens DESC, safe_model ASC
  LIMIT ${MAX_TOP_MODELS + 1}`;
}

@Injectable()
export class MetricsOverviewService {
  private readonly now = () => new Date();

  constructor(
    private readonly database: DatabaseService,
    private readonly clickhouse: ClickHouseService,
  ) {}

  async getOverview(rawQuery: unknown) {
    const generatedAt = this.now();
    const query = parseMetricsQuery(rawQuery, generatedAt.getTime());

    let projectExists: boolean;
    try {
      const result = await this.database.query<{ id: string }>(
        'SELECT id FROM projects WHERE id = $1 LIMIT 1',
        [query.projectId],
      );
      if (
        !result
        || !Array.isArray(result.rows)
        || result.rows.length > 1
        || result.rows.some((row) => typeof row?.id !== 'string' || row.id !== query.projectId)
      ) {
        throw new Error('Invalid project lookup result');
      }
      projectExists = result.rows.length === 1;
    } catch {
      throw new ServiceUnavailableException(ANALYTICS_UNAVAILABLE);
    }
    if (!projectExists) throw new NotFoundException('Project not found');

    try {
      const { bucketMs, bucketInterval } = boundedBucket(query);
      const registeredResult = await this.database.query<{ name: string }>(
        `SELECT DISTINCT name FROM services
         WHERE project_id = $1 AND ($2 = 'all' OR environment = $2)
           AND ($3 = '' OR name = $3)
         ORDER BY name ASC
         LIMIT ${MAX_RESULT_ROWS + 1}`,
        [query.projectId, query.environment, query.service],
      );
      if (!registeredResult || !Array.isArray(registeredResult.rows) || registeredResult.rows.length > MAX_RESULT_ROWS) {
        throw new Error('Invalid registered services result');
      }
      const registeredServices = registeredResult.rows.map((row) => safeString(row?.name, 120));
      if (new Set(registeredServices).size !== registeredServices.length) {
        throw new Error('Invalid registered services result');
      }

      const params = queryParams(query);
      const [metricResult, seriesResult, serviceResult, recentErrorResult, topModelResult] = await Promise.all([
        this.clickhouse.query<MetricRow>(metricsSql(), params),
        this.clickhouse.query<SeriesRow>(seriesSql(query, bucketInterval), params),
        this.clickhouse.query<ServiceRow>(servicesSql(), params),
        this.clickhouse.query<RecentErrorRow>(recentErrorsSql(), params),
        this.clickhouse.query<TopModelRow>(topModelsSql(), params),
      ]);

      const rows: TraceRows = {
        metrics: checkedRows<MetricRow>(metricResult, 1),
        series: checkedRows<SeriesRow>(seriesResult, MAX_RESULT_ROWS),
        services: checkedRows<ServiceRow>(serviceResult, MAX_RESULT_ROWS),
        recentErrors: checkedRows<RecentErrorRow>(recentErrorResult, MAX_RECENT_ERRORS),
        topModels: checkedRows<TopModelRow>(topModelResult, MAX_TOP_MODELS),
      };
      if (rows.metrics.length !== 1) throw new Error('Invalid analytics result');
      return this.mapResponse(query, generatedAt, bucketMs, registeredServices, rows);
    } catch {
      throw new ServiceUnavailableException(ANALYTICS_UNAVAILABLE);
    }
  }

  private mapResponse(
    query: MetricsQuery,
    generatedAt: Date,
    bucketMs: number,
    registeredServices: string[],
    rows: TraceRows,
  ) {
    const metricRow = rows.metrics[0];
    const requestCount = safeInteger(metricRow.request_count);
    const errorCount = safeInteger(metricRow.error_count);
    const overallErrorRate = errorRate(requestCount, errorCount);
    const overallQuantiles = quantiles(metricRow.latency_quantiles, 3);
    const totalTokens = safeInteger(metricRow.total_tokens);
    const metrics = {
      requestCount,
      errorCount,
      errorRate: overallErrorRate,
      p50LatencyMs: overallQuantiles[0],
      p95LatencyMs: overallQuantiles[1],
      p99LatencyMs: overallQuantiles[2],
      totalTokens,
    };

    const serviceRows = new Map<string, {
      requestCount: number;
      errorCount: number;
      errorRate: number;
      p50LatencyMs: number;
      p95LatencyMs: number;
      p99LatencyMs: number;
      lastSeenAt: string;
    }>();
    for (const row of rows.services) {
      const name = safeString(row.name, 120);
      if (serviceRows.has(name)) throw new Error('Invalid analytics result');
      const serviceRequestCount = safeInteger(row.request_count);
      const serviceErrorCount = safeInteger(row.error_count);
      if (serviceRequestCount === 0) throw new Error('Invalid analytics result');
      const serviceQuantiles = quantiles(row.latency_quantiles, 3);
      serviceRows.set(name, {
        requestCount: serviceRequestCount,
        errorCount: serviceErrorCount,
        errorRate: errorRate(serviceRequestCount, serviceErrorCount),
        p50LatencyMs: serviceQuantiles[0],
        p95LatencyMs: serviceQuantiles[1],
        p99LatencyMs: serviceQuantiles[2],
        lastSeenAt: isoTimestamp(row.last_seen_at),
      });
    }

    const groupedByService = isGroupedByService(query);
    const observedServiceNames = groupedByService
      ? rows.series.map((row) => safeString(row.service, 120))
      : [];
    const serviceNames = [...new Set([...registeredServices, ...serviceRows.keys(), ...observedServiceNames])].sort();
    if (serviceNames.length > MAX_RESULT_ROWS) throw new Error('Invalid analytics result');
    const services = serviceNames.map((name) => {
      const row = serviceRows.get(name);
      return {
        name,
        requestCount: row?.requestCount ?? 0,
        errorCount: row?.errorCount ?? 0,
        errorRate: row?.errorRate ?? 0,
        p50LatencyMs: row?.p50LatencyMs ?? 0,
        p95LatencyMs: row?.p95LatencyMs ?? 0,
        p99LatencyMs: row?.p99LatencyMs ?? 0,
        lastSeenAt: row?.lastSeenAt ?? null,
        status: !row
          ? 'no_data' as const
          : row.errorRate >= DEGRADED_ERROR_RATE
            ? 'degraded' as const
            : 'healthy' as const,
      };
    });

    const fromMs = query.fromMs;
    const toMs = query.toMs;
    const firstBucketMs = Math.floor(fromMs / bucketMs) * bucketMs;
    const lastBucketMs = Math.floor((toMs - 1) / bucketMs) * bucketMs;
    const observedSeries = new Map<string, { requestCount: number; errorCount: number; totalTokens: number }>();
    for (const row of rows.series) {
      const bucketStart = isoTimestamp(row.bucket_start);
      const bucketStartMs = Date.parse(bucketStart);
      if (
        bucketStartMs < firstBucketMs
        || bucketStartMs > lastBucketMs
        || bucketStartMs % bucketMs !== 0
      ) {
        throw new Error('Invalid analytics result');
      }
      const service = groupedByService ? safeString(row.service, 120) : undefined;
      if (!groupedByService && row.service !== undefined) throw new Error('Invalid analytics result');
      const key = service === undefined ? bucketStart : `${bucketStart}\u0000${service}`;
      if (observedSeries.has(key)) throw new Error('Invalid analytics result');
      const seriesRequestCount = safeInteger(row.request_count);
      const seriesErrorCount = safeInteger(row.error_count);
      const seriesTotalTokens = safeInteger(row.total_tokens);
      errorRate(seriesRequestCount, seriesErrorCount);
      observedSeries.set(key, {
        requestCount: seriesRequestCount,
        errorCount: seriesErrorCount,
        totalTokens: seriesTotalTokens,
      });
    }

    const bucketStarts: number[] = [];
    for (let bucketStartMs = firstBucketMs; bucketStartMs <= lastBucketMs; bucketStartMs += bucketMs) {
      bucketStarts.push(bucketStartMs);
    }
    const seriesPointCount = bucketStarts.length * (groupedByService ? serviceNames.length : 1);
    if (seriesPointCount > MAX_RESULT_ROWS) throw new Error('Invalid analytics result');
    const series = bucketStarts.flatMap((bucketStartMs) => {
      const bucketStart = new Date(bucketStartMs).toISOString();
      const names = groupedByService ? serviceNames : [undefined];
      return names.map((service) => {
        const key = service === undefined ? bucketStart : `${bucketStart}\u0000${service}`;
        const observed = observedSeries.get(key) ?? { requestCount: 0, errorCount: 0, totalTokens: 0 };
        return {
          ...(service === undefined ? {} : { service }),
          bucketStart,
          requestCount: observed.requestCount,
          errorCount: observed.errorCount,
          errorRate: errorRate(observed.requestCount, observed.errorCount),
          totalTokens: observed.totalTokens,
        };
      });
    });

    const seenErrors = new Set<string>();
    const recentErrors = rows.recentErrors.map((row) => {
      const traceId = TraceIdSchema.safeParse(row.trace_id);
      const environment = EnvironmentSchema.safeParse(row.environment);
      if (!traceId.success || !environment.success) throw new Error('Invalid analytics result');
      const errorKey = `${environment.data}\u0000${traceId.data}`;
      if (seenErrors.has(errorKey)) throw new Error('Invalid analytics result');
      seenErrors.add(errorKey);
      return {
        traceId: traceId.data,
        environment: environment.data,
        service: safeString(row.service, 120),
        operation: safeString(row.operation, 160),
        startTime: isoTimestamp(row.start_time),
        durationMs: nonNegativeNumber(row.duration_ms),
      };
    });

    const topModels = rows.topModels.map((row) => {
      const model = safeString(row.model, 120);
      if (model !== '(unknown)' && !SAFE_MODEL_PATTERN.test(model)) {
        throw new Error('Invalid analytics result');
      }
      const modelQuantiles = quantiles(row.latency_quantiles, 1);
      const callCount = safeInteger(row.call_count);
      if (callCount === 0) throw new Error('Invalid analytics result');
      return {
        model,
        callCount,
        totalTokens: safeInteger(row.total_tokens),
        p95LatencyMs: modelQuantiles[0],
      };
    });
    if (new Set(topModels.map(({ model }) => model)).size !== topModels.length) {
      throw new Error('Invalid analytics result');
    }

    const range = {
      key: query.range,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    };
    return {
      generatedAt: generatedAt.toISOString(),
      range,
      metrics,
      summary: metrics,
      series,
      timeseries: series,
      services,
      recentErrors,
      topModels,
    };
  }
}
