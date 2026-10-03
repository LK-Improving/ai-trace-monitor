import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/alert-notifications-api.ts', import.meta.url), 'utf8');
const apiStub = `data:text/javascript;base64,${Buffer.from(
  'export function apiFetch(input, init) { return globalThis.fetch(input, init); }',
).toString('base64')}`;
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replaceAll("'./api'", `'${apiStub}'`);
const api = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
const projectId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const channelId = '123e4567-e89b-12d3-a456-426614174000';
const deliveryId = 'b35a64bb-8a12-4806-9e77-8831870a5dd0';
const now = '2026-10-03T04:05:06.000Z';
const channel = {
  id: channelId, projectId, name: 'On-call', type: 'webhook', environment: 'prod',
  minLevel: 'warning', enabled: true, destinationHint: 'https://hooks.example.test/…',
  hasSecret: true, createdAt: now, updatedAt: now,
};
const delivery = {
  id: deliveryId, channelId, channelName: 'On-call', channelType: 'webhook', eventType: 'test',
  alertId: null, alertTitle: 'Trace Ops 测试通知', level: null, service: 'trace-ops',
  environment: null, traceId: null, status: 'sent', attemptCount: 1, nextAttemptAt: null,
  lastAttemptAt: now, deliveredAt: now, lastErrorCode: null, createdAt: now,
};

test('channel and delivery APIs use scoped same-origin routes and do not parse mutation responses', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ url: String(input), init });
    if (String(input).includes('/deliveries?')) return new Response(JSON.stringify({ items: [delivery], total: 1, page: 1, pageSize: 20 }));
    if (String(input).includes('/channels?')) return new Response(JSON.stringify({ items: [channel] }));
    return new Response('', { status: 202 });
  };
  try {
    assert.deepEqual(await api.fetchAlertChannels(projectId), [channel]);
    await api.createAlertChannel({
      projectId, name: 'Primary', type: 'webhook', environment: 'prod', minLevel: 'warning',
      enabled: true, webhookUrl: 'https://hooks.example.test/alerts',
    });
    await api.patchAlertChannel(channelId, { projectId, enabled: false });
    await api.testAlertChannel(channelId, projectId);
    await api.deleteAlertChannel(channelId, projectId);
    assert.deepEqual(await api.fetchAlertDeliveries({ projectId, status: 'all', page: 1, pageSize: 20 }), {
      items: [delivery], total: 1, page: 1, pageSize: 20,
    });
    await api.retryAlertDelivery(deliveryId, projectId);

    assert.equal(requests[0].url, `/api/v1/alerts/channels?projectId=${projectId}`);
    assert.equal(requests[1].init.method, 'POST');
    assert.equal(JSON.parse(requests[1].init.body).webhookUrl, 'https://hooks.example.test/alerts');
    assert.equal(requests[2].init.method, 'PATCH');
    assert.equal(requests[3].init.method, 'POST');
    assert.equal(requests[4].init.method, 'DELETE');
    assert.match(requests[4].url, new RegExp(`projectId=${projectId}`));
    assert.match(requests[5].url, /status=all/);
    assert.equal(requests[6].init.method, 'POST');
  } finally { globalThis.fetch = originalFetch; }
});

test('notification response parser rejects leaked channel destinations and malformed delivery rows', () => {
  assert.throws(() => api.parseAlertChannelsPayload({ items: [{ ...channel, webhookUrl: 'https://secret.invalid' }] }, projectId),
    /接口响应与约定不一致/);
  assert.throws(() => api.parseAlertDeliveriesPayload({
    items: [{ ...delivery, lastErrorCode: 'internal response recipient=private@example.test' }],
    total: 1, page: 1, pageSize: 20,
  }, { page: 1, pageSize: 20 }), /接口响应与约定不一致/);
});
