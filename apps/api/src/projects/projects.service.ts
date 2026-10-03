import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { createProjectKeyMaterial } from './project-key';
import {
  AuditLogsQuery,
  CreateProjectInput,
  CreateProjectKeyInput,
  CreateServiceInput,
  ProjectPrivacyPolicyPatchInput,
  parseAuditLogsQuery,
  parseCreateProject,
  parseCreateProjectKey,
  parseCreateService,
  parseProjectPrivacyPolicyPatch,
  parseProjectId,
} from './project.validation';

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  retention_days: number;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ServiceRow {
  id: string;
  project_id: string;
  name: string;
  environment: string;
  sdk_version: string | null;
  created_at: Date | string;
}

interface ProjectKeyRow {
  id: string;
  project_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
}

interface RevokedKeyRow {
  id: string;
  revoked_at: Date | string;
}

interface RotatedProjectKeyRow extends ProjectKeyRow {
  old_key_id: string;
}

interface ProjectPrivacyPolicyRow {
  project_id: string;
  additional_redacted_fields: string[];
  capture_prompt_response: boolean;
  updated_at: Date | string;
}

interface AuditLogRow {
  id: string | number;
  actor_id: string | null;
  action: string;
  resource: string;
  created_at: Date | string;
}

interface AuditLogListRow {
  total: string | number;
  id: string | number | null;
  actor_id: string | null;
  action: string | null;
  resource: string | null;
  created_at: Date | string | null;
}

const AUDIT_ACTIONS = new Set([
  'project_key.created',
  'project_key.rotated',
  'project_key.revoked',
  'project_privacy_policy.updated',
  'service.created',
]);

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function translateDatabaseError(error: unknown): never {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  if (code === '23505') throw new ConflictException('Resource already exists');
  if (code === '23503') throw new NotFoundException('Project not found');
  if (code === '22P02' || code === '22001' || code === '23514' || code === '22003') {
    throw new BadRequestException('Invalid request input');
  }
  if (
    code.startsWith('08') ||
    ['42P01', '53300', '53400', '57P01', '57P02', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'EPIPE'].includes(code)
  ) {
    throw new ServiceUnavailableException('Database is unavailable');
  }
  if (error instanceof Error && /connection terminated|pool is closed/i.test(error.message)) {
    throw new ServiceUnavailableException('Database is unavailable');
  }
  throw new InternalServerErrorException('Request could not be completed');
}

@Injectable()
export class ProjectsService {
  constructor(private readonly database: DatabaseService) {}

  async listProjects() {
    try {
      const result = await this.database.query<ProjectRow>(
        `SELECT id, name, slug, retention_days, status, created_at, updated_at
         FROM projects ORDER BY created_at DESC, id ASC`,
      );
      return result.rows.map((row) => this.projectResponse(row));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async createProject(value: unknown) {
    const input: CreateProjectInput = parseCreateProject(value);
    try {
      const result = await this.database.query<ProjectRow>(
        `INSERT INTO projects (name, slug, retention_days)
         VALUES ($1, $2, $3)
         RETURNING id, name, slug, retention_days, status, created_at, updated_at`,
        [input.name, input.slug, input.retentionDays],
      );
      return this.projectResponse(result.rows[0]);
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async listServices(projectIdValue: string) {
    const projectId = parseProjectId(projectIdValue);
    await this.requireProject(projectId);
    try {
      const result = await this.database.query<ServiceRow>(
        `SELECT id, project_id, name, environment, sdk_version, created_at
         FROM services WHERE project_id = $1
         ORDER BY environment ASC, name ASC, id ASC`,
        [projectId],
      );
      return result.rows.map((row) => this.serviceResponse(row));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async createService(projectIdValue: string, value: unknown) {
    const projectId = parseProjectId(projectIdValue);
    const input: CreateServiceInput = parseCreateService(value);
    await this.requireProject(projectId);
    try {
      const result = await this.database.query<ServiceRow>(
        `WITH created AS (
           INSERT INTO services (project_id, name, environment, sdk_version)
           VALUES ($1, $2, $3, $4)
           RETURNING id, project_id, name, environment, sdk_version, created_at
         ), audited AS (
           INSERT INTO audit_logs (project_id, actor_id, action, resource, details)
           SELECT project_id, 'platform_admin', 'service.created', 'service:' || id::text,
                  jsonb_build_object('environment', environment)
           FROM created
           RETURNING id
         )
         SELECT id, project_id, name, environment, sdk_version, created_at FROM created`,
        [projectId, input.name, input.environment, input.sdkVersion ?? null],
      );
      return this.serviceResponse(result.rows[0]);
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async listEnvironments(projectIdValue: string): Promise<string[]> {
    const projectId = parseProjectId(projectIdValue);
    await this.requireProject(projectId);
    try {
      const result = await this.database.query<{ environment: string }>(
        `SELECT DISTINCT environment FROM services WHERE project_id = $1 ORDER BY environment ASC`,
        [projectId],
      );
      return result.rows.map((row) => row.environment);
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async listProjectKeys(projectIdValue: string) {
    const projectId = parseProjectId(projectIdValue);
    await this.requireProject(projectId);
    try {
      const result = await this.database.query<ProjectKeyRow>(
        `SELECT id, project_id, name, key_prefix, scopes, last_used_at, revoked_at, created_at
         FROM project_keys WHERE project_id = $1
         ORDER BY created_at DESC, id ASC`,
        [projectId],
      );
      return result.rows.map((row) => this.projectKeyResponse(row));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async createProjectKey(projectIdValue: string, value: unknown) {
    const projectId = parseProjectId(projectIdValue);
    const input: CreateProjectKeyInput = parseCreateProjectKey(value);
    await this.requireProject(projectId);
    const material = createProjectKeyMaterial();
    try {
      const result = await this.database.query<ProjectKeyRow>(
        `WITH created AS (
           INSERT INTO project_keys (project_id, name, key_prefix, key_hash, scopes)
           VALUES ($1, $2, $3, $4, $5::text[])
           RETURNING id, project_id, name, key_prefix, scopes, last_used_at, revoked_at, created_at
         ), audited AS (
           INSERT INTO audit_logs (project_id, actor_id, action, resource, details)
           SELECT project_id, 'platform_admin', 'project_key.created', 'project_key:' || id::text,
                  jsonb_build_object('scopes', scopes, 'keyPrefix', key_prefix)
           FROM created
           RETURNING id
         )
         SELECT id, project_id, name, key_prefix, scopes, last_used_at, revoked_at, created_at FROM created`,
        [projectId, input.name, material.keyPrefix, material.keyHash, input.scopes],
      );
      return { ...this.projectKeyResponse(result.rows[0]), key: material.key };
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async rotateProjectKey(projectIdValue: string, keyIdValue: string) {
    const projectId = parseProjectId(projectIdValue);
    const keyId = parseProjectId(keyIdValue);
    const material = createProjectKeyMaterial();
    try {
      const result = await this.database.query<RotatedProjectKeyRow>(
        `WITH target AS MATERIALIZED (
           SELECT id, project_id, name, scopes
           FROM project_keys
           WHERE id = $2 AND project_id = $1 AND revoked_at IS NULL
           FOR UPDATE
         ), revoked AS (
           UPDATE project_keys AS key
           SET revoked_at = now()
           FROM target
           WHERE key.id = target.id AND key.revoked_at IS NULL
           RETURNING key.id AS old_key_id, key.project_id, key.name, key.scopes
         ), rotated AS (
           INSERT INTO project_keys (project_id, name, key_prefix, key_hash, scopes)
           SELECT project_id, name, $3, $4, scopes FROM revoked
           RETURNING id, project_id, name, key_prefix, scopes, last_used_at, revoked_at, created_at
         ), audited AS (
           INSERT INTO audit_logs (project_id, actor_id, action, resource, details)
           SELECT rotated.project_id, 'platform_admin', 'project_key.rotated',
                  'project_key:' || rotated.id::text,
                  jsonb_build_object('oldKeyId', revoked.old_key_id,
                    'keyPrefix', rotated.key_prefix, 'scopes', rotated.scopes)
           FROM rotated JOIN revoked ON revoked.project_id = rotated.project_id
           RETURNING id
         )
         SELECT rotated.id, rotated.project_id, rotated.name, rotated.key_prefix, rotated.scopes,
                rotated.last_used_at, rotated.revoked_at, rotated.created_at, revoked.old_key_id
         FROM rotated CROSS JOIN revoked`,
        [projectId, keyId, material.keyPrefix, material.keyHash],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException('Project key not found');
      return {
        ...this.projectKeyResponse(row),
        rotatedFromKeyId: row.old_key_id,
        key: material.key,
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      translateDatabaseError(error);
    }
  }

  async revokeProjectKey(projectIdValue: string, keyIdValue: string) {
    const projectId = parseProjectId(projectIdValue);
    const keyId = parseProjectId(keyIdValue);
    try {
      const result = await this.database.query<RevokedKeyRow>(
        `WITH target AS MATERIALIZED (
           SELECT id, project_id, revoked_at FROM project_keys WHERE id = $1 AND project_id = $2 FOR UPDATE
         ), revoked AS (
           UPDATE project_keys AS key SET revoked_at = now()
           FROM target WHERE key.id = target.id AND key.revoked_at IS NULL
           RETURNING key.id, key.project_id, key.revoked_at
         ), audited AS (
           INSERT INTO audit_logs (project_id, actor_id, action, resource, details)
           SELECT project_id, 'platform_admin', 'project_key.revoked', 'project_key:' || id::text, '{}'::jsonb
           FROM revoked RETURNING id
         )
         SELECT id, revoked_at FROM revoked
         UNION ALL
         SELECT id, revoked_at FROM target
         WHERE revoked_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revoked)
         LIMIT 1`,
        [keyId, projectId],
      );
      if (result.rows[0]) {
        return { id: result.rows[0].id, revokedAt: timestamp(result.rows[0].revoked_at) };
      }

      throw new NotFoundException('Project key not found');
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      translateDatabaseError(error);
    }
  }

  async getPrivacyPolicy(projectIdValue: string) {
    const projectId = parseProjectId(projectIdValue);
    await this.requireProject(projectId);
    try {
      const result = await this.database.query<ProjectPrivacyPolicyRow>(
        `SELECT project_id, additional_redacted_fields, capture_prompt_response, updated_at
         FROM project_privacy_policies WHERE project_id = $1`,
        [projectId],
      );
      if (!result.rows[0]) throw new ServiceUnavailableException('Project privacy policy is unavailable');
      return this.privacyPolicyResponse(result.rows[0]);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      translateDatabaseError(error);
    }
  }

  async updatePrivacyPolicy(projectIdValue: string, value: unknown) {
    const projectId = parseProjectId(projectIdValue);
    const input: ProjectPrivacyPolicyPatchInput = parseProjectPrivacyPolicyPatch(value);
    await this.requireProject(projectId);
    const fields = input.additionalRedactedFields ?? null;
    try {
      const result = await this.database.query<ProjectPrivacyPolicyRow>(
        `WITH updated AS (
           UPDATE project_privacy_policies
           SET additional_redacted_fields = COALESCE($2::text[], additional_redacted_fields),
               updated_at = CASE WHEN $2::text[] IS NOT NULL
                                  AND additional_redacted_fields IS DISTINCT FROM $2::text[]
                                 THEN now() ELSE updated_at END
           WHERE project_id = $1
             AND ($2::text[] IS NULL OR additional_redacted_fields IS DISTINCT FROM $2::text[])
           RETURNING project_id, additional_redacted_fields, capture_prompt_response, updated_at
         ), audited AS (
           INSERT INTO audit_logs (project_id, actor_id, action, resource, details)
           SELECT project_id, 'platform_admin', 'project_privacy_policy.updated',
                  'project_privacy_policy',
                  jsonb_build_object('additionalRedactedFieldCount', cardinality(additional_redacted_fields),
                    'capturePromptResponse', false)
           FROM updated RETURNING id
         )
         SELECT project_id, additional_redacted_fields, capture_prompt_response, updated_at FROM updated
         UNION ALL
         SELECT project_id, additional_redacted_fields, capture_prompt_response, updated_at
         FROM project_privacy_policies
         WHERE project_id = $1 AND NOT EXISTS (SELECT 1 FROM updated)
         LIMIT 1`,
        [projectId, fields],
      );
      const row = result.rows[0];
      if (!row) throw new ServiceUnavailableException('Project privacy policy is unavailable');
      return this.privacyPolicyResponse(row);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      translateDatabaseError(error);
    }
  }

  async listAuditLogs(projectIdValue: string, rawQuery: unknown) {
    const projectId = parseProjectId(projectIdValue);
    const query: AuditLogsQuery = parseAuditLogsQuery(rawQuery);
    await this.requireProject(projectId);
    try {
      const result = await this.database.query<AuditLogListRow>(
        `WITH page AS (
           SELECT id, actor_id, action, resource, created_at
           FROM audit_logs WHERE project_id = $1
           ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3
         )
         SELECT (SELECT COUNT(*) FROM audit_logs WHERE project_id = $1) AS total,
                page.id, page.actor_id, page.action, page.resource, page.created_at
         FROM (VALUES (1)) AS seed(value)
         LEFT JOIN page ON TRUE
         ORDER BY page.created_at DESC NULLS LAST, page.id DESC NULLS LAST`,
        [projectId, query.pageSize, (query.page - 1) * query.pageSize],
      );
      const total = Number(result.rows[0]?.total ?? 0);
      if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid audit count');
      return {
        items: result.rows.flatMap((row) => {
          if (row.id === null) return [];
          if (row.action === null || row.resource === null || row.created_at === null) {
            throw new Error('Invalid audit row');
          }
          return [this.auditLogResponse({
            id: row.id,
            actor_id: row.actor_id,
            action: row.action,
            resource: row.resource,
            created_at: row.created_at,
          })];
        }),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  private async requireProject(projectId: string): Promise<void> {
    try {
      const result = await this.database.query<{ id: string }>('SELECT id FROM projects WHERE id = $1', [projectId]);
      if (!result.rows[0]) throw new NotFoundException('Project not found');
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      translateDatabaseError(error);
    }
  }

  private projectResponse(row: ProjectRow) {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      retentionDays: row.retention_days,
      status: row.status,
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
    };
  }

  private serviceResponse(row: ServiceRow) {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      environment: row.environment,
      sdkVersion: row.sdk_version,
      createdAt: timestamp(row.created_at),
    };
  }

  private projectKeyResponse(row: ProjectKeyRow) {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      keyPrefix: row.key_prefix,
      scopes: row.scopes,
      lastUsedAt: timestamp(row.last_used_at),
      revokedAt: timestamp(row.revoked_at),
      createdAt: timestamp(row.created_at),
    };
  }

  private privacyPolicyResponse(row: ProjectPrivacyPolicyRow) {
    const fields = row.additional_redacted_fields;
    if (
      row.capture_prompt_response !== false
      || !Array.isArray(fields)
      || fields.length > 64
      || fields.some((field) => typeof field !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(field))
    ) {
      throw new ServiceUnavailableException('Project privacy policy is unavailable');
    }
    return {
      projectId: row.project_id,
      additionalRedactedFields: fields,
      capturePromptResponse: false,
      updatedAt: timestamp(row.updated_at),
    };
  }

  private auditLogResponse(row: AuditLogRow) {
    const id = String(row.id);
    const resource = /^(?:project_key|service):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.resource)
      || row.resource === 'project_privacy_policy'
      ? row.resource
      : 'unknown';
    return {
      id: /^\d{1,19}$/.test(id) ? id : '0',
      actorId: row.actor_id === 'platform_admin' ? 'platform_admin' : 'system',
      action: AUDIT_ACTIONS.has(row.action) ? row.action : 'other',
      resource,
      createdAt: timestamp(row.created_at),
    };
  }
}
