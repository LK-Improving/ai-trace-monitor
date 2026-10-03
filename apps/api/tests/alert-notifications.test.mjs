import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const validation = require('../dist/alerts/alert-notifications.validation.js');
const notificationConfig = require('../dist/alerts/alert-notifications.config.js');
const crypto = require('../dist/alerts/alert-notifications.crypto.js');
const { AlertNotificationsService } = require('../dist/alerts/alert-notifications.service.js');
const { AlertNotificationWorker, validPublicAddress } = require('../dist/alerts/alert-notifications.worker.js');
const { AlertsController } = require('../dist/alerts/alerts.controller.js');
const { AdminTokenGuard } = require('../dist/admin/admin-token.guard.js');
const { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { RequestMethod } = require('@nestjs/common');

const projectId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const otherProjectId = 'b35a64bb-8a12-4806-9e77-8831870a5dd0';
const channelId = '123e4567-e89b-12d3-a456-426614174000';
const key = randomBytes(32);
const encodedKey = key.toString('base64');
const config = { get: (name) => ({
  ALERT_NOTIFICATION_ENCRYPTION_KEY: encodedKey,
  ALERT_NOTIFICATIONS_ALLOW_PRIVATE_TARGETS: 'false',
}[name]) };

function channelRow(overrides = {}) {
  const now = new Date('2026-10-03T04:05:06.000Z');
  return {
    id: channelId, project_id: projectId, name: 'On-call', channel_type: 'webhook',
    environment: 'prod', min_level: 'warning', enabled: true,
    target_ciphertext: crypto.encryptNotificationTarget('https://hooks.example.test/path', key),
    destination_hint: 'https://hooks.example.test/…', created_at: now, updated_at: now,
    ...overrides,
  };
}

test('notification target AES-GCM storage is authenticated and destination hints do not reveal secrets', () => {
  const target = 'https://hooks.example.test/path?token=private-canary';
  const envelope = crypto.encryptNotificationTarget(target, key);
  assert.notEqual(envelope, target);
  assert.equal(crypto.decryptNotificationTarget(envelope, key), target);
  assert.throws(() => crypto.decryptNotificationTarget(`${envelope.slice(0, -2)}xx`, key));
  assert.throws(() => crypto.notificationEncryptionKey({ get: () => '' }));
  assert.throws(() => crypto.notificationEncryptionKey({ get: () => randomBytes(16).toString('base64') }));
  assert.equal(crypto.notificationDestinationHint('webhook', target), 'https://hooks.example.test/…');
  assert.equal(crypto.notificationDestinationHint('email', 'oncall@example.test'), 'o•••@example.test');
  assert.equal(crypto.notificationDestinationHint('email', 'x@example.test'), 'x•••@example.test');
  assert.doesNotMatch(crypto.notificationDestinationHint('email', 'oncall@example.test'), /oncall/);
});

test('private notification targets require an explicit development or test environment opt-in', () => {
  const settings = (environment, enabled) => ({ get: (name) => ({
    NODE_ENV: environment,
    ALERT_NOTIFICATIONS_ALLOW_PRIVATE_TARGETS: enabled ? 'true' : 'false',
  }[name]) });
  assert.equal(notificationConfig.allowPrivateNotificationTargets(settings('development', true)), true);
  assert.equal(notificationConfig.allowPrivateNotificationTargets(settings('test', true)), true);
  assert.equal(notificationConfig.allowPrivateNotificationTargets(settings('production', true)), false);
  assert.equal(notificationConfig.allowPrivateNotificationTargets(settings(undefined, true)), false);
  assert.equal(notificationConfig.allowPrivateNotificationTargets(settings('development', false)), false);
});

test('channel parsers enforce exact types, project scope, and production HTTPS by default', () => {
  const webhook = {
    projectId, name: 'primary', type: 'webhook', environment: 'prod',
    minLevel: 'warning', enabled: true, webhookUrl: 'https://hooks.example.test/alerts',
  };
  assert.deepEqual(validation.parseCreateAlertChannel(webhook, false), webhook);
  assert.throws(() => validation.parseCreateAlertChannel({ ...webhook, projectId: 'invalid' }, false), { status: 400 });
  assert.throws(() => validation.parseCreateAlertChannel({ ...webhook, token: 'unexpected' }, false), { status: 400 });
  assert.throws(() => validation.parseCreateAlertChannel({ ...webhook, webhookUrl: 'http://127.0.0.1:9090/hook' }, false), { status: 400 });
  assert.equal(validation.parseCreateAlertChannel({ ...webhook, webhookUrl: 'http://127.0.0.1:9090/hook' }, true).webhookUrl,
    'http://127.0.0.1:9090/hook');
  assert.throws(() => validation.parsePatchAlertChannel({ projectId, type: 'email' }, false), { status: 400 });
  assert.equal(validation.parsePatchAlertChannel({ projectId, recipient: 'x@example.test' }, false).recipient, 'x@example.test');
  assert.equal(validation.parsePatchAlertChannel({ projectId, enabled: false }, false).enabled, false);
  assert.throws(() => validation.parseCreateAlertChannel({
    projectId, name: 'mail', type: 'email', environment: 'all', minLevel: 'info', enabled: true,
    recipient: 'not an email',
  }, false), { status: 400 });
});

test('delivery list parser bounds status and pagination and keeps project scope mandatory', () => {
  assert.deepEqual(validation.parseDeliveryListQuery({ projectId, status: 'failed', page: '2', pageSize: '25' }), {
    projectId, status: 'failed', page: 2, pageSize: 25, offset: 25,
  });
  for (const value of [
    {}, { projectId, status: 'unknown' }, { projectId, page: '0' },
    { projectId, page: '1001' }, { projectId, page: '102', pageSize: '100' },
    { projectId, extra: '1' },
  ]) assert.throws(() => validation.parseDeliveryListQuery(value), { status: 400 });
});

test('notification API routes remain behind AdminTokenGuard and expose only scoped endpoints', () => {
  assert(Reflect.getMetadata(GUARDS_METADATA, AlertsController).includes(AdminTokenGuard));
  assert.equal(Reflect.getMetadata(PATH_METADATA, AlertsController), 'alerts');
  for (const [method, path, verb] of [
    ['listChannels', 'channels', RequestMethod.GET],
    ['createChannel', 'channels', RequestMethod.POST],
    ['patchChannel', 'channels/:id', RequestMethod.PATCH],
    ['deleteChannel', 'channels/:id', RequestMethod.DELETE],
    ['testChannel', 'channels/:id/test', RequestMethod.POST],
    ['listDeliveries', 'deliveries', RequestMethod.GET],
    ['retryDelivery', 'deliveries/:id/retry', RequestMethod.POST],
  ]) {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AlertsController.prototype[method]), path);
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AlertsController.prototype[method]), verb);
  }
});

test('channel service encrypts create targets, returns only a masked hint, and scopes all reads by project', async () => {
  const stored = [];
  const row = channelRow();
  const queries = [];
  const database = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('FROM projects')) return { rows: [{ id: projectId }] };
      if (sql.includes('FROM alert_notification_channels')) return { rows: [row] };
      throw new Error('Unexpected query');
    },
    async transaction(operation) {
      return operation({
        async query(sql, values) {
          queries.push({ sql, values });
          if (sql.includes('SELECT id, project_id, name, channel_type')) return { rows: [row] };
          if (sql.includes('INSERT INTO alert_notification_channels')) {
            stored.push(values);
            return { rows: [channelRow({
              id: randomUUID(), name: values[1], target_ciphertext: values[6], destination_hint: values[7],
            })] };
          }
          throw new Error('Unexpected transaction query');
        },
      });
    },
  };
  const service = new AlertNotificationsService(database, config);
  const target = 'https://hooks.example.test/path?token=private-canary';
  const created = await service.createChannel({
    projectId, name: 'primary', type: 'webhook', environment: 'prod', minLevel: 'warning', enabled: true,
    webhookUrl: target,
  });
  assert.equal(created.destinationHint, 'https://hooks.example.test/…');
  assert.equal(created.hasSecret, true);
  assert.equal('webhookUrl' in created, false);
  assert.equal('targetCiphertext' in created, false);
  assert.equal(crypto.decryptNotificationTarget(stored[0][6], key), target);
  assert.notEqual(stored[0][6], target);
  assert.doesNotMatch(JSON.stringify(created), /private-canary|hooks\.example\.test\/path/);
  await assert.rejects(service.patchChannel(channelId, { projectId, recipient: 'x@example.test' }),
    (error) => error.getStatus() === 400);

  const listed = await service.listChannels({ projectId });
  assert.equal(listed.items[0].id, channelId);
  assert.equal('target_ciphertext' in listed.items[0], false);
  assert(queries.some(({ sql, values }) => sql.includes('project_id = $1') && values[0] === projectId));
});

test('manual retry rejects deleted channels and locks active channel before delivery', async () => {
  async function attempt(deletedAt) {
    const statements = [];
    const database = {
      async query(sql) {
        if (sql.includes('FROM projects')) return { rows: [{ id: projectId }] };
        throw new Error('Unexpected query');
      },
      async transaction(operation) {
        return operation({
          async query(sql, values) {
            statements.push({ sql, values });
            if (sql.includes('SELECT channel_id FROM alert_notification_deliveries')) {
              return { rows: [{ channel_id: channelId }] };
            }
            if (sql.includes('SELECT deleted_at FROM alert_notification_channels')) {
              return { rows: [{ deleted_at: deletedAt }] };
            }
            if (sql.includes('SELECT status, manual_retry_count, channel_id')) {
              return { rows: [{ status: 'failed', manual_retry_count: 0, channel_id: channelId }] };
            }
            if (sql.includes('UPDATE alert_notification_deliveries')) return { rowCount: 1, rows: [] };
            throw new Error('Unexpected transaction query');
          },
        });
      },
    };
    return { result: new AlertNotificationsService(database, config), statements };
  }

  const deleted = await attempt(new Date());
  await assert.rejects(deleted.result.retryDelivery(channelId, { projectId }), (error) => error.getStatus() === 409);
  assert(!deleted.statements.some(({ sql }) => sql.includes('UPDATE alert_notification_deliveries')));

  const active = await attempt(null);
  assert.deepEqual(await active.result.retryDelivery(channelId, { projectId }), { queued: true });
  const channelLock = active.statements.findIndex(({ sql }) => sql.includes('SELECT deleted_at FROM alert_notification_channels'));
  const deliveryLock = active.statements.findIndex(({ sql }) => sql.includes('SELECT status, manual_retry_count, channel_id'));
  assert(channelLock >= 0 && deliveryLock > channelLock, 'retry must lock channel before delivery');
});

test('webhook sender blocks private addresses by default and local HTTP requires an explicit test-only opt-in', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.20.1.1', '192.168.1.2', '224.0.0.1']) {
    assert.equal(validPublicAddress(address, 4), false, address);
  }
  for (const address of ['::1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(validPublicAddress(address, 6), false, address);
  assert.equal(validPublicAddress('8.8.8.8', 4), true);
  assert.equal(validPublicAddress('2606:4700:4700::1111', 6), true);

  const worker = new AlertNotificationWorker({}, { get: () => 'false' });
  const result = await worker.deliverWebhook({
    id: channelId, lease_token: randomUUID(), channel_type: 'webhook',
    target_ciphertext: '', event_type: 'test', safe_payload: {}, attempt_count: 1,
    attempts_in_cycle: 1, max_attempts: 5,
  }, 'https://127.0.0.1/private');
  assert.deepEqual(result, { accepted: false, retryable: false, errorCode: 'webhook_target_blocked' });
});
