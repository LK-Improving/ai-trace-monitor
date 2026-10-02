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
import { parseMetricsQuery } from './metrics-query';
import { metricsSpansSql } from './metrics-sql';

const ANALYTICS_UNAVAILABLE = 'Analytics data is unavailable';
const MAX_MODELS = 100;

type MetricsRow = Record<string, unknown>;

interface LlmMetrics {
  callCount: number;
  errorCount: number;
  errorRate: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  ttftSampleCount: number;
  p50TtftMs: number;
  p95TtftMs: number;
  p99TtftMs: number;
}

interface LlmRow extends MetricsRow {
  call_count: unknown;
  error_count: unknown;
  invalid_status_count: unknown;
  invalid_duration_count: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  total_tokens: unknown;
  p50_latency_ms: unknown;
  p95_latency_ms: unknown;
  p99_latency_ms: unknown;
  ttft_sample_count: unknown;
  p50_ttft_ms: unknown;
  p95_ttft_ms: unknown;
  p99_ttft_ms: unknown;
}

interface LlmModelRow extends LlmRow {
  model: unknown;
}

interface RagRow extends MetricsRow {
  call_count: unknown;
  success_count: unknown;
  error_count: unknown;
  invalid_status_count: unknown;
  invalid_duration_count: unknown;
  empty_recall_count: unknown;
  observed_recall_count: unknown;
  p50_latency_ms: unknown;
  p95_latency_ms: unknown;
  p99_latency_ms: unknown;
  recall_sample_count: unknown;
  p95_recall_ms: unknown;
  rerank_sample_count: unknown;
  p95_rerank_ms: unknown;
}

const METRICS_SPANS_WITH_SERVICE = `${metricsSpansSql()}, scoped_spans AS (
  SELECT *
  FROM normalized_spans
  WHERE ({service:String} = '' OR service = {service:String})
)`;
const SAFE_ATTRIBUTES = "if(length(attributes) <= 16384 AND isValidJSON(attributes), attributes, '{}') AS safe_attributes";

const LLM_SOURCE_CTE = `${METRICS_SPANS_WITH_SERVICE}, llm_source AS (
  SELECT
    status,
    duration_ms,
    input_tokens,
    output_tokens,
    total_tokens,
    if(match(model, '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'), model, '(unknown)') AS display_model,
    ${SAFE_ATTRIBUTES}
  FROM scoped_spans
  WHERE operation = 'llm.generate'
), llm_spans AS (
  SELECT
    *,
    JSONType(safe_attributes, 'llm.ttft_ms') IN ('Int64', 'UInt64', 'Double')
      AND JSONExtractFloat(safe_attributes, 'llm.ttft_ms') BETWEEN 0 AND 120000 AS ttft_valid,
    JSONExtractFloat(safe_attributes, 'llm.ttft_ms') AS ttft_ms
  FROM llm_source
)`;

const LLM_AGGREGATE_FIELDS = `
  count() AS call_count,
  countIf(status = 'error') AS error_count,
  countIf(status NOT IN ('ok', 'error')) AS invalid_status_count,
  countIf(NOT isFinite(duration_ms) OR duration_ms < 0) AS invalid_duration_count,
  sum(input_tokens) AS input_tokens,
  sum(output_tokens) AS output_tokens,
  sum(total_tokens) AS total_tokens,
  if(count() = 0, [0., 0., 0.], quantilesExact(0.5, 0.95, 0.99)(duration_ms)) AS latency_quantiles,
  countIf(ttft_valid) AS ttft_sample_count,
  if(countIf(ttft_valid) = 0, [0., 0., 0.], quantilesExactIf(0.5, 0.95, 0.99)(ttft_ms, ttft_valid)) AS ttft_quantiles`;

const LLM_PROJECTED_FIELDS = `
  call_count,
  error_count,
  invalid_status_count,
  invalid_duration_count,
  input_tokens,
  output_tokens,
  total_tokens,
  latency_quantiles[1] AS p50_latency_ms,
  latency_quantiles[2] AS p95_latency_ms,
  latency_quantiles[3] AS p99_latency_ms,
  ttft_sample_count,
  ttft_quantiles[1] AS p50_ttft_ms,
  ttft_quantiles[2] AS p95_ttft_ms,
  ttft_quantiles[3] AS p99_ttft_ms`;

const LLM_TOTAL_SQL = `${LLM_SOURCE_CTE}
SELECT ${LLM_PROJECTED_FIELDS}
FROM (SELECT ${LLM_AGGREGATE_FIELDS} FROM llm_spans) AS llm_aggregate`;

const LLM_MODELS_SQL = `${LLM_SOURCE_CTE}
SELECT
  model,${LLM_PROJECTED_FIELDS}
FROM (
  SELECT display_model AS model, ${LLM_AGGREGATE_FIELDS}
  FROM llm_spans
  GROUP BY display_model
) AS llm_model_aggregates
ORDER BY call_count DESC, model ASC
LIMIT 101`;

const RAG_AGGREGATE_FIELDS = `
  count() AS call_count,
  countIf(status = 'ok') AS success_count,
  countIf(status = 'error') AS error_count,
  countIf(status NOT IN ('ok', 'error')) AS invalid_status_count,
  countIf(NOT isFinite(duration_ms) OR duration_ms < 0) AS invalid_duration_count,
  countIf(status = 'ok' AND recalled_count_valid) AS observed_recall_count,
  countIf(status = 'ok' AND recalled_count_valid AND recalled_count = 0) AS empty_recall_count,
  if(count() = 0, [0., 0., 0.], quantilesExact(0.5, 0.95, 0.99)(duration_ms)) AS latency_quantiles,
  countIf(recall_valid) AS recall_sample_count,
  if(countIf(recall_valid) = 0, 0., quantileExactIf(0.95)(recall_ms, recall_valid)) AS p95_recall_ms,
  countIf(rerank_valid) AS rerank_sample_count,
  if(countIf(rerank_valid) = 0, 0., quantileExactIf(0.95)(rerank_ms, rerank_valid)) AS p95_rerank_ms`;

const RAG_PROJECTED_FIELDS = `
  call_count,
  success_count,
  error_count,
  invalid_status_count,
  invalid_duration_count,
  empty_recall_count,
  observed_recall_count,
  latency_quantiles[1] AS p50_latency_ms,
  latency_quantiles[2] AS p95_latency_ms,
  latency_quantiles[3] AS p99_latency_ms,
  recall_sample_count,
  p95_recall_ms,
  rerank_sample_count,
  p95_rerank_ms`;

const RAG_SQL = `${METRICS_SPANS_WITH_SERVICE}, rag_source AS (
  SELECT
    status,
    duration_ms,
    ${SAFE_ATTRIBUTES}
  FROM scoped_spans
  WHERE operation = 'rag.retrieve'
), rag_spans AS (
  SELECT
    *,
    JSONType(safe_attributes, 'rag.recalled_count') IN ('Int64', 'UInt64', 'Double')
      AND isFinite(JSONExtractFloat(safe_attributes, 'rag.recalled_count'))
      AND JSONExtractFloat(safe_attributes, 'rag.recalled_count') >= 0
      AND JSONExtractFloat(safe_attributes, 'rag.recalled_count') <= 100
      AND JSONExtractFloat(safe_attributes, 'rag.recalled_count') = floor(JSONExtractFloat(safe_attributes, 'rag.recalled_count'))
      AS recalled_count_valid,
    JSONExtractFloat(safe_attributes, 'rag.recalled_count') AS recalled_count,
    JSONType(safe_attributes, 'rag.recall_ms') IN ('Int64', 'UInt64', 'Double')
      AND JSONExtractFloat(safe_attributes, 'rag.recall_ms') BETWEEN 0 AND 120000 AS recall_valid,
    JSONExtractFloat(safe_attributes, 'rag.recall_ms') AS recall_ms,
    JSONType(safe_attributes, 'rag.rerank_ms') IN ('Int64', 'UInt64', 'Double')
      AND JSONExtractFloat(safe_attributes, 'rag.rerank_ms') BETWEEN 0 AND 120000 AS rerank_valid,
    JSONExtractFloat(safe_attributes, 'rag.rerank_ms') AS rerank_ms
  FROM rag_source
)
SELECT ${RAG_PROJECTED_FIELDS}
FROM (SELECT ${RAG_AGGREGATE_FIELDS} FROM rag_spans) AS rag_aggregate`;

function safeCount(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid analytics result');
  return parsed;
}

function safeMeasurement(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Invalid analytics result');
  return parsed;
}

function safeModel(value: unknown): string {
  if (value === '(unknown)') return value;
  if (typeof value !== 'string') throw new Error('Invalid analytics result');
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(value) ? value : '(unknown)';
}

function errorRate(errors: number, calls: number): number {
  if (errors > calls) throw new Error('Invalid analytics result');
  return calls === 0 ? 0 : errors / calls;
}

function isoTimestamp(value: unknown): string {
  if (!Number.isSafeInteger(value)) throw new Error('Invalid analytics result');
  const date = new Date(value as number);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid analytics result');
  return date.toISOString();
}

function mapLlmRow(row: LlmRow): LlmMetrics & { invalidStatusCount: number; invalidDurationCount: number } {
  const callCount = safeCount(row.call_count);
  const errorCount = safeCount(row.error_count);
  const invalidStatusCount = safeCount(row.invalid_status_count);
  const invalidDurationCount = safeCount(row.invalid_duration_count);
  const ttftSampleCount = safeCount(row.ttft_sample_count);
  if (invalidStatusCount !== 0 || invalidDurationCount !== 0 || ttftSampleCount > callCount) {
    throw new Error('Invalid analytics result');
  }
  return {
    callCount,
    errorCount,
    errorRate: errorRate(errorCount, callCount),
    inputTokens: safeCount(row.input_tokens),
    outputTokens: safeCount(row.output_tokens),
    totalTokens: safeCount(row.total_tokens),
    p50LatencyMs: safeMeasurement(row.p50_latency_ms),
    p95LatencyMs: safeMeasurement(row.p95_latency_ms),
    p99LatencyMs: safeMeasurement(row.p99_latency_ms),
    ttftSampleCount,
    p50TtftMs: safeMeasurement(row.p50_ttft_ms),
    p95TtftMs: safeMeasurement(row.p95_ttft_ms),
    p99TtftMs: safeMeasurement(row.p99_ttft_ms),
    invalidStatusCount,
    invalidDurationCount,
  };
}

function mapRagRow(row: RagRow) {
  const callCount = safeCount(row.call_count);
  const successCount = safeCount(row.success_count);
  const errorCount = safeCount(row.error_count);
  const invalidStatusCount = safeCount(row.invalid_status_count);
  const invalidDurationCount = safeCount(row.invalid_duration_count);
  const emptyRecallCount = safeCount(row.empty_recall_count);
  const observedRecallCount = safeCount(row.observed_recall_count);
  const recallSampleCount = safeCount(row.recall_sample_count);
  const rerankSampleCount = safeCount(row.rerank_sample_count);
  if (
    invalidStatusCount !== 0
    || invalidDurationCount !== 0
    || successCount + errorCount !== callCount
    || emptyRecallCount > observedRecallCount
    || observedRecallCount > successCount
    || recallSampleCount > callCount
    || rerankSampleCount > callCount
  ) throw new Error('Invalid analytics result');

  return {
    callCount,
    successCount,
    errorCount,
    successRate: callCount === 0 ? 0 : successCount / callCount,
    emptyRecallCount,
    observedRecallCount,
    // No valid recall-count observations means the rate is unknown, not measured zero.
    emptyRecallRate: observedRecallCount === 0 ? null : emptyRecallCount / observedRecallCount,
    p50LatencyMs: safeMeasurement(row.p50_latency_ms),
    p95LatencyMs: safeMeasurement(row.p95_latency_ms),
    p99LatencyMs: safeMeasurement(row.p99_latency_ms),
    recallSampleCount,
    p95RecallMs: safeMeasurement(row.p95_recall_ms),
    rerankSampleCount,
    p95RerankMs: safeMeasurement(row.p95_rerank_ms),
  };
}

function queryParams(query: ReturnType<typeof parseMetricsQuery>): ClickHouseQueryParams {
  return {
    projectId: query.projectId,
    environment: query.environment,
    fromMs: query.fromMs,
    toMs: query.toMs,
    service: query.service,
  };
}

@Injectable()
export class AiMetricsService {
  private now = () => Date.now();

  constructor(
    private readonly database: DatabaseService,
    private readonly clickhouse: ClickHouseService,
  ) {}

  async getMetrics(rawQuery: unknown) {
    const generatedAtMs = this.now();
    const query = parseMetricsQuery(rawQuery, generatedAtMs);
    await this.requireProject(query.projectId);

    try {
      const params = queryParams(query);
      const [llmRows, modelRows, ragRows] = await Promise.all([
        // These reads can observe adjacent ingestion snapshots; validate each independently.
        this.clickhouse.query<LlmRow>(LLM_TOTAL_SQL, params),
        this.clickhouse.query<LlmModelRow>(LLM_MODELS_SQL, params),
        this.clickhouse.query<RagRow>(RAG_SQL, params),
      ]);
      if (
        !Array.isArray(llmRows) || llmRows.length !== 1
        || !Array.isArray(modelRows) || modelRows.length > MAX_MODELS
        || !Array.isArray(ragRows) || ragRows.length !== 1
      ) throw new Error('Invalid analytics result');

      const llmWithStatus = mapLlmRow(llmRows[0]);
      const llm: LlmMetrics = {
        callCount: llmWithStatus.callCount,
        errorCount: llmWithStatus.errorCount,
        errorRate: llmWithStatus.errorRate,
        inputTokens: llmWithStatus.inputTokens,
        outputTokens: llmWithStatus.outputTokens,
        totalTokens: llmWithStatus.totalTokens,
        p50LatencyMs: llmWithStatus.p50LatencyMs,
        p95LatencyMs: llmWithStatus.p95LatencyMs,
        p99LatencyMs: llmWithStatus.p99LatencyMs,
        ttftSampleCount: llmWithStatus.ttftSampleCount,
        p50TtftMs: llmWithStatus.p50TtftMs,
        p95TtftMs: llmWithStatus.p95TtftMs,
        p99TtftMs: llmWithStatus.p99TtftMs,
      };
      const models = modelRows.map((row) => {
        const model = safeModel(row.model);
        const {
          invalidStatusCount: _invalidStatusCount,
          invalidDurationCount: _invalidDurationCount,
          ...metrics
        } = mapLlmRow(row);
        return { model, ...metrics };
      });
      if (new Set(models.map(({ model }) => model)).size !== models.length) {
        throw new Error('Invalid analytics result');
      }

      return {
        generatedAt: isoTimestamp(generatedAtMs),
        range: {
          key: query.range,
          from: isoTimestamp(query.fromMs),
          to: isoTimestamp(query.toMs),
        },
        llm: { ...llm, models },
        rag: mapRagRow(ragRows[0]),
      };
    } catch {
      throw new ServiceUnavailableException(ANALYTICS_UNAVAILABLE);
    }
  }

  private async requireProject(projectId: string): Promise<void> {
    let exists: boolean;
    try {
      const result = await this.database.query<{ id: string }>(
        'SELECT id FROM projects WHERE id = $1 LIMIT 1',
        [projectId],
      );
      if (
        !result
        || !Array.isArray(result.rows)
        || result.rows.length > 1
        || result.rows.some((row) => typeof row?.id !== 'string' || row.id !== projectId)
      ) throw new Error('Invalid project lookup result');
      exists = result.rows.length === 1;
    } catch {
      throw new ServiceUnavailableException(ANALYTICS_UNAVAILABLE);
    }
    if (!exists) throw new NotFoundException('Project not found');
  }
}
