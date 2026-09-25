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
  CreateProjectInput,
  CreateProjectKeyInput,
  CreateServiceInput,
  parseCreateProject,
  parseCreateProjectKey,
  parseCreateService,
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
        `INSERT INTO services (project_id, name, environment, sdk_version)
         VALUES ($1, $2, $3, $4)
         RETURNING id, project_id, name, environment, sdk_version, created_at`,
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
        `INSERT INTO project_keys (project_id, name, key_prefix, key_hash, scopes)
         VALUES ($1, $2, $3, $4, ARRAY['spans:write']::text[])
         RETURNING id, project_id, name, key_prefix, scopes, last_used_at, revoked_at, created_at`,
        [projectId, input.name, material.keyPrefix, material.keyHash],
      );
      return { ...this.projectKeyResponse(result.rows[0]), key: material.key };
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async revokeProjectKey(projectIdValue: string, keyIdValue: string) {
    const projectId = parseProjectId(projectIdValue);
    const keyId = parseProjectId(keyIdValue);
    try {
      const result = await this.database.query<RevokedKeyRow>(
        `UPDATE project_keys SET revoked_at = now()
         WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL
         RETURNING id, revoked_at`,
        [keyId, projectId],
      );
      if (result.rows[0]) {
        return { id: result.rows[0].id, revokedAt: timestamp(result.rows[0].revoked_at) };
      }

      // Revocation is idempotent; do not turn an already-revoked key into a deletion.
      const existing = await this.database.query<RevokedKeyRow>(
        `SELECT id, revoked_at FROM project_keys WHERE id = $1 AND project_id = $2`,
        [keyId, projectId],
      );
      if (!existing.rows[0]) throw new NotFoundException('Project key not found');
      return { id: existing.rows[0].id, revokedAt: timestamp(existing.rows[0].revoked_at) };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
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
}
