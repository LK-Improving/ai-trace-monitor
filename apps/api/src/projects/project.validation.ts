import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  PROJECT_KEY_SCOPE,
  ProjectKeyScope,
  ProjectKeyScopesSchema,
  ProjectPrivacyPolicyPatchSchema,
} from '@trace-ops/contracts';

export const ENVIRONMENTS = ['dev', 'staging', 'prod'] as const;
export type ProjectEnvironment = (typeof ENVIRONMENTS)[number];

export interface CreateProjectInput {
  name: string;
  slug: string;
  retentionDays: number;
}

export interface CreateServiceInput {
  name: string;
  environment: ProjectEnvironment;
  sdkVersion?: string;
}

export interface CreateProjectKeyInput {
  name: string;
  scopes: ProjectKeyScope[];
}

export interface ProjectPrivacyPolicyPatchInput {
  additionalRedactedFields?: string[];
  capturePromptResponse?: false;
}

export interface AuditLogsQuery {
  page: number;
  pageSize: number;
}

function invalidInput(): never {
  throw new BadRequestException('Invalid request input');
}

function asObject(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidInput();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !allowedKeys.includes(key))) return invalidInput();
  return input;
}

function requiredText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return invalidInput();
  const result = value.trim();
  if (result.length < 1 || result.length > maxLength || /[\u0000-\u001f\u007f]/u.test(result)) {
    return invalidInput();
  }
  return result;
}

export function parseProjectId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return invalidInput();
  }
  return value;
}

export function parseCreateProject(value: unknown): CreateProjectInput {
  const input = asObject(value, ['name', 'slug', 'retentionDays']);
  const name = requiredText(input.name, 120);
  const slug = requiredText(input.slug, 120);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return invalidInput();

  const retentionDays = input.retentionDays === undefined ? 30 : input.retentionDays;
  if (typeof retentionDays !== 'number' || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    return invalidInput();
  }
  return { name, slug, retentionDays };
}

export function parseCreateService(value: unknown): CreateServiceInput {
  const input = asObject(value, ['name', 'environment', 'sdkVersion']);
  const name = requiredText(input.name, 120);
  if (typeof input.environment !== 'string' || !ENVIRONMENTS.includes(input.environment as ProjectEnvironment)) {
    return invalidInput();
  }
  const sdkVersion = input.sdkVersion === undefined ? undefined : requiredText(input.sdkVersion, 64);
  return {
    name,
    environment: input.environment as ProjectEnvironment,
    ...(sdkVersion === undefined ? {} : { sdkVersion }),
  };
}

export function parseCreateProjectKey(value: unknown): CreateProjectKeyInput {
  const input = asObject(value, ['name', 'scopes']);
  const scopesValue = input.scopes === undefined ? [PROJECT_KEY_SCOPE] : input.scopes;
  const parsedScopes = ProjectKeyScopesSchema.safeParse(scopesValue);
  if (!parsedScopes.success) return invalidInput();
  return { name: requiredText(input.name, 120), scopes: parsedScopes.data };
}

export function parseProjectPrivacyPolicyPatch(value: unknown): ProjectPrivacyPolicyPatchInput {
  if (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'capturePromptResponse' in value
    && value.capturePromptResponse === true
  ) {
    throw new ForbiddenException('Prompt/Response capture is unavailable');
  }
  const parsed = ProjectPrivacyPolicyPatchSchema.safeParse(value);
  if (!parsed.success) return invalidInput();
  return parsed.data;
}

export function parseAuditLogsQuery(value: unknown): AuditLogsQuery {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidInput();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['page', 'pageSize'].includes(key))) return invalidInput();
  const parsePositiveInteger = (raw: unknown, fallback: number, maximum: number): number => {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^[1-9]\d{0,5}$/.test(raw)) return invalidInput();
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed > maximum) return invalidInput();
    return parsed;
  };
  const page = parsePositiveInteger(input.page, 1, 1000);
  const pageSize = parsePositiveInteger(input.pageSize, 50, 100);
  if ((page - 1) * pageSize > 10_000) return invalidInput();
  return { page, pageSize };
}
