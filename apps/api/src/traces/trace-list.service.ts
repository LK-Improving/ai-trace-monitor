import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  ClickHouseQueryParams,
  ClickHouseService,
} from '../overview/clickhouse.service';
import { TraceIdSchema } from '@trace-ops/contracts';
import { parseTraceListQuery } from './trace-query';
import type { TraceListQuery } from './trace-query';

const ANALYTICS_UNAVAILABLE = 'Analytics data is unavailable';

interface CountRow extends Record<string, unknown> {
  total: unknown;
}

interface TraceRow extends Record<string, unknown> {
  trace_id: unknown;
  environment: unknown;
  root_operation: unknown;
  services: unknown;
  status: unknown;
  duration_ms: unknown;
  total_tokens: unknown;
  started_at: unknown;
  span_count: unknown;
}

// The parser caps this half-open event_time window at 30 days. A trace crossing
// either boundary can therefore be incomplete in the list response.
const TRACE_ROWS_SQL = `
WITH deduplicated_spans AS
(
  SELECT
    project_id,
    trace_id,
    environment,
    span_id,
    argMax(
      tuple(parent_span_id, service, operation, status, start_time, end_time, total_tokens, model),
      tuple(event_time, end_time, start_time, parent_span_id, service, operation, status, total_tokens, model)
    ) AS span
  FROM trace_spans
  WHERE project_id = {projectId:String}
    AND event_time >= fromUnixTimestamp64Milli({fromMs:Int64}, 'UTC')
    AND event_time < fromUnixTimestamp64Milli({toMs:Int64}, 'UTC')
    AND ({environment:String} = 'all' OR environment = {environment:String})
    AND ({traceId:String} = '' OR trace_id = {traceId:String})
  GROUP BY project_id, trace_id, environment, span_id
),
normalized_spans AS
(
  SELECT
    project_id,
    trace_id,
    environment,
    span_id,
    tupleElement(span, 1) AS parent_span_id,
    tupleElement(span, 2) AS service,
    tupleElement(span, 3) AS operation,
    tupleElement(span, 4) AS status,
    tupleElement(span, 5) AS start_time,
    tupleElement(span, 6) AS end_time,
    tupleElement(span, 7) AS total_tokens,
    tupleElement(span, 8) AS model
  FROM deduplicated_spans
),
trace_rows AS
(
  SELECT
    project_id,
    trace_id,
    environment,
    if(
      countIf(parent_span_id = '') > 0,
      argMinIf(operation, tuple(start_time, span_id, operation), parent_span_id = ''),
      argMin(operation, tuple(start_time, span_id, operation))
    ) AS root_operation,
    arraySort(groupUniqArray(service)) AS services,
    if(countIf(status = 'error') > 0, 'error', 'ok') AS trace_status,
    dateDiff('millisecond', min(start_time), max(end_time)) AS duration_ms,
    sumIf(total_tokens, model != '' OR operation = 'llm.generate') AS token_total,
    min(start_time) AS started_at,
    count() AS span_count
  FROM normalized_spans
  GROUP BY project_id, trace_id, environment
  HAVING
    ({service:String} = '' OR countIf(service = {service:String}) > 0)
    AND
    (
      {status:String} = ''
      OR ({status:String} = 'error' AND countIf(status = 'error') > 0)
      OR ({status:String} = 'ok' AND countIf(status = 'error') = 0)
    )
)
`;

const COUNT_SQL = `${TRACE_ROWS_SQL}
SELECT count() AS total
FROM trace_rows`;

const PAGE_SQL = `${TRACE_ROWS_SQL}
SELECT
  trace_id,
  environment,
  if(root_operation = '', 'unknown', root_operation) AS root_operation,
  services,
  trace_status AS status,
  duration_ms,
  token_total AS total_tokens,
  started_at,
  span_count
FROM trace_rows
ORDER BY started_at DESC, trace_id ASC, environment ASC
LIMIT {pageSize:UInt64}
OFFSET {offset:UInt64}`;

function safeInteger(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Invalid analytics result');
  }
  return parsed;
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

  if (!Number.isFinite(parsed.getTime())) {
    throw new Error('Invalid analytics result');
  }
  return parsed.toISOString();
}

function queryParams(query: TraceListQuery): ClickHouseQueryParams {
  return {
    projectId: query.projectId,
    environment: query.environment,
    fromMs: query.fromMs,
    toMs: query.toMs,
    traceId: query.traceId ?? '',
    service: query.service ?? '',
    status: query.status ?? '',
  };
}

function mapTraceRow(row: TraceRow) {
  const traceId = TraceIdSchema.safeParse(row.trace_id);
  if (
    !traceId.success
    || (row.environment !== 'dev' && row.environment !== 'staging' && row.environment !== 'prod')
    || (row.status !== 'ok' && row.status !== 'error')
    || typeof row.root_operation !== 'string'
    || row.root_operation.length > 160
    || !Array.isArray(row.services)
    || row.services.length > 120
    || !row.services.every((service) => typeof service === 'string')
    || row.services.some((service) => service.length > 120)
  ) {
    throw new Error('Invalid analytics result');
  }

  return {
    traceId: traceId.data,
    environment: row.environment,
    rootOperation: row.root_operation || 'unknown',
    services: row.services as string[],
    status: row.status,
    durationMs: safeInteger(row.duration_ms),
    totalTokens: safeInteger(row.total_tokens),
    startedAt: isoTimestamp(row.started_at),
    spanCount: safeInteger(row.span_count),
  };
}

@Injectable()
export class TraceListService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clickhouse: ClickHouseService,
  ) {}

  async list(rawQuery: unknown) {
    const query = parseTraceListQuery(rawQuery);

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
      const range = {
        from: isoTimestamp(query.fromMs),
        to: isoTimestamp(query.toMs),
      };
      const params = queryParams(query);
      const countRows = await this.clickhouse.query<CountRow>(COUNT_SQL, params);
      if (!Array.isArray(countRows) || countRows.length !== 1) {
        throw new Error('Invalid analytics result');
      }
      const total = safeInteger(countRows[0]?.total);

      if (total === 0) {
        return { items: [], total, page: query.page, pageSize: query.pageSize, range };
      }

      const rows = await this.clickhouse.query<TraceRow>(PAGE_SQL, {
        ...params,
        pageSize: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      });
      if (!Array.isArray(rows) || rows.length > query.pageSize) {
        throw new Error('Invalid analytics result');
      }

      return {
        items: rows.map(mapTraceRow),
        total,
        page: query.page,
        pageSize: query.pageSize,
        range,
      };
    } catch {
      throw new ServiceUnavailableException(ANALYTICS_UNAVAILABLE);
    }
  }
}
