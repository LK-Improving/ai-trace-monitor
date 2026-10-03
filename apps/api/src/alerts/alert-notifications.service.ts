import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { QueryResultRow } from 'pg';
import { AlertsDatabase } from './alerts.database';
import { allowPrivateNotificationTargets } from './alert-notifications.config';
import {
  encryptNotificationTarget,
  notificationDestinationHint,
  notificationEncryptionKey,
} from './alert-notifications.crypto';
import {
  AlertChannelInput,
  AlertChannelPatch,
  AlertDeliveryStatus,
  parseCreateAlertChannel,
  parseDeliveryListQuery,
  parseId,
  parsePatchAlertChannel,
  parseProjectAction,
  parseProjectQuery,
} from './alert-notifications.validation';

const UNAVAILABLE = 'Alert notifications are unavailable';
const MANUAL_RETRY_LIMIT = 3;

interface ChannelRow extends QueryResultRow {
  id: unknown; project_id: unknown; name: unknown; channel_type: unknown;
  environment: unknown; min_level: unknown; enabled: unknown; target_ciphertext: unknown;
  destination_hint: unknown; created_at: unknown; updated_at: unknown;
}

interface DeliveryRow extends QueryResultRow {
  id: unknown; channel_id: unknown; channel_name: unknown; channel_type: unknown;
  event_type: unknown; alert_id: unknown; alert_title: unknown; level: unknown;
  service: unknown; environment: unknown; trace_id: unknown; status: unknown;
  attempt_count: unknown; next_attempt_at: unknown; last_attempt_at: unknown;
  delivered_at: unknown; last_error_code: unknown; created_at: unknown;
}

function timestamp(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid notification timestamp');
  return parsed.toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value == null ? null : timestamp(value);
}

function safeText(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)
    || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid notification result');
  return value;
}

function mapChannel(row: ChannelRow) {
  const type = safeText(row.channel_type, 16);
  const environment = safeText(row.environment, 16);
  const minLevel = safeText(row.min_level, 16);
  if (!['webhook', 'email'].includes(type) || !['all', 'dev', 'staging', 'prod'].includes(environment)
    || !['info', 'warning', 'critical'].includes(minLevel) || typeof row.enabled !== 'boolean') {
    throw new Error('Invalid notification channel');
  }
  const ciphertext = safeText(row.target_ciphertext, 8192);
  return {
    id: safeText(row.id, 36),
    projectId: safeText(row.project_id, 36),
    name: safeText(row.name, 120),
    type,
    environment,
    minLevel,
    enabled: row.enabled,
    destinationHint: safeText(row.destination_hint, 254, true),
    hasSecret: ciphertext.length > 0,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapDelivery(row: DeliveryRow) {
  const channelType = safeText(row.channel_type, 16);
  const eventType = safeText(row.event_type, 16);
  const status = safeText(row.status, 16);
  const level = row.level == null ? null : safeText(row.level, 16);
  const environment = row.environment == null ? null : safeText(row.environment, 16);
  if (!['webhook', 'email'].includes(channelType) || !['alert', 'test'].includes(eventType)
    || !['queued', 'sending', 'retrying', 'sent', 'failed', 'canceled'].includes(status)
    || (level !== null && !['info', 'warning', 'critical'].includes(level))
    || (environment !== null && !['dev', 'staging', 'prod'].includes(environment))) {
    throw new Error('Invalid delivery result');
  }
  const attemptCount = typeof row.attempt_count === 'number' ? row.attempt_count : Number(row.attempt_count);
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 0) throw new Error('Invalid delivery result');
  return {
    id: safeText(row.id, 36),
    channelId: safeText(row.channel_id ?? '', 36, true),
    channelName: safeText(row.channel_name, 120),
    channelType,
    eventType,
    alertId: row.alert_id == null ? null : safeText(row.alert_id, 36),
    alertTitle: row.alert_title == null ? null : safeText(row.alert_title, 160, true),
    level,
    service: row.service == null ? null : safeText(row.service, 120, true),
    environment,
    traceId: row.trace_id == null ? null : safeText(row.trace_id, 128, true),
    status,
    attemptCount,
    nextAttemptAt: nullableTimestamp(row.next_attempt_at),
    lastAttemptAt: nullableTimestamp(row.last_attempt_at),
    deliveredAt: nullableTimestamp(row.delivered_at),
    lastErrorCode: row.last_error_code == null ? null : safeText(row.last_error_code, 64),
    createdAt: timestamp(row.created_at),
  };
}

function toSafeError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  throw new ServiceUnavailableException(UNAVAILABLE);
}

@Injectable()
export class AlertNotificationsService {
  constructor(private readonly database: AlertsDatabase, private readonly config: ConfigService) {}

  async listChannels(rawQuery: unknown) {
    const projectId = parseProjectQuery(rawQuery);
    await this.assertProjectExists(projectId);
    try {
      const result = await this.database.query<ChannelRow>(
        `SELECT id, project_id, name, channel_type, environment, min_level, enabled,
                target_ciphertext, destination_hint, created_at, updated_at
         FROM alert_notification_channels
         WHERE project_id = $1 AND deleted_at IS NULL
         ORDER BY lower(name), id`,
        [projectId],
      );
      return { items: result.rows.map(mapChannel) };
    } catch (error) { return toSafeError(error); }
  }

  async createChannel(rawBody: unknown) {
    const input = parseCreateAlertChannel(rawBody, this.allowPrivateTargets()) as AlertChannelInput;
    await this.assertProjectExists(input.projectId);
    const encrypted = this.encryptTarget(input.type, this.targetFromInput(input));
    try {
      const result = await this.database.transaction(async (client) => {
        try {
          return await client.query<ChannelRow>(
            `INSERT INTO alert_notification_channels (
               project_id, name, channel_type, environment, min_level, enabled,
               target_ciphertext, destination_hint
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, project_id, name, channel_type, environment, min_level, enabled,
                       target_ciphertext, destination_hint, created_at, updated_at`,
            [input.projectId, input.name, input.type, input.environment, input.minLevel, input.enabled,
              encrypted, notificationDestinationHint(input.type, this.targetFromInput(input))],
          );
        } catch (error) {
          if (isUniqueViolation(error)) throw new ConflictException('A channel with this name already exists');
          throw error;
        }
      });
      if (!result.rows[0]) throw new Error('Channel insert returned no row');
      return mapChannel(result.rows[0]);
    } catch (error) { return toSafeError(error); }
  }

  async patchChannel(rawId: unknown, rawBody: unknown) {
    const id = parseId(rawId);
    const patch = parsePatchAlertChannel(rawBody, this.allowPrivateTargets()) as AlertChannelPatch;
    await this.assertProjectExists(patch.projectId);
    try {
      const updated = await this.database.transaction(async (client) => {
        const currentResult = await client.query<ChannelRow>(
          `SELECT id, project_id, name, channel_type, environment, min_level, enabled,
                  target_ciphertext, destination_hint, created_at, updated_at
           FROM alert_notification_channels
           WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
           FOR UPDATE`,
          [id, patch.projectId],
        );
        const current = currentResult.rows[0];
        if (!current) return null;
        const currentType = current.channel_type;
        const hasWebhook = Object.hasOwn(patch, 'webhookUrl');
        const hasRecipient = Object.hasOwn(patch, 'recipient');
        if ((hasWebhook && currentType !== 'webhook') || (hasRecipient && currentType !== 'email')) {
          throw new BadRequestException('Channel target type cannot be changed');
        }
        const target = hasWebhook ? patch.webhookUrl! : hasRecipient ? patch.recipient! : null;
        const targetCiphertext = target === null ? current.target_ciphertext : this.encryptTarget(currentType as 'webhook' | 'email', target);
        const destinationHint = target === null
          ? current.destination_hint
          : notificationDestinationHint(currentType as 'webhook' | 'email', target);
        try {
          const result = await client.query<ChannelRow>(
            `UPDATE alert_notification_channels
             SET name = COALESCE($3, name), environment = COALESCE($4, environment),
                 min_level = COALESCE($5, min_level), enabled = COALESCE($6, enabled),
                 target_ciphertext = $7, destination_hint = $8, updated_at = now()
             WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
             RETURNING id, project_id, name, channel_type, environment, min_level, enabled,
                       target_ciphertext, destination_hint, created_at, updated_at`,
            [id, patch.projectId, patch.name ?? null, patch.environment ?? null, patch.minLevel ?? null,
              patch.enabled ?? null, targetCiphertext, destinationHint],
          );
          return result.rows[0] ?? null;
        } catch (error) {
          if (isUniqueViolation(error)) throw new ConflictException('A channel with this name already exists');
          throw error;
        }
      });
      if (!updated) throw new NotFoundException('Alert channel not found');
      return mapChannel(updated);
    } catch (error) { return toSafeError(error); }
  }

  async deleteChannel(rawId: unknown, rawQuery: unknown): Promise<{ deleted: true }> {
    const id = parseId(rawId);
    const projectId = parseProjectQuery(rawQuery);
    await this.assertProjectExists(projectId);
    try {
      await this.database.transaction(async (client) => {
        const result = await client.query(
          `UPDATE alert_notification_channels SET deleted_at = now(), enabled = false, updated_at = now()
           WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL RETURNING id`,
          [id, projectId],
        );
        if (result.rowCount !== 1) throw new NotFoundException('Alert channel not found');
        await client.query(
          `UPDATE alert_notification_deliveries
           SET status = 'canceled', next_attempt_at = NULL, lease_token = NULL,
               lease_expires_at = NULL, updated_at = now()
           WHERE channel_id = $1 AND project_id = $2 AND status IN ('queued', 'retrying', 'sending')`,
          [id, projectId],
        );
      });
    } catch (error) { toSafeError(error); }
    return { deleted: true };
  }

  async testChannel(rawId: unknown, rawBody: unknown): Promise<{ queued: true }> {
    const id = parseId(rawId);
    const projectId = parseProjectAction(rawBody);
    await this.assertProjectExists(projectId);
    try {
      await this.database.transaction(async (client) => {
        const result = await client.query<ChannelRow>(
          `SELECT id, project_id, name, channel_type, environment, min_level, enabled,
                  target_ciphertext, destination_hint, created_at, updated_at
           FROM alert_notification_channels
           WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
           FOR SHARE`,
          [id, projectId],
        );
        const channel = result.rows[0];
        if (!channel) throw new NotFoundException('Alert channel not found');
        if (channel.enabled !== true) throw new BadRequestException('Enable the channel before sending a test');
        await client.query(
          `INSERT INTO alert_notification_deliveries (
             project_id, channel_id, channel_name, channel_type, event_type, safe_payload,
             status, attempts_in_cycle, next_attempt_at
           ) VALUES ($1, $2, $3, $4, 'test', $5::jsonb, 'queued', 0, now())`,
          [projectId, id, channel.name, channel.channel_type,
            JSON.stringify({ title: 'Trace Ops 测试通知', service: 'trace-ops', environment: null, level: null, traceId: null })],
        );
      });
    } catch (error) { toSafeError(error); }
    return { queued: true };
  }

  async listDeliveries(rawQuery: unknown) {
    const query = parseDeliveryListQuery(rawQuery);
    await this.assertProjectExists(query.projectId);
    try {
      const where = `project_id = $1 AND ($2 = 'all' OR status = $2)`;
      const [count, result] = await Promise.all([
        this.database.query<{ total: unknown }>(`SELECT count(*) AS total FROM alert_notification_deliveries WHERE ${where}`,
          [query.projectId, query.status]),
        this.database.query<DeliveryRow>(
          `SELECT id, channel_id, channel_name, channel_type, event_type, alert_id,
                  alert_title, level, service, environment, trace_id, status,
                  attempt_count, next_attempt_at, last_attempt_at, delivered_at,
                  last_error_code, created_at
           FROM alert_notification_deliveries WHERE ${where}
           ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
          [query.projectId, query.status, query.pageSize, query.offset],
        ),
      ]);
      const total = typeof count.rows[0]?.total === 'number' ? count.rows[0].total : Number(count.rows[0]?.total);
      if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid delivery count');
      return { items: result.rows.map(mapDelivery), total, page: query.page, pageSize: query.pageSize };
    } catch (error) { return toSafeError(error); }
  }

  async retryDelivery(rawId: unknown, rawBody: unknown): Promise<{ queued: true }> {
    const id = parseId(rawId);
    const projectId = parseProjectAction(rawBody);
    await this.assertProjectExists(projectId);
    try {
      await this.database.transaction(async (client) => {
        const reference = await client.query<{ channel_id: string | null }>(
          `SELECT channel_id FROM alert_notification_deliveries
           WHERE id = $1 AND project_id = $2`,
          [id, projectId],
        );
        const channelId = reference.rows[0]?.channel_id;
        if (reference.rows.length === 0) throw new NotFoundException('Delivery not found');
        if (!channelId) throw new ConflictException('Cannot retry without an active notification channel');

        // Lock the channel before the delivery, matching deleteChannel's lock order.
        const channel = await client.query<{ deleted_at: Date | null }>(
          `SELECT deleted_at FROM alert_notification_channels
           WHERE id = $1 AND project_id = $2 FOR SHARE`,
          [channelId, projectId],
        );
        if (!channel.rows[0] || channel.rows[0].deleted_at !== null) {
          throw new ConflictException('Cannot retry a delivery for a deleted channel');
        }

        const result = await client.query<{
          status: AlertDeliveryStatus; manual_retry_count: number; channel_id: string | null;
        }>(
          `SELECT status, manual_retry_count, channel_id FROM alert_notification_deliveries
           WHERE id = $1 AND project_id = $2 FOR UPDATE`,
          [id, projectId],
        );
        const row = result.rows[0];
        if (!row) throw new NotFoundException('Delivery not found');
        if (row.channel_id !== channelId) throw new ConflictException('Notification channel changed; retry again');
        if (row.status !== 'failed') throw new ConflictException('Only failed deliveries can be retried');
        if (Number(row.manual_retry_count) >= MANUAL_RETRY_LIMIT) {
          throw new ConflictException('Manual retry limit reached');
        }
        await client.query(
          `UPDATE alert_notification_deliveries
           SET status = 'queued', attempts_in_cycle = 0, manual_retry_count = manual_retry_count + 1,
               next_attempt_at = now(), last_error_code = NULL, lease_token = NULL,
               lease_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND project_id = $2`,
          [id, projectId],
        );
      });
    } catch (error) { toSafeError(error); }
    return { queued: true };
  }

  async assertProjectExists(projectId: string): Promise<void> {
    try {
      const result = await this.database.query<{ id: unknown }>('SELECT id FROM projects WHERE id = $1 LIMIT 1', [projectId]);
      if (result.rows.length === 0) throw new NotFoundException('Project not found');
    } catch (error) { toSafeError(error); }
  }

  private allowPrivateTargets(): boolean {
    return allowPrivateNotificationTargets(this.config);
  }

  private targetFromInput(input: AlertChannelInput): string {
    return input.type === 'webhook' ? input.webhookUrl! : input.recipient!;
  }

  private encryptTarget(type: 'webhook' | 'email', target: string): string {
    try { return encryptNotificationTarget(target, notificationEncryptionKey(this.config)); }
    catch { throw new ServiceUnavailableException('Alert notification encryption is not configured'); }
  }

  /** Kept private to make it difficult for a future controller to return plaintext destinations. */
}

function isUniqueViolation(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === '23505';
}

export { UNAVAILABLE as ALERT_NOTIFICATIONS_UNAVAILABLE };
