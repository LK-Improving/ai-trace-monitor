import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ClickHouseService, ClickHouseQueryParams } from './clickhouse.service';
import {
  OVERVIEW_RANGES,
  OverviewQuery,
  parseOverviewQuery,
} from './overview-query';

const DEGRADED_ERROR_RATE = 0.01;

interface CountRow extends Record<string, unknown> {
  request_count: number | string;
  error_count: number | string;
  p95_latency_ms?: number | string;
  total_tokens?: number | string;
}

interface SeriesRow extends Record<string, unknown> {
  bucket_start: string | Date;
  request_count: number | string;
  error_count: number | string;
}

interface ServiceRow extends CountRow {
  name: string;
  last_seen_at: string | Date;
}

interface RecentErrorRow extends Record<string, unknown> {
  trace_id: string;
  service: string;
  operation: string;
  start_time: string | Date;
  duration_ms: number | string;
}

interface OverviewSpanFilter {
  projectId: string;
  environment: string;
  fromMs: number;
  toMs: number;
}

interface OverviewSeriesItem {
  bucketStart: string;
  requestCount: number;
  errorCount: number;
  errorRate: number;
}

const SPAN_FILTER = `
  project_id = {projectId:String}
  AND event_time >= fromUnixTimestamp64Milli({fromMs:Int64}, 'UTC')
  AND event_time < fromUnixTimestamp64Milli({toMs:Int64}, 'UTC')
  AND ({environment:String} = 'all' OR environment = {environment:String})`;
// Browser diagnostics are standalone observations, not completed requests.
const REQUEST_ROOT = `parent_span_id = '' AND operation NOT IN ('browser.web_vital', 'browser.javascript_error', 'browser.unhandled_rejection')`;
const REQUEST_SPAN_FILTER = `${SPAN_FILTER} AND ${REQUEST_ROOT}`;

function numberValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(parsed)) throw new Error('Invalid analytics result');
  return parsed;
}

function isoTimestamp(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw new Error('Invalid analytics timestamp');
  return parsed.toISOString();
}

function errorRate(requestCount: number, errorCount: number): number {
  return requestCount === 0 ? 0 : errorCount / requestCount;
}

function queryParams(filter: OverviewSpanFilter): ClickHouseQueryParams {
  return {
    projectId: filter.projectId,
    environment: filter.environment,
    fromMs: filter.fromMs,
    toMs: filter.toMs,
  };
}

@Injectable()
export class OverviewService {
  private readonly now = () => new Date();

  constructor(
    private readonly database: DatabaseService,
    private readonly clickhouse: ClickHouseService,
  ) {}

  async getOverview(rawQuery: unknown) {
    const query = parseOverviewQuery(rawQuery);
    let projectExists: boolean;
    try {
      const result = await this.database.query<{ id: string }>(
        'SELECT id FROM projects WHERE id = $1',
        [query.projectId],
      );
      projectExists = result.rows.length > 0;
    } catch {
      throw new ServiceUnavailableException('Analytics data is unavailable');
    }
    if (!projectExists) throw new NotFoundException('Project not found');

    try {
      const generatedAt = this.now();
      const toMs = generatedAt.getTime();
      const rangeDefinition = OVERVIEW_RANGES[query.range];
      const fromMs = toMs - rangeDefinition.durationMs;
      const filter: OverviewSpanFilter = {
        projectId: query.projectId,
        environment: query.environment,
        fromMs,
        toMs,
      };
      const params = queryParams(filter);
      const registeredServices = await this.database.query<{ name: string }>(
        `SELECT DISTINCT name FROM services
         WHERE project_id = $1 AND ($2 = 'all' OR environment = $2)
         ORDER BY name ASC`,
        [query.projectId, query.environment],
      );

      const [metricRows, seriesRows, serviceRows, recentErrorRows] = await Promise.all([
        this.clickhouse.query<CountRow>(
          `SELECT
             countIf(${REQUEST_ROOT}) AS request_count,
             countIf(${REQUEST_ROOT} AND status = 'error') AS error_count,
             if(countIf(${REQUEST_ROOT}) = 0, 0., quantileIf(0.95)(duration_ms, ${REQUEST_ROOT})) AS p95_latency_ms,
             sumIf(total_tokens, model != '' OR operation = 'llm.generate') AS total_tokens
           FROM trace_spans
           WHERE ${SPAN_FILTER}`,
          params,
        ),
        this.clickhouse.query<SeriesRow>(
          `SELECT
             toStartOfInterval(event_time, ${rangeDefinition.bucketInterval}) AS bucket_start,
             count() AS request_count,
             countIf(status = 'error') AS error_count
           FROM trace_spans
           WHERE ${REQUEST_SPAN_FILTER}
           GROUP BY bucket_start
           ORDER BY bucket_start ASC`,
          params,
        ),
        this.clickhouse.query<ServiceRow>(
          `SELECT
             service AS name,
             count() AS request_count,
             countIf(status = 'error') AS error_count,
             quantile(0.95)(duration_ms) AS p95_latency_ms,
             max(event_time) AS last_seen_at
           FROM trace_spans
           WHERE ${SPAN_FILTER}
           GROUP BY service
           ORDER BY service ASC`,
          params,
        ),
        this.clickhouse.query<RecentErrorRow>(
          `SELECT trace_id, service, operation, start_time, duration_ms
           FROM trace_spans
           WHERE ${SPAN_FILTER} AND status = 'error'
           ORDER BY start_time DESC, trace_id ASC
           LIMIT 20`,
          params,
        ),
      ]);

      return this.mapResponse(query, generatedAt, fromMs, toMs, registeredServices.rows, {
        metrics: metricRows[0],
        series: seriesRows,
        services: serviceRows,
        recentErrors: recentErrorRows,
      });
    } catch {
      // Keep both PostgreSQL and ClickHouse failures behind the existing safe 503 mapping.
      throw new ServiceUnavailableException('Analytics data is unavailable');
    }
  }

  private mapResponse(
    query: OverviewQuery,
    generatedAt: Date,
    fromMs: number,
    toMs: number,
    registeredServices: Array<{ name: string }>,
    rows: {
      metrics: CountRow | undefined;
      series: SeriesRow[];
      services: ServiceRow[];
      recentErrors: RecentErrorRow[];
    },
  ) {
    const rawMetrics = rows.metrics;
    const requestCount = numberValue(rawMetrics?.request_count);
    const errorCount = numberValue(rawMetrics?.error_count);
    const bucketMs = OVERVIEW_RANGES[query.range].bucketMs;
    const observedBuckets = new Map(rows.series.map((row) => {
      const start = isoTimestamp(row.bucket_start);
      const count = numberValue(row.request_count);
      const errors = numberValue(row.error_count);
      return [start, { requestCount: count, errorCount: errors }] as const;
    }));
    const firstBucketMs = Math.floor(fromMs / bucketMs) * bucketMs;
    const lastBucketMs = Math.floor((toMs - 1) / bucketMs) * bucketMs;
    const series: OverviewSeriesItem[] = [];
    for (let bucketStartMs = firstBucketMs; bucketStartMs <= lastBucketMs; bucketStartMs += bucketMs) {
      const bucketStart = new Date(bucketStartMs).toISOString();
      const observed = observedBuckets.get(bucketStart) ?? { requestCount: 0, errorCount: 0 };
      series.push({
        bucketStart,
        requestCount: observed.requestCount,
        errorCount: observed.errorCount,
        errorRate: errorRate(observed.requestCount, observed.errorCount),
      });
    }

    const serviceMetrics = new Map(rows.services.map((row) => [row.name, row]));
    const services = registeredServices.map(({ name }) => {
      const row = serviceMetrics.get(name);
      const serviceRequestCount = numberValue(row?.request_count);
      const serviceErrorCount = numberValue(row?.error_count);
      const rate = errorRate(serviceRequestCount, serviceErrorCount);
      return {
        name,
        requestCount: serviceRequestCount,
        errorCount: serviceErrorCount,
        errorRate: rate,
        p95LatencyMs: numberValue(row?.p95_latency_ms),
        lastSeenAt: row ? isoTimestamp(row.last_seen_at) : null,
        status: !row
          ? 'no_data' as const
          : rate >= DEGRADED_ERROR_RATE
            ? 'degraded' as const
            : 'healthy' as const,
      };
    });

    return {
      generatedAt: generatedAt.toISOString(),
      range: {
        key: query.range,
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
      },
      metrics: {
        requestCount,
        errorCount,
        errorRate: errorRate(requestCount, errorCount),
        p95LatencyMs: numberValue(rawMetrics?.p95_latency_ms),
        totalTokens: numberValue(rawMetrics?.total_tokens),
      },
      series,
      services,
      recentErrors: rows.recentErrors.map((row) => ({
        traceId: row.trace_id,
        service: row.service,
        operation: row.operation,
        startTime: isoTimestamp(row.start_time),
        durationMs: numberValue(row.duration_ms),
      })),
    };
  }
}
