import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ClickHouseQueryParams, ClickHouseService } from '../overview/clickhouse.service';
import { projectTraceDetail } from './trace-detail.projection';
import { parseTraceDetailQuery } from './trace-query';

const MAX_FETCHED_SPANS = 2_001;
const UNAVAILABLE_MESSAGE = 'Trace data is unavailable';

const TRACE_DETAIL_SQL = `
  SELECT
    span_id,
    tupleElement(latest, 1) AS event_time,
    tupleElement(latest, 4) AS parent_span_id,
    tupleElement(latest, 5) AS service,
    tupleElement(latest, 6) AS operation,
    tupleElement(latest, 7) AS status,
    tupleElement(latest, 3) AS start_time,
    tupleElement(latest, 2) AS end_time,
    tupleElement(latest, 10) AS duration_ms,
    tupleElement(latest, 9) AS model,
    tupleElement(latest, 11) AS input_tokens,
    tupleElement(latest, 12) AS output_tokens,
    tupleElement(latest, 8) AS total_tokens,
    tupleElement(latest, 13) AS attributes
  FROM (
    SELECT
      span_id,
      argMax(
        tuple(event_time, end_time, start_time, parent_span_id, service, operation, status,
              total_tokens, model, duration_ms, input_tokens, output_tokens, attributes),
        tuple(event_time, end_time, start_time, parent_span_id, service, operation, status,
              total_tokens, model, duration_ms, input_tokens, output_tokens, attributes)
      ) AS latest
    FROM trace_spans
    WHERE project_id = {projectId:String}
      AND environment = {environment:String}
      AND trace_id = {traceId:String}
      AND event_time >= fromUnixTimestamp64Milli({fromMs:Int64}, 'UTC')
      AND event_time < fromUnixTimestamp64Milli({toMs:Int64}, 'UTC')
    GROUP BY span_id
  )
  ORDER BY start_time ASC, span_id ASC
  LIMIT 2001`;

interface ProjectRow extends Record<string, unknown> {
  id: string;
}

interface TraceSpanRow extends Record<string, unknown> {
  span_id: string;
  event_time: string | Date;
  parent_span_id: string;
  service: string;
  operation: string;
  status: string;
  start_time: string | Date;
  end_time: string | Date;
  duration_ms: number | string;
  model: string;
  input_tokens: number | string;
  output_tokens: number | string;
  total_tokens: number | string;
  attributes: string;
}

@Injectable()
export class TraceDetailService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clickhouse: ClickHouseService,
  ) {}

  async detail(traceId: unknown, rawQuery: unknown) {
    const query = parseTraceDetailQuery(traceId, rawQuery);
    let projectRows: ProjectRow[];
    try {
      const result = await this.database.query<ProjectRow>(
        'SELECT id FROM projects WHERE id = $1 LIMIT 1',
        [query.projectId],
      );
      if (!Array.isArray(result.rows)) throw new Error();
      projectRows = result.rows;
    } catch {
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }

    if (projectRows.length === 0) throw new NotFoundException('Project not found');
    if (!projectRows.some((row) => row?.id === query.projectId)) {
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }

    const params: ClickHouseQueryParams = {
      projectId: query.projectId,
      environment: query.environment,
      traceId: query.traceId,
      fromMs: query.fromMs,
      toMs: query.toMs,
    };
    let rows: TraceSpanRow[];
    try {
      rows = await this.clickhouse.query<TraceSpanRow>(TRACE_DETAIL_SQL, params);
      if (!Array.isArray(rows) || rows.length > MAX_FETCHED_SPANS) throw new Error();
    } catch {
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }

    if (rows.length === 0) throw new NotFoundException('Trace not found');
    try {
      return projectTraceDetail(query, rows);
    } catch {
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }
  }
}
