import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AlertsDatabase } from './alerts.database';
import {
  AlertState,
  parseAlertId,
  parseAlertState,
  parseAlertsListQuery,
  parseAlertsSummaryQuery,
} from './alerts-query';

const ALERTS_UNAVAILABLE = 'Alerts are unavailable';
const ALLOWED_ALERT_TRANSITIONS: Record<AlertState, readonly AlertState[]> = {
  active: ['active', 'acknowledged', 'resolved'],
  acknowledged: ['acknowledged', 'active', 'resolved'],
  resolved: ['resolved', 'active'],
};

interface AlertRow extends QueryResultRow {
  id: unknown;
  title: unknown;
  message: unknown;
  rule: unknown;
  service: unknown;
  environment: unknown;
  level: unknown;
  state: unknown;
  trace_id: unknown;
  span_id: unknown;
  first_seen_at: unknown;
  last_seen_at: unknown;
  trigger_count: unknown;
}

interface AlertScope extends QueryResultRow {
  project_id: string;
  environment: string;
  service: string;
  rule: string;
}

function safeString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error('Invalid alert result');
  }
  return value;
}

function safeCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid alert result');
  return parsed;
}

function isoTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid alert result');
  return date.toISOString();
}

function mapAlert(row: AlertRow) {
  const level = safeString(row.level, 16);
  const state = safeString(row.state, 20);
  const environment = safeString(row.environment, 32);
  if (!['info', 'warning', 'critical'].includes(level)
    || !['active', 'acknowledged', 'resolved'].includes(state)
    || !['dev', 'staging', 'prod'].includes(environment)) {
    throw new Error('Invalid alert result');
  }
  return {
    id: safeString(row.id, 36),
    title: safeString(row.title, 160),
    message: safeString(row.message, 500),
    rule: safeString(row.rule, 64),
    service: safeString(row.service, 120),
    environment,
    level,
    state,
    traceId: safeString(row.trace_id, 128),
    spanId: safeString(row.span_id, 128),
    firstSeenAt: isoTimestamp(row.first_seen_at),
    lastSeenAt: isoTimestamp(row.last_seen_at),
    triggerCount: safeCount(row.trigger_count),
  };
}

async function acquireScopeLock(client: PoolClient, scope: AlertScope): Promise<void> {
  const lockKey = JSON.stringify([
    scope.project_id,
    scope.environment,
    scope.service,
    scope.rule,
  ]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
}

@Injectable()
export class AlertsService {
  constructor(private readonly database: AlertsDatabase) {}

  async list(rawQuery: unknown) {
    const query = parseAlertsListQuery(rawQuery);
    await this.assertProjectExists(query.projectId);

    try {
      const values = [query.projectId, query.environment, query.state, query.level, query.from ?? null, query.to ?? null];
      const where = `project_id = $1
        AND ($2 = 'all' OR environment = $2)
        AND ($3 = 'all' OR state = $3)
        AND ($4 = 'all' OR level = $4)
        AND ($5::timestamptz IS NULL OR last_seen_at >= $5::timestamptz)
        AND ($6::timestamptz IS NULL OR last_seen_at < $6::timestamptz)`;
      const [countResult, listResult] = await Promise.all([
        this.database.query<{ total: unknown }>(
          `SELECT count(*) AS total FROM alert_incidents WHERE ${where}`,
          values,
        ),
        this.database.query<AlertRow>(
          `SELECT id, title, message, rule, service, environment, level, state,
                  trace_id, span_id, first_seen_at, last_seen_at, trigger_count
           FROM alert_incidents
           WHERE ${where}
           ORDER BY last_seen_at DESC, id DESC
           LIMIT $7 OFFSET $8`,
          [...values, query.pageSize, query.offset],
        ),
      ]);
      if (countResult.rows.length !== 1 || listResult.rows.length > query.pageSize) {
        throw new Error('Invalid alert result');
      }
      return {
        items: listResult.rows.map(mapAlert),
        total: safeCount(countResult.rows[0]!.total),
        page: query.page,
        pageSize: query.pageSize,
      };
    } catch {
      throw new ServiceUnavailableException(ALERTS_UNAVAILABLE);
    }
  }

  async summary(rawQuery: unknown) {
    const query = parseAlertsSummaryQuery(rawQuery);
    await this.assertProjectExists(query.projectId);

    try {
      const result = await this.database.query<{
        total: unknown;
        active: unknown;
        acknowledged: unknown;
        resolved: unknown;
        critical_active: unknown;
      }>(
        `SELECT
           count(*) AS total,
           count(*) FILTER (WHERE state = 'active') AS active,
           count(*) FILTER (WHERE state = 'acknowledged') AS acknowledged,
           count(*) FILTER (WHERE state = 'resolved') AS resolved,
           count(*) FILTER (WHERE state = 'active' AND level = 'critical') AS critical_active
         FROM alert_incidents
         WHERE project_id = $1 AND ($2 = 'all' OR environment = $2)
           AND ($3::timestamptz IS NULL OR last_seen_at >= $3::timestamptz)
           AND ($4::timestamptz IS NULL OR last_seen_at < $4::timestamptz)`,
        [query.projectId, query.environment, query.from ?? null, query.to ?? null],
      );
      if (result.rows.length !== 1) throw new Error('Invalid alert summary');
      const row = result.rows[0]!;
      return {
        total: safeCount(row.total),
        active: safeCount(row.active),
        acknowledged: safeCount(row.acknowledged),
        resolved: safeCount(row.resolved),
        criticalActive: safeCount(row.critical_active),
      };
    } catch {
      throw new ServiceUnavailableException(ALERTS_UNAVAILABLE);
    }
  }

  async updateState(rawId: unknown, rawBody: unknown) {
    const id = parseAlertId(rawId);
    const targetState = parseAlertState(rawBody);
    let updated: AlertRow | null;

    try {
      updated = await this.database.transaction(async (client) => {
        const scopeResult = await client.query<AlertScope>(
          `SELECT project_id, environment, service, rule
           FROM alert_incidents WHERE id = $1`,
          [id],
        );
        const scope = scopeResult.rows[0];
        if (!scope) return null;

        await acquireScopeLock(client, scope);
        const currentResult = await client.query<AlertRow>(
          `SELECT id, title, message, rule, service, environment, level, state,
                  trace_id, span_id, first_seen_at, last_seen_at, trigger_count
           FROM alert_incidents WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const current = currentResult.rows[0];
        if (!current) return null;
        if (
          typeof current.state !== 'string'
          || !ALLOWED_ALERT_TRANSITIONS[current.state as AlertState]?.includes(targetState)
        ) {
          throw new BadRequestException('Invalid alert state transition');
        }
        if (current.state === targetState) return current;

        if (targetState === 'active') {
          const competing = await client.query<{ id: string }>(
            `SELECT id FROM alert_incidents
             WHERE project_id = $1 AND environment = $2 AND service = $3 AND rule = $4
               AND state IN ('active', 'acknowledged') AND id <> $5
             LIMIT 1 FOR UPDATE`,
            [scope.project_id, scope.environment, scope.service, scope.rule, id],
          );
          if (competing.rows.length > 0) {
            throw new ConflictException('An active alert already exists for this rule scope');
          }
        }

        const result = await client.query<AlertRow>(
          `UPDATE alert_incidents
           SET state = $2, updated_at = now()
           WHERE id = $1
           RETURNING id, title, message, rule, service, environment, level, state,
                     trace_id, span_id, first_seen_at, last_seen_at, trigger_count`,
          [id, targetState],
        );
        return result.rows[0] ?? null;
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(ALERTS_UNAVAILABLE);
    }

    if (!updated) throw new NotFoundException('Alert not found');
    try {
      return mapAlert(updated);
    } catch {
      throw new ServiceUnavailableException(ALERTS_UNAVAILABLE);
    }
  }

  private async assertProjectExists(projectId: string): Promise<void> {
    let exists: boolean;
    try {
      const result = await this.database.query<{ id: unknown }>(
        'SELECT id FROM projects WHERE id = $1 LIMIT 1',
        [projectId],
      );
      if (result.rows.length > 1) throw new Error('Invalid project result');
      exists = result.rows.length === 1 && result.rows[0]!.id === projectId;
    } catch {
      throw new ServiceUnavailableException(ALERTS_UNAVAILABLE);
    }
    if (!exists) throw new NotFoundException('Project not found');
  }
}

export type { AlertState };
