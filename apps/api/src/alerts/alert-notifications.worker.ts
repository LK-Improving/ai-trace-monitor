import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import nodemailer, { Transporter } from 'nodemailer';
import { AlertsDatabase } from './alerts.database';
import { allowPrivateNotificationTargets } from './alert-notifications.config';
import { decryptNotificationTarget, notificationEncryptionKey } from './alert-notifications.crypto';

const POLL_MS = 650;
const LEASE_SECONDS = 30;
const DELIVERY_TIMEOUT_MS = 8_000;
const BACKOFF_SECONDS = [15, 60, 300, 900, 1_800] as const;

const reservedIpv4 = new BlockList();
const reservedIpv6 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) reservedIpv4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) reservedIpv6.addSubnet(address, prefix, 'ipv6');

interface ClaimedDelivery {
  id: string;
  lease_token: string;
  channel_type: 'webhook' | 'email';
  target_ciphertext: string;
  event_type: 'alert' | 'test';
  safe_payload: Record<string, unknown>;
  attempt_count: number;
  attempts_in_cycle: number;
  max_attempts: number;
}

interface SendOutcome { accepted: boolean; retryable: boolean; errorCode: string | null }

function isReserved(address: string, family: number): boolean {
  try { return (family === 4 ? reservedIpv4 : reservedIpv6).check(address, family === 4 ? 'ipv4' : 'ipv6'); }
  catch { return true; }
}

export function validPublicAddress(address: string, family: number): boolean {
  if (family !== 4 && family !== 6) return false;
  if (isReserved(address, family)) return false;
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:') || lower.startsWith('::') || lower.startsWith('64:ff9b:')) return false;
  }
  return true;
}

async function resolveWebhookAddress(hostname: string, allowPrivate: boolean): Promise<{ address: string; family: number }> {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    if (!allowPrivate) throw new DeliveryFailure('webhook_target_blocked', false);
  }
  const literalFamily = isIP(normalized);
  let addresses: Array<{ address: string; family: number }>;
  if (literalFamily) addresses = [{ address: normalized, family: literalFamily }];
  else {
    let dnsTimeout: NodeJS.Timeout | undefined;
    try {
      addresses = await Promise.race([
        lookup(normalized, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          dnsTimeout = setTimeout(() => reject(new DeliveryFailure('webhook_dns_timeout', true)), 3_000);
          dnsTimeout.unref?.();
        }),
      ]);
    } catch (error) {
      if (error instanceof DeliveryFailure) throw error;
      throw new DeliveryFailure('webhook_dns_error', true);
    } finally { if (dnsTimeout) clearTimeout(dnsTimeout); }
  }
  if (addresses.length === 0) throw new DeliveryFailure('webhook_dns_empty', true);
  if (!allowPrivate && addresses.some(({ address, family }) => !validPublicAddress(address, family))) {
    throw new DeliveryFailure('webhook_target_blocked', false);
  }
  return addresses[0]!;
}

class DeliveryFailure extends Error {
  constructor(readonly safeCode: string, readonly retryable: boolean) { super(safeCode); }
}

function postWebhook(
  url: URL,
  address: { address: string; family: number },
  payload: string,
  deliveryId: string,
): Promise<SendOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: SendOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const request = requestFn({
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      timeout: DELIVERY_TIMEOUT_MS,
      maxHeaderSize: 16 * 1024,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'user-agent': 'TraceOps-Alert-Delivery/1.0',
        'idempotency-key': deliveryId,
        'x-trace-ops-delivery-id': deliveryId,
      },
      ...(url.protocol === 'https:' && !isIP(hostname) ? { servername: hostname } : {}),
      lookup: (_hostname: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => {
        callback(null, address.address, address.family);
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.destroy();
      finish(status >= 200 && status < 300
        ? { accepted: true, retryable: false, errorCode: null }
        : { accepted: false, retryable: status === 429 || status >= 500, errorCode: 'webhook_http_error' });
    });
    request.setTimeout(DELIVERY_TIMEOUT_MS, () => {
      request.destroy(new Error('timeout'));
      finish({ accepted: false, retryable: true, errorCode: 'webhook_timeout' });
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      finish({ accepted: false, retryable: true, errorCode: error.code === 'ETIMEDOUT' ? 'webhook_timeout' : 'webhook_connection_error' });
    });
    request.end(payload);
  });
}

function safePayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function safeWorkerErrorCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 3 && current !== null && typeof current === 'object'; depth += 1) {
    if ('code' in current && typeof (current as { code?: unknown }).code === 'string') {
      const code = (current as { code: string }).code;
      if (/^[A-Z0-9_]{2,32}$/.test(code)) return code;
    }
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return 'UNCLASSIFIED';
}

function printable(value: unknown, max = 160): string {
  return typeof value === 'string' ? value.slice(0, max).replace(/[\u0000-\u001f\u007f]/g, ' ') : '';
}

function projectSafePayload(job: ClaimedDelivery): Record<string, string> {
  const source = job.safe_payload;
  const result: Record<string, string> = { id: job.id, type: job.event_type };
  const fields: Array<[string, number]> = [
    ['alertId', 36], ['title', 160], ['rule', 64], ['level', 16], ['service', 120],
    ['environment', 16], ['traceId', 128], ['spanId', 128], ['occurredAt', 40],
  ];
  for (const [key, max] of fields) {
    const value = printable(source[key], max);
    if (value) result[key] = value;
  }
  return result;
}

@Injectable()
export class AlertNotificationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertNotificationWorker.name);
  private stopping = false;
  private loopPromise?: Promise<void>;
  private mailer?: Transporter;

  constructor(private readonly database: AlertsDatabase, private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.stopping = false;
    this.loopPromise = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.loopPromise;
    this.mailer?.close();
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let job: ClaimedDelivery | null;
      try { job = await this.claim(); }
      catch (error) {
        this.logger.warn(`Notification claim failed: ${safeWorkerErrorCode(error)}`);
        await this.delay(1_500);
        continue;
      }
      if (!job) { await this.delay(POLL_MS); continue; }

      let outcome: SendOutcome;
      try { outcome = await this.deliver(job); }
      catch (error) {
        this.logger.warn(`Notification delivery failed: ${safeWorkerErrorCode(error)}`);
        outcome = { accepted: false, retryable: true, errorCode: 'delivery_internal_error' };
      }
      try { await this.complete(job, outcome); }
      catch (error) {
        this.logger.error(`Notification completion failed: ${safeWorkerErrorCode(error)}`);
        // The lease expiry makes an interrupted finalization recoverable.
      }
    }
  }

  private async claim(): Promise<ClaimedDelivery | null> {
    const result = await this.database.query<ClaimedDelivery>(
      `WITH candidate AS (
         SELECT delivery.id, channel.target_ciphertext
         FROM alert_notification_deliveries AS delivery
         JOIN alert_notification_channels AS channel
           ON channel.id = delivery.channel_id AND channel.project_id = delivery.project_id
         WHERE channel.deleted_at IS NULL
           AND ((delivery.status IN ('queued', 'retrying') AND COALESCE(delivery.next_attempt_at, now()) <= now())
             OR (delivery.status = 'sending' AND delivery.lease_expires_at <= now()))
         ORDER BY COALESCE(delivery.next_attempt_at, delivery.created_at), delivery.created_at, delivery.id
         LIMIT 1 FOR UPDATE OF delivery SKIP LOCKED
       ), claimed AS (
         UPDATE alert_notification_deliveries AS delivery
         SET status = 'sending', lease_token = gen_random_uuid(),
             lease_expires_at = now() + ($1::text || ' seconds')::interval,
             attempt_count = attempt_count + 1, attempts_in_cycle = attempts_in_cycle + 1,
             last_attempt_at = now(), updated_at = now()
         FROM candidate
         WHERE delivery.id = candidate.id
         RETURNING delivery.id, delivery.lease_token, delivery.channel_type,
                   candidate.target_ciphertext, delivery.event_type, delivery.safe_payload,
                   delivery.attempt_count, delivery.attempts_in_cycle, delivery.max_attempts
       ) SELECT * FROM claimed`,
      [LEASE_SECONDS],
    );
    if (!result.rows[0]) return null;
    return { ...result.rows[0], safe_payload: safePayload(result.rows[0].safe_payload) };
  }

  private async deliver(job: ClaimedDelivery): Promise<SendOutcome> {
    let target: string;
    try {
      target = decryptNotificationTarget(job.target_ciphertext, notificationEncryptionKey(this.config));
    } catch {
      return { accepted: false, retryable: false, errorCode: 'target_decryption_failed' };
    }
    if (job.channel_type === 'webhook') return this.deliverWebhook(job, target);
    return this.deliverEmail(job, target);
  }

  private async deliverWebhook(job: ClaimedDelivery, target: string): Promise<SendOutcome> {
    let url: URL;
    try { url = new URL(target); }
    catch { return { accepted: false, retryable: false, errorCode: 'webhook_target_invalid' }; }
    const allowPrivate = allowPrivateNotificationTargets(this.config);
    if (!['https:', ...(allowPrivate ? ['http:'] : [])].includes(url.protocol)
      || url.username || url.password || url.hash) {
      return { accepted: false, retryable: false, errorCode: 'webhook_target_invalid' };
    }
    try {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const address = await resolveWebhookAddress(hostname, allowPrivate);
      const payload = JSON.stringify(projectSafePayload(job));
      if (hostname === url.hostname) return await postWebhook(url, address, payload, job.id);
      const normalizedUrl = new URL(url);
      normalizedUrl.hostname = hostname;
      return await postWebhook(normalizedUrl, address, payload, job.id);
    } catch (error) {
      if (error instanceof DeliveryFailure) return { accepted: false, retryable: error.retryable, errorCode: error.safeCode };
      return { accepted: false, retryable: true, errorCode: 'webhook_connection_error' };
    }
  }

  private async deliverEmail(job: ClaimedDelivery, recipient: string): Promise<SendOutcome> {
    const host = this.config.get<string>('SMTP_HOST')?.trim();
    const portText = this.config.get<string>('SMTP_PORT') ?? '1025';
    const from = this.config.get<string>('SMTP_FROM')?.trim();
    const port = Number(portText);
    if (!host || !from || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { accepted: false, retryable: false, errorCode: 'smtp_not_configured' };
    }
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASSWORD');
    if ((user && !pass) || (!user && pass)) {
      return { accepted: false, retryable: false, errorCode: 'smtp_not_configured' };
    }
    try {
      const secure = this.config.get<string>('SMTP_SECURE') === 'true';
      this.mailer ??= nodemailer.createTransport({
        host, port, secure,
        ...(user && pass ? { auth: { user, pass } } : {}),
        connectionTimeout: DELIVERY_TIMEOUT_MS,
        greetingTimeout: DELIVERY_TIMEOUT_MS,
        socketTimeout: DELIVERY_TIMEOUT_MS + 2_000,
        pool: false,
      });
      const payload = job.safe_payload;
      const title = printable(payload.title, 160) || 'Trace Ops 测试通知';
      const level = printable(payload.level, 16);
      const service = printable(payload.service, 120);
      const environment = printable(payload.environment, 16);
      const traceId = printable(payload.traceId, 128);
      const alertId = printable(payload.alertId, 36) || job.id;
      await this.mailer.sendMail({
        from,
        to: recipient,
        subject: `[Trace Ops] ${title}`,
        text: [
          'Trace Ops 告警通知',
          `事件：${job.event_type === 'test' ? '测试投递' : '告警'}`,
          `标题：${title}`,
          ...(level ? [`级别：${level}`] : []),
          ...(service ? [`服务：${service}`] : []),
          ...(environment ? [`环境：${environment}`] : []),
          ...(traceId ? [`Trace ID：${traceId}`] : []),
          `事件 ID：${alertId}`,
          `投递 ID：${job.id}`,
        ].join('\n'),
        headers: { 'X-Trace-Ops-Delivery-ID': job.id },
        messageId: `<${job.id}@trace-ops.local>`,
      });
      return { accepted: true, retryable: false, errorCode: null };
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code) : '';
      const errorCode = code === 'EAUTH' ? 'smtp_auth_error'
        : code === 'ETIMEDOUT' || code === 'ESOCKET' ? 'smtp_timeout'
          : code === 'EENVELOPE' ? 'smtp_recipient_rejected' : 'smtp_delivery_error';
      return { accepted: false, retryable: code !== 'EENVELOPE', errorCode };
    }
  }

  private async complete(job: ClaimedDelivery, outcome: SendOutcome): Promise<void> {
    if (outcome.accepted) {
      await this.database.query(
        `UPDATE alert_notification_deliveries
         SET status = 'sent', delivered_at = now(), next_attempt_at = NULL,
             last_error_code = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1::uuid AND status = 'sending' AND lease_token = $2::uuid`,
        [job.id, job.lease_token],
      );
      return;
    }
    const exhausted = !outcome.retryable || job.attempts_in_cycle >= job.max_attempts;
    const backoff = BACKOFF_SECONDS[Math.min(Math.max(job.attempts_in_cycle - 1, 0), BACKOFF_SECONDS.length - 1)]!;
    await this.database.query(
      `UPDATE alert_notification_deliveries
       SET status = $3::varchar(16),
           next_attempt_at = CASE WHEN $3::varchar(16) = 'retrying' THEN now() + ($4::text || ' seconds')::interval ELSE NULL END,
           last_error_code = $5::varchar(64), lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1::uuid AND status = 'sending' AND lease_token = $2::uuid`,
      [job.id, job.lease_token, exhausted ? 'failed' : 'retrying', backoff, outcome.errorCode ?? 'delivery_error'],
    );
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref?.();
    });
  }
}
