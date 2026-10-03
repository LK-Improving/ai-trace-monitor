import { apiFetch } from './api';

export const PROJECT_ENVIRONMENTS = ['dev', 'staging', 'prod'] as const;
export type ProjectEnvironment = (typeof PROJECT_ENVIRONMENTS)[number];

export const PROJECT_KEY_SCOPES = ['spans:write', 'trace:read'] as const;
export type ProjectKeyScope = (typeof PROJECT_KEY_SCOPES)[number];

export interface ProjectService {
  id: string;
  projectId: string;
  name: string;
  environment: ProjectEnvironment;
  sdkVersion: string | null;
  createdAt: string;
}

export interface ProjectPrivacyPolicy {
  projectId: string;
  capturePromptResponse: false;
  additionalRedactedFields: string[];
}

export interface ProjectKey {
  id: string;
  projectId: string;
  name: string;
  keyPrefix: string;
  scopes: ProjectKeyScope[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedProjectKey extends ProjectKey {
  key: string;
}

export interface ProjectAuditRecord {
  id: string;
  action: string;
  resource: 'project_key' | 'service' | 'project_privacy_policy' | 'unknown';
  createdAt: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^tr_[A-Za-z0-9_-]{43}$/;
const KEY_PREFIX_PATTERN = /^tr_[A-Za-z0-9_-]{8}$/;
const ADDITIONAL_REDACTED_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CANONICAL_REDACTED_FIELD_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const AUDIT_ACTIONS = new Set([
  'project_key.created',
  'project_key.rotated',
  'project_key.revoked',
  'project_privacy_policy.updated',
  'service.created',
  'other',
]);

export function isValidAdditionalRedactedField(value: unknown): value is string {
  return typeof value === 'string' && ADDITIONAL_REDACTED_FIELD_PATTERN.test(value);
}

export class ProjectSettingsApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ProjectSettingsApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isEnvironment(value: unknown): value is ProjectEnvironment {
  return typeof value === 'string' && (PROJECT_ENVIRONMENTS as readonly string[]).includes(value);
}

function isScope(value: unknown): value is ProjectKeyScope {
  return typeof value === 'string' && (PROJECT_KEY_SCOPES as readonly string[]).includes(value);
}

function invalidResponse(): ProjectSettingsApiError {
  return new ProjectSettingsApiError('项目配置接口响应格式与约定不一致，请联系后端确认。');
}

function assertProjectId(projectId: string): void {
  if (!UUID_PATTERN.test(projectId)) throw new TypeError('Invalid project settings projectId');
}

function statusMessage(status: number): string {
  if (status === 401) return '未授权（401）：请检查本地 Vite 服务端的 PLATFORM_ADMIN_TOKEN 配置；令牌不会保存在浏览器。';
  if (status === 403) return '当前管理凭证无权执行此项目配置操作（403）。';
  if (status === 404) return '项目配置接口暂不可用（404），请确认后端已提供对应接口。';
  if (status === 409) return '配置与现有记录冲突，请检查名称或当前凭证状态。';
  if (status >= 500) return `项目配置服务暂时不可用（HTTP ${status}），请稍后重试。`;
  return `项目配置请求失败（HTTP ${status}）。`;
}

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await apiFetch(path, init);
  } catch {
    if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    throw new ProjectSettingsApiError('无法连接项目配置 API，请确认本地 API 已启动后重试。');
  }
  if (!response.ok) throw new ProjectSettingsApiError(statusMessage(response.status), response.status);
  try {
    return await response.json() as unknown;
  } catch {
    throw invalidResponse();
  }
}

async function mutate(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await apiFetch(path, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      signal,
    });
  } catch {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    throw new ProjectSettingsApiError('无法连接项目配置 API，请确认本地 API 已启动后重试。');
  }
  if (!response.ok) throw new ProjectSettingsApiError(statusMessage(response.status), response.status);
  return response;
}

function projectPath(projectId: string, resource: string): string {
  assertProjectId(projectId);
  return `/api/v1/projects/${encodeURIComponent(projectId)}/${resource}`;
}

function parseService(value: unknown, expectedProjectId: string): ProjectService {
  if (!isRecord(value) || !UUID_PATTERN.test(String(value.id)) || value.projectId !== expectedProjectId
    || !isText(value.name, 120) || !isEnvironment(value.environment)
    || !(value.sdkVersion === null || isText(value.sdkVersion, 64)) || !isTimestamp(value.createdAt)) {
    throw invalidResponse();
  }
  return {
    id: value.id as string,
    projectId: expectedProjectId,
    name: value.name,
    environment: value.environment,
    sdkVersion: value.sdkVersion,
    createdAt: value.createdAt,
  };
}

export function parseProjectServicesPayload(value: unknown, expectedProjectId: string): ProjectService[] {
  assertProjectId(expectedProjectId);
  if (!Array.isArray(value) || value.length > 2_000) throw invalidResponse();
  const services = value.map((item) => parseService(item, expectedProjectId));
  const identities = new Set<string>();
  for (const service of services) {
    // PostgreSQL UNIQUE(project_id, name, environment) is case-sensitive.
    const identity = `${service.environment}\u0000${service.name}`;
    if (identities.has(identity)) throw invalidResponse();
    identities.add(identity);
  }
  return services;
}

export function parseProjectPrivacyPayload(value: unknown, expectedProjectId: string): ProjectPrivacyPolicy {
  assertProjectId(expectedProjectId);
  if (!isRecord(value) || value.projectId !== expectedProjectId || value.capturePromptResponse !== false
    || !Array.isArray(value.additionalRedactedFields) || value.additionalRedactedFields.length > 64) {
    throw invalidResponse();
  }
  const fields: string[] = [];
  const normalized = new Set<string>();
  for (const field of value.additionalRedactedFields) {
    if (typeof field !== 'string' || !CANONICAL_REDACTED_FIELD_PATTERN.test(field)) throw invalidResponse();
    const key = field.toLocaleLowerCase('en-US');
    if (normalized.has(key)) throw invalidResponse();
    normalized.add(key);
    fields.push(field);
  }
  return { projectId: expectedProjectId, capturePromptResponse: false, additionalRedactedFields: fields };
}

function parseProjectKeyMetadata(value: unknown, expectedProjectId: string): ProjectKey {
  if (!isRecord(value) || !UUID_PATTERN.test(String(value.id)) || value.projectId !== expectedProjectId
    || !isText(value.name, 120) || typeof value.keyPrefix !== 'string' || !KEY_PREFIX_PATTERN.test(value.keyPrefix)
    || !Array.isArray(value.scopes) || value.scopes.length !== 1
    || !value.scopes.every(isScope) || new Set(value.scopes).size !== value.scopes.length
    || !(value.lastUsedAt === null || isTimestamp(value.lastUsedAt))
    || !(value.revokedAt === null || isTimestamp(value.revokedAt)) || !isTimestamp(value.createdAt)
    || 'key' in value || 'secret' in value || 'token' in value) {
    throw invalidResponse();
  }
  return {
    id: value.id as string,
    projectId: expectedProjectId,
    name: value.name,
    keyPrefix: value.keyPrefix,
    scopes: [...value.scopes] as ProjectKeyScope[],
    lastUsedAt: value.lastUsedAt as string | null,
    revokedAt: value.revokedAt as string | null,
    createdAt: value.createdAt,
  };
}

export function parseProjectKeysPayload(value: unknown, expectedProjectId: string): ProjectKey[] {
  assertProjectId(expectedProjectId);
  if (!Array.isArray(value) || value.length > 2_000) throw invalidResponse();
  const keys = value.map((item) => parseProjectKeyMetadata(item, expectedProjectId));
  if (new Set(keys.map((key) => key.id)).size !== keys.length) throw invalidResponse();
  return keys;
}

export function parseCreatedProjectKeyPayload(value: unknown, expectedProjectId: string): CreatedProjectKey {
  assertProjectId(expectedProjectId);
  if (!isRecord(value) || typeof value.key !== 'string' || !KEY_PATTERN.test(value.key)) throw invalidResponse();
  const { key: secret, ...metadata } = value;
  return { ...parseProjectKeyMetadata(metadata, expectedProjectId), key: secret };
}

export function normalizeAdditionalRedactedFields(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) throw new TypeError('Invalid project privacy fields');
  const normalized = new Set<string>();
  const fields: string[] = [];
  for (const field of value) {
    if (!isValidAdditionalRedactedField(field)) {
      throw new TypeError('Invalid project privacy fields');
    }
    const canonical = field.toLocaleLowerCase('en-US');
    if (normalized.has(canonical)) throw new TypeError('Invalid project privacy fields');
    normalized.add(canonical);
    fields.push(canonical);
  }
  return fields;
}

function normalizeAuditResource(value: unknown): ProjectAuditRecord['resource'] | undefined {
  if (value === 'project_privacy_policy') return 'project_privacy_policy';
  if (value === 'unknown') return 'unknown';
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^(project_key|service):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1].toLowerCase() as 'project_key' | 'service' : undefined;
}

export function parseProjectAuditPayload(value: unknown): ProjectAuditRecord[] {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 20
    || typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0 || value.page !== 1 || value.pageSize !== 20
    || value.items.length > (value.total as number)) throw invalidResponse();
  const items = value.items;
  const ids = new Set<string>();
  return items.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !/^\d{1,19}$/.test(item.id)
      || !['platform_admin', 'system'].includes(String(item.actorId))
      || typeof item.action !== 'string' || !AUDIT_ACTIONS.has(item.action)
      || !normalizeAuditResource(item.resource) || !isTimestamp(item.createdAt)) {
      throw invalidResponse();
    }
    const id = item.id as string;
    if (ids.has(id)) throw invalidResponse();
    ids.add(id);
    // Resource identifiers and actor IDs stay out of the UI; only the safe category is exposed.
    return { id, action: item.action, resource: normalizeAuditResource(item.resource)!, createdAt: item.createdAt };
  });
}

export async function fetchProjectServices(projectId: string, signal?: AbortSignal): Promise<ProjectService[]> {
  return parseProjectServicesPayload(await requestJson(projectPath(projectId, 'services'), { signal }), projectId);
}

export async function createProjectService(
  projectId: string,
  input: { name: string; environment: ProjectEnvironment },
  signal?: AbortSignal,
): Promise<ProjectService> {
  assertProjectId(projectId);
  if (!isText(input.name, 120) || !isEnvironment(input.environment)) throw new TypeError('Invalid project service fields');
  const response = await requestJson(projectPath(projectId, 'services'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: input.name, environment: input.environment }),
    signal,
  });
  return parseService(response, projectId);
}

export async function fetchProjectPrivacy(projectId: string, signal?: AbortSignal): Promise<ProjectPrivacyPolicy> {
  return parseProjectPrivacyPayload(await requestJson(projectPath(projectId, 'privacy'), { signal }), projectId);
}

export async function updateProjectPrivacy(
  projectId: string,
  additionalRedactedFields: string[],
  signal?: AbortSignal,
): Promise<ProjectPrivacyPolicy> {
  assertProjectId(projectId);
  const fields = normalizeAdditionalRedactedFields(additionalRedactedFields);
  const response = await requestJson(projectPath(projectId, 'privacy'), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ additionalRedactedFields: fields }),
    signal,
  });
  return parseProjectPrivacyPayload(response, projectId);
}

export async function fetchProjectKeys(projectId: string, signal?: AbortSignal): Promise<ProjectKey[]> {
  return parseProjectKeysPayload(await requestJson(projectPath(projectId, 'keys'), { signal }), projectId);
}

export async function createProjectKey(
  projectId: string,
  name: string,
  scopes: ProjectKeyScope[],
  signal?: AbortSignal,
): Promise<CreatedProjectKey> {
  assertProjectId(projectId);
  if (!isText(name, 120) || scopes.length !== 1
    || !scopes.every(isScope) || new Set(scopes).size !== scopes.length) {
    throw new TypeError('Invalid project key fields');
  }
  const response = await requestJson(projectPath(projectId, 'keys'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, scopes }),
    signal,
  });
  return parseCreatedProjectKeyPayload(response, projectId);
}

export async function rotateProjectKey(projectId: string, keyId: string, signal?: AbortSignal): Promise<CreatedProjectKey> {
  assertProjectId(projectId);
  if (!UUID_PATTERN.test(keyId)) throw new TypeError('Invalid project key id');
  const response = await requestJson(projectPath(projectId, `keys/${encodeURIComponent(keyId)}/rotate`), {
    method: 'POST',
    signal,
  });
  return parseCreatedProjectKeyPayload(response, projectId);
}

export async function revokeProjectKey(projectId: string, keyId: string, signal?: AbortSignal): Promise<void> {
  assertProjectId(projectId);
  if (!UUID_PATTERN.test(keyId)) throw new TypeError('Invalid project key id');
  await mutate(projectPath(projectId, `keys/${encodeURIComponent(keyId)}`), 'DELETE', undefined, signal);
}

export async function fetchProjectAudit(projectId: string, signal?: AbortSignal): Promise<ProjectAuditRecord[]> {
  return parseProjectAuditPayload(
    await requestJson(`${projectPath(projectId, 'audit-logs')}?page=1&pageSize=20`, { signal }),
  );
}

/** Guard async UI updates against both cancellation and a changed project selection. */
export function isCurrentProjectRequest(requestProjectId: string, activeProjectId: string, signal: AbortSignal): boolean {
  return requestProjectId === activeProjectId && !signal.aborted;
}
