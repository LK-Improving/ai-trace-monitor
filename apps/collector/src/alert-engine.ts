import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, PoolClient } from 'pg';
import type { SpanEvent } from '@trace-ops/contracts';

export const ALERT_DEFAULTS = Object.freeze({
  spanLatencyMs: 2_000,
  llmTotalTokens: 5_000,
});

export type BuiltInAlertRule =
  | 'span_error'
  | 'span_latency'
  | 'llm_token_threshold'
  | 'rag_empty_recall';

export interface AlertMatch {
  projectId: string;
  environment: SpanEvent['environment'];
  service: string;
  rule: BuiltInAlertRule;
  title: string;
  message: string;
  level: 'warning' | 'critical';
  traceId: string;
  spanId: string;
  observedAt: string;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function explicitlyReportsEmptyRecall(attributes: SpanEvent['attributes']): boolean {
  const recalledCount = attributes['rag.recalled_count'];
  if (finiteNonNegative(recalledCount)) return recalledCount === 0;

  const retrievedCount = attributes.retrievedCount;
  if (finiteNonNegative(retrievedCount)) return retrievedCount === 0;

  const sources = attributes.sources ?? attributes['rag.sources'];
  return Array.isArray(sources) && sources.length === 0;
}

export function evaluateSpanAlerts(span: SpanEvent): AlertMatch[] {
  const endTime = span.endTime ?? span.startTime;
  const durationMs = Math.max(0, endTime - span.startTime);
  const observedAt = new Date(endTime).toISOString();
  const alerts: AlertMatch[] = [];
  const shared = {
    projectId: span.projectId,
    environment: span.environment,
    service: span.service,
    traceId: span.traceId,
    spanId: span.spanId,
    observedAt,
  };

  if (span.status === 'error') {
    alerts.push({
      ...shared,
      rule: 'span_error',
      title: 'Span 执行错误',
      message: 'Span 状态为 error；内置规则对每个失败 Span 触发一次。',
      level: 'critical',
    });
  }

  if (span.endTime !== undefined && durationMs > ALERT_DEFAULTS.spanLatencyMs) {
    alerts.push({
      ...shared,
      rule: 'span_latency',
      title: 'Span 延迟超限',
      message: `Span 耗时 ${durationMs}ms，超过固定阈值 ${ALERT_DEFAULTS.spanLatencyMs}ms。`,
      level: 'warning',
    });
  }

  if (
    span.operation === 'llm.generate'
    && span.tokenUsage
    && span.tokenUsage.total > ALERT_DEFAULTS.llmTotalTokens
  ) {
    alerts.push({
      ...shared,
      rule: 'llm_token_threshold',
      title: 'LLM Token 用量超限',
      message: `单次 LLM Span 总 Token 为 ${span.tokenUsage.total}，超过固定阈值 ${ALERT_DEFAULTS.llmTotalTokens}。`,
      level: 'warning',
    });
  }

  if (
    span.operation === 'rag.retrieve'
    && span.status === 'ok'
    && explicitlyReportsEmptyRecall(span.attributes)
  ) {
    alerts.push({
      ...shared,
      rule: 'rag_empty_recall',
      title: 'RAG 检索为空召回',
      message: 'rag.retrieve 成功，且 rag.recalled_count/retrievedCount 为 0 或 sources 为空。',
      level: 'warning',
    });
  }

  return alerts;
}

function alertSchemaSql(): string {
  const configuredPath = process.env.TRACE_OPS_ALERT_SCHEMA_PATH;
  if (configuredPath) {
    const path = resolve(configuredPath);
    if (!existsSync(path)) throw new Error('Alert schema migration file is unavailable');
    return readFileSync(path, 'utf8');
  }
  const roots = [
    process.cwd(),
    resolve(process.cwd(), '../..'),
    resolve(__dirname, '../../../'),
  ];
  for (const root of roots) {
    const paths = [
      resolve(root, 'infra/postgres/init/002-alerts.sql'),
      resolve(root, 'infra/postgres/init/003-alert-notifications.sql'),
    ];
    if (paths.every(existsSync)) return paths.map((path) => readFileSync(path, 'utf8')).join('\n');
  }
  throw new Error('Alert schema migration files are unavailable');
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scopeKey(alert: AlertMatch): string {
  return JSON.stringify([alert.projectId, alert.environment, alert.service, alert.rule]);
}

/** Persist built-in matches in Postgres before the Collector advances Kafka offsets. */
export class AlertEngine {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', ['7321198204142']);
      await client.query(alertSchemaSql());
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error('Alert schema migration failed');
    } finally {
      client.release();
    }
  }

  async processSpans(spans: readonly SpanEvent[]): Promise<number> {
    const matches = spans.flatMap(evaluateSpanAlerts);
    matches.sort((left, right) => compare(scopeKey(left), scopeKey(right))
      || compare(left.observedAt, right.observedAt)
      || compare(left.traceId, right.traceId)
      || compare(left.spanId, right.spanId));
    if (matches.length === 0) return 0;

    const client = await this.pool.connect();
    let persistedCount = 0;
    try {
      await client.query('BEGIN');
      for (const match of matches) {
        if (await this.persistMatch(client, match)) persistedCount += 1;
      }
      await client.query('COMMIT');
      return persistedCount;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = error !== null && typeof error === 'object' && 'code' in error
        && typeof (error as { code?: unknown }).code === 'string'
        && /^[A-Z0-9_]{2,32}$/.test((error as { code: string }).code)
        ? (error as { code: string }).code
        : undefined;
      const failure = new Error('Alert persistence failed') as Error & { code?: string };
      if (code) failure.code = code;
      throw failure;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async persistMatch(client: PoolClient, alert: AlertMatch): Promise<boolean> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [scopeKey(alert)],
    );

    const occurrence = await client.query(
      `INSERT INTO alert_occurrences (
         project_id, environment, service, rule, trace_id, span_id, observed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (project_id, environment, service, rule, trace_id, span_id)
       DO NOTHING
       RETURNING span_id`,
      [
        alert.projectId,
        alert.environment,
        alert.service,
        alert.rule,
        alert.traceId,
        alert.spanId,
        alert.observedAt,
      ],
    );
    if (occurrence.rowCount !== 1) return false;

    const open = await client.query<{ id: string }>(
      `SELECT id FROM alert_incidents
       WHERE project_id = $1 AND environment = $2 AND service = $3 AND rule = $4
         AND state IN ('active', 'acknowledged')
       ORDER BY created_at DESC, id DESC
       LIMIT 1 FOR UPDATE`,
      [alert.projectId, alert.environment, alert.service, alert.rule],
    );

    let alertId: string;
    let createdIncident = false;
    if (open.rows[0]) {
      const updated = await client.query<{ id: string }>(
        `UPDATE alert_incidents
         SET message = CASE WHEN $2::timestamptz >= last_seen_at THEN $3 ELSE message END,
             trace_id = CASE WHEN $2::timestamptz >= last_seen_at THEN $4 ELSE trace_id END,
             span_id = CASE WHEN $2::timestamptz >= last_seen_at THEN $5 ELSE span_id END,
             first_seen_at = LEAST(first_seen_at, $2::timestamptz),
             last_seen_at = GREATEST(last_seen_at, $2::timestamptz),
             trigger_count = trigger_count + 1,
             updated_at = now()
         WHERE id = $1
         RETURNING id`,
        [open.rows[0].id, alert.observedAt, alert.message, alert.traceId, alert.spanId],
      );
      if (updated.rows.length !== 1) throw new Error('Alert incident update failed');
      alertId = updated.rows[0]!.id;
    } else {
      const created = await client.query<{ id: string }>(
        `INSERT INTO alert_incidents (
           project_id, environment, service, rule, title, message, level, state,
           trace_id, span_id, first_seen_at, last_seen_at, trigger_count
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $10, 1)
         RETURNING id`,
        [
          alert.projectId,
          alert.environment,
          alert.service,
          alert.rule,
          alert.title,
          alert.message,
          alert.level,
          alert.traceId,
          alert.spanId,
          alert.observedAt,
        ],
      );
      if (created.rows.length !== 1) throw new Error('Alert incident insert failed');
      alertId = created.rows[0]!.id;
      createdIncident = true;
    }

    const linked = await client.query(
      `UPDATE alert_occurrences SET alert_id = $7
       WHERE project_id = $1 AND environment = $2 AND service = $3 AND rule = $4
         AND trace_id = $5 AND span_id = $6`,
      [alert.projectId, alert.environment, alert.service, alert.rule,
        alert.traceId, alert.spanId, alertId],
    );
    if (linked.rowCount !== 1) throw new Error('Alert occurrence link failed');
    if (createdIncident) await this.enqueueNotifications(client, alertId, alert);
    return true;
  }

  private async enqueueNotifications(client: PoolClient, alertId: string, alert: AlertMatch): Promise<void> {
    const safePayload = JSON.stringify({
      alertId,
      title: alert.title,
      rule: alert.rule,
      level: alert.level,
      service: alert.service,
      environment: alert.environment,
      traceId: alert.traceId,
      spanId: alert.spanId,
      occurredAt: alert.observedAt,
    });
    await client.query(
      `INSERT INTO alert_notification_deliveries (
         project_id, channel_id, channel_name, channel_type, event_type,
         alert_id, alert_title, level, service, environment, trace_id, safe_payload,
         status, attempts_in_cycle, next_attempt_at
       )
       SELECT $1::uuid, channel.id, channel.name, channel.channel_type, 'alert',
              $2::uuid, $3::varchar(160), $4::varchar(16), $5::varchar(120),
              $6::varchar(32), $7::varchar(128), $8::jsonb,
              'queued', 0, now()
       FROM alert_notification_channels AS channel
       WHERE channel.project_id = $1
         AND channel.deleted_at IS NULL
         AND channel.enabled = true
         AND (channel.environment = 'all' OR channel.environment = $6::varchar(32))
         AND CASE channel.min_level
               WHEN 'info' THEN 0 WHEN 'warning' THEN 1 ELSE 2
             END <= CASE $4::varchar(16)
                      WHEN 'info' THEN 0 WHEN 'warning' THEN 1 ELSE 2
                    END
       ON CONFLICT DO NOTHING`,
      [alert.projectId, alertId, alert.title, alert.level, alert.service,
        alert.environment, alert.traceId, safePayload],
    );
  }
}
