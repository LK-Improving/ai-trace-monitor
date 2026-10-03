import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const projectId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const otherProjectId = 'b47ac10b-58cc-4372-a567-0e02b2c3d470';
const serviceId = 'a47ac10b-58cc-4372-a567-0e02b2c3d471';
const keyId = 'c47ac10b-58cc-4372-a567-0e02b2c3d472';
const createdAt = '2026-10-03T08:30:00.000Z';
const keyPlaintext = `tr_${'A'.repeat(43)}`;
const apiSource = await readFile(new URL('../src/project-settings-api.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(apiSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const fetchStub = `data:text/javascript,export function apiFetch(input, init) { return globalThis.__projectSettingsFetch(input, init); }`;
const runnable = outputText.replace("from './api'", `from '${fetchStub}'`);
const api = await import(`data:text/javascript;base64,${Buffer.from(runnable).toString('base64')}`);
const settingsSourceText = await readFile(new URL('../src/settings-source.ts', import.meta.url), 'utf8');
const settingsSourceOutput = ts.transpileModule(settingsSourceText, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const settingsSource = await import(`data:text/javascript;base64,${Buffer.from(settingsSourceOutput).toString('base64')}`);

function service(overrides = {}) {
  return {
    id: serviceId,
    projectId,
    name: 'assistant-api',
    environment: 'prod',
    sdkVersion: null,
    createdAt,
    ...overrides,
  };
}

function projectKey(overrides = {}) {
  return {
    id: keyId,
    projectId,
    name: 'production-ingest',
    keyPrefix: 'tr_12345678',
    scopes: ['spans:write'],
    lastUsedAt: null,
    revokedAt: null,
    createdAt,
    ...overrides,
  };
}

function setApiFetch(handler) {
  const previous = globalThis.__projectSettingsFetch;
  globalThis.__projectSettingsFetch = handler;
  return () => {
    if (previous === undefined) delete globalThis.__projectSettingsFetch;
    else globalThis.__projectSettingsFetch = previous;
  };
}

async function withApiFetch(handler, callback) {
  const restore = setApiFetch(handler);
  try { await callback(); } finally { restore(); }
}

test('service response parsing enforces shape, environment, and requested project', () => {
  assert.deepEqual(api.parseProjectServicesPayload([service()], projectId), [service()]);
  assert.equal(api.parseProjectServicesPayload([service({ name: 'api' }), service({ id: keyId, name: 'API' })], projectId).length, 2);
  for (const invalid of [
    [{ ...service(), projectId: otherProjectId }],
    [{ ...service(), environment: 'production' }],
    [{ ...service(), createdAt: 'not-a-time' }],
    [{ ...service(), name: '  padded  ' }],
    [service(), service({ id: keyId })],
    { items: [service()] },
  ]) assert.throws(() => api.parseProjectServicesPayload(invalid, projectId), api.ProjectSettingsApiError);
});

test('privacy parser keeps capture disabled and rejects duplicate or unsafe field entries', () => {
  const valid = { projectId, capturePromptResponse: false, additionalRedactedFields: ['customer_email'] };
  assert.deepEqual(api.parseProjectPrivacyPayload(valid, projectId), valid);
  assert.deepEqual(api.normalizeAdditionalRedactedFields(['Customer_Email', 'A-1']), ['customer_email', 'a-1']);
  for (const invalid of [
    { ...valid, projectId: otherProjectId },
    { ...valid, capturePromptResponse: true },
    { ...valid, additionalRedactedFields: ['email', 'EMAIL'] },
    { ...valid, additionalRedactedFields: ['customer.email'] },
    { ...valid, additionalRedactedFields: ['_password'] },
    { ...valid, additionalRedactedFields: ['a'.repeat(65)] },
    { ...valid, additionalRedactedFields: [42] },
    { ...valid, additionalRedactedFields: Array.from({ length: 65 }, (_, index) => `field${index}`) },
  ]) assert.throws(() => api.parseProjectPrivacyPayload(invalid, projectId), api.ProjectSettingsApiError);
  for (const fields of [
    ['customer.email'], ['_private'], ['a'.repeat(65)], ['Email', 'email'],
    Array.from({ length: 65 }, (_, index) => `field${index}`),
  ]) assert.throws(() => api.normalizeAdditionalRedactedFields(fields), TypeError);
  assert.equal(api.isValidAdditionalRedactedField('customer_email'), true);
  assert.equal(api.isValidAdditionalRedactedField('customer.email'), false);
  assert.equal(api.isValidAdditionalRedactedField('a'.repeat(65)), false);
  assert.equal(api.normalizeAdditionalRedactedFields(['A'.repeat(64)])[0], 'a'.repeat(64));
});

test('key response parser rejects cross-project rows, invalid scopes, and plaintext in list responses', () => {
  assert.deepEqual(api.parseProjectKeysPayload([projectKey()], projectId), [projectKey()]);
  for (const invalid of [
    [projectKey({ projectId: otherProjectId })],
    [projectKey({ scopes: ['spans:write', 'spans:write'] })],
    [projectKey({ scopes: ['trace:content:read'] })],
    [projectKey({ key: keyPlaintext })],
    [projectKey({ keyPrefix: keyPlaintext })],
  ]) assert.throws(() => api.parseProjectKeysPayload(invalid, projectId), api.ProjectSettingsApiError);

  const created = api.parseCreatedProjectKeyPayload({ ...projectKey({ scopes: ['trace:read'] }), key: keyPlaintext }, projectId);
  assert.equal(created.key, keyPlaintext);
  assert.deepEqual(created.scopes, ['trace:read']);
  assert.throws(() => api.parseCreatedProjectKeyPayload({ ...projectKey(), key: 'tr_short' }, projectId), api.ProjectSettingsApiError);
  assert.throws(() => api.parseProjectKeysPayload([projectKey({ scopes: ['spans:write', 'trace:read'] })], projectId), api.ProjectSettingsApiError);
  assert.throws(() => api.parseCreatedProjectKeyPayload({ ...projectKey({ scopes: ['spans:write', 'trace:read'] }), key: keyPlaintext }, projectId), api.ProjectSettingsApiError);
});

test('audit parser matches the backend page envelope and renders only safe action/resource metadata', () => {
  const record = { id: '123456789', actorId: 'platform_admin', action: 'project_key.rotated', resource: `project_key:${keyId}`, createdAt, details: { key: keyPlaintext } };
  const payload = { items: [record], total: 1, page: 1, pageSize: 20 };
  const parsed = api.parseProjectAuditPayload(payload);
  assert.deepEqual(parsed, [{ id: record.id, action: 'project_key.rotated', resource: 'project_key', createdAt }]);
  assert.equal(JSON.stringify(parsed).includes(keyPlaintext), false);
  assert.equal('actorId' in parsed[0], false);
  assert.equal('details' in parsed[0], false);
  const actualActions = [
    'project_key.created', 'project_key.rotated', 'project_key.revoked',
    'project_privacy_policy.updated', 'service.created',
  ];
  const actualResources = [
    `project_key:${keyId}`, `service:${serviceId}`, 'project_privacy_policy',
    'unknown', `service:${serviceId}`,
  ];
  const actualRecords = actualActions.map((action, index) => ({
    id: String(index + 1), actorId: 'system', action, resource: actualResources[index], createdAt,
  }));
  for (const item of actualRecords) {
    assert.doesNotThrow(() => api.parseProjectAuditPayload({ items: [item], total: 1, page: 1, pageSize: 20 }), item.action);
  }
  const mapped = api.parseProjectAuditPayload({
    items: actualRecords,
    total: 5, page: 1, pageSize: 20,
  });
  assert.deepEqual(mapped.map(({ resource }) => resource), ['project_key', 'service', 'project_privacy_policy', 'unknown', 'service']);
  for (const invalid of [
    { ...payload, items: [{ ...record, id: serviceId }] },
    { ...payload, items: [{ ...record, actorId: 'alice@example.com' }] },
    { ...payload, items: [{ ...record, action: 'updated: key=secret' }] },
    { ...payload, items: [{ ...record, action: 'project.key.rotated' }] },
    { ...payload, items: [{ ...record, resource: 'project_key:secret-value-not-uuid' }] },
    { ...payload, page: 2 },
    { ...payload, pageSize: 50 },
    { ...payload, total: 0 },
    { ...payload, items: Array.from({ length: 21 }, (_, index) => ({ ...record, id: String(index + 1) })), total: 21 },
  ]) assert.throws(() => api.parseProjectAuditPayload(invalid), api.ProjectSettingsApiError);
});

test('management methods send only contract payloads through same-origin fetch and never send browser Authorization', async () => {
  const seen = [];
  await withApiFetch(async (path, init = {}) => {
    seen.push({ path, init });
    const method = init.method ?? 'GET';
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (path.includes('/audit-logs')) return Response.json({ items: [], total: 0, page: 1, pageSize: 20 });
    if (path.endsWith('/privacy')) return Response.json({ projectId, capturePromptResponse: false, additionalRedactedFields: ['email'] });
    if (path.endsWith('/services') && method === 'POST') return Response.json(service({ name: 'assistant-api', environment: 'dev' }));
    if (path.endsWith('/services')) return Response.json([service()]);
    if (path.endsWith(`/keys/${keyId}/rotate`)) return Response.json({ ...projectKey({ scopes: ['trace:read'] }), name: 'rotated', key: keyPlaintext });
    if (path.endsWith('/keys') && method === 'POST') return Response.json({ ...projectKey({ scopes: JSON.parse(init.body).scopes }), key: keyPlaintext });
    if (path.endsWith('/keys')) return Response.json([projectKey()]);
    throw new Error(`unexpected request ${method} ${path}`);
  }, async () => {
    assert.deepEqual(await api.fetchProjectServices(projectId), [service()]);
    await api.createProjectService(projectId, { name: 'assistant-api', environment: 'dev' });
    await api.updateProjectPrivacy(projectId, ['Email']);
    await api.fetchProjectPrivacy(projectId);
    await api.fetchProjectKeys(projectId);
    await api.createProjectKey(projectId, 'read-only', ['trace:read']);
    await api.rotateProjectKey(projectId, keyId);
    await api.revokeProjectKey(projectId, keyId);
    await api.fetchProjectAudit(projectId);
  });

  const serviceCreate = seen.find(({ path, init }) => path.endsWith('/services') && init.method === 'POST');
  assert.deepEqual(JSON.parse(serviceCreate.init.body), { name: 'assistant-api', environment: 'dev' });
  const privacyPatch = seen.find(({ path, init }) => path.endsWith('/privacy') && init.method === 'PATCH');
  assert.deepEqual(JSON.parse(privacyPatch.init.body), { additionalRedactedFields: ['email'] });
  const keyCreate = seen.find(({ path, init }) => path.endsWith('/keys') && init.method === 'POST');
  assert.deepEqual(JSON.parse(keyCreate.init.body), { name: 'read-only', scopes: ['trace:read'] });
  await assert.rejects(api.createProjectKey(projectId, 'combined', ['spans:write', 'trace:read']), TypeError);
  const rotate = seen.find(({ path }) => path.endsWith('/keys/' + keyId + '/rotate'));
  assert.equal(rotate.init.method, 'POST');
  assert.equal(rotate.init.body, undefined);
  assert.equal(seen.find(({ path }) => path.includes('/audit-logs')).path, `/api/v1/projects/${projectId}/audit-logs?page=1&pageSize=20`);
  for (const { init } of seen) assert.equal(new Headers(init.headers).has('authorization'), false);
});

test('HTTP failures and malformed JSON reject instead of reporting success', async () => {
  await withApiFetch(async () => new Response(JSON.stringify({ secret: keyPlaintext }), { status: 404 }), async () => {
    await assert.rejects(api.fetchProjectKeys(projectId), (error) => error instanceof api.ProjectSettingsApiError && error.status === 404);
  });
  await withApiFetch(async () => new Response('not-json', { status: 200 }), async () => {
    await assert.rejects(api.fetchProjectKeys(projectId), api.ProjectSettingsApiError);
  });
});

test('project-switch and abort guards prevent stale async results from updating the active project', () => {
  const controller = new AbortController();
  assert.equal(api.isCurrentProjectRequest(projectId, projectId, controller.signal), true);
  assert.equal(api.isCurrentProjectRequest(projectId, otherProjectId, controller.signal), false);
  controller.abort();
  assert.equal(api.isCurrentProjectRequest(projectId, projectId, controller.signal), false);
});

test('settings source badge reports API-backed tabs accurately', () => {
  for (const tab of ['services', 'privacy', 'access', 'notifications']) {
    assert.equal(settingsSource.isApiBackedSettingsTab(tab), true, `${tab} is API-backed`);
  }
  for (const tab of ['project', 'retention']) {
    assert.equal(settingsSource.isApiBackedSettingsTab(tab), false, `${tab} remains a non-API placeholder`);
  }
});

test('project settings remount on project change and abort outstanding mutations', async () => {
  const pages = await readFile(new URL('../src/pages/Pages.tsx', import.meta.url), 'utf8');
  const component = await readFile(new URL('../src/pages/ProjectSettingsPanels.tsx', import.meta.url), 'utf8');
  const apiText = await readFile(new URL('../src/project-settings-api.ts', import.meta.url), 'utf8');
  assert.match(pages, /ProjectServicesSettings key=\{projectId\}/);
  assert.match(pages, /ProjectPrivacySettings key=\{projectId\}/);
  assert.match(pages, /ProjectCredentialsSettings key=\{projectId\}/);
  assert.match(component, /useEffect\(\(\) => \(\) => controller\.current\?\.abort\(\), \[\]\)/);
  assert.ok(component.includes('const [oneTimeCredential, setOneTimeCredential] = useState<{ projectId: string; name: string; secret: string } | null>(null);'));
  assert.ok(component.includes("const [confirmation, setConfirmation] = useState<{ action: 'rotate' | 'revoke'; key: ProjectKey } | null>(null);"));
  for (const action of ['project_key.created', 'project_key.rotated', 'project_key.revoked', 'project_privacy_policy.updated', 'service.created']) {
    assert.ok(component.includes(`'${action}':`), `missing safe audit label for ${action}`);
  }
  assert.match(component, /function resourceLabel\(resource: ProjectAuditRecord\['resource'\]\)/);
  assert.doesNotMatch(component, /resourceLabel\(item\.resourceType\)/);
  assert.doesNotMatch(component, /(?:localStorage|sessionStorage)\s*\.\s*(?:setItem|removeItem|clear)/);
  assert.doesNotMatch(apiText, /(?:localStorage|sessionStorage)\s*\.\s*(?:setItem|removeItem|clear)/);
});
