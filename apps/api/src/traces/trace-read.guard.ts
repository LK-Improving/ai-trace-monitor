import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProjectKeySchema, TRACE_READ_SCOPE } from '@trace-ops/contracts';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseService } from '../database/database.service';

interface TraceReadRequest {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
}

interface ProjectKeyCandidate {
  id: string;
  project_id: string;
  key_hash: string;
  scopes: string[];
  revoked_at: Date | string | null;
  project_status: string;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function matchesConfiguredToken(supplied: string, configured: string): boolean {
  return timingSafeEqual(digest(supplied), digest(configured));
}

@Injectable()
export class TraceReadGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TraceReadRequest>();
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/i.exec(authorization) : null;
    if (!match) throw new UnauthorizedException('Unauthorized');

    const token = match[1];
    const adminToken = this.config.get<string>('PLATFORM_ADMIN_TOKEN');
    if (typeof adminToken === 'string' && adminToken.length > 0 && matchesConfiguredToken(token, adminToken)) {
      return true;
    }

    if (!ProjectKeySchema.safeParse(token).success) throw new UnauthorizedException('Unauthorized');
    const projectIdValue = request.query.projectId;
    if (typeof projectIdValue !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectIdValue)) {
      throw new BadRequestException('Invalid trace query');
    }
    const projectId = projectIdValue.toLowerCase();

    let candidate: ProjectKeyCandidate | undefined;
    try {
      const result = await this.database.query<ProjectKeyCandidate>(
        `SELECT key.id, key.project_id, key.key_hash, key.scopes, key.revoked_at, project.status AS project_status
         FROM project_keys AS key
         JOIN projects AS project ON project.id = key.project_id
         WHERE key.key_prefix = $1
         ORDER BY key.created_at DESC, key.id ASC
         LIMIT 64`,
        [token.slice(0, 11)],
      );
      const suppliedHash = digest(token);
      for (const row of result.rows) {
        const hasValidHash = typeof row.key_hash === 'string' && /^[a-f\d]{64}$/i.test(row.key_hash);
        const storedHash = hasValidHash ? Buffer.from(row.key_hash, 'hex') : Buffer.alloc(suppliedHash.length);
        const matches = timingSafeEqual(suppliedHash, storedHash);
        if (matches && hasValidHash) candidate = row;
      }
    } catch {
      throw new ServiceUnavailableException('Trace access is unavailable');
    }

    if (!candidate || candidate.revoked_at !== null || candidate.project_status !== 'active') {
      throw new UnauthorizedException('Unauthorized');
    }
    if (!Array.isArray(candidate.scopes) || !candidate.scopes.includes(TRACE_READ_SCOPE)) {
      throw new ForbiddenException('Trace read scope is required');
    }
    if (candidate.project_id.toLowerCase() !== projectId) {
      throw new ForbiddenException('Project key cannot access another project');
    }

    try {
      const touched = await this.database.query<{ id: string }>(
        `UPDATE project_keys
         SET last_used_at = now()
         WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL
           AND scopes @> ARRAY['trace:read']::text[]
           AND EXISTS (SELECT 1 FROM projects WHERE id = $2 AND status = 'active')
         RETURNING id`,
        [candidate.id, projectId],
      );
      if (touched.rowCount !== 1) throw new UnauthorizedException('Unauthorized');
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new ServiceUnavailableException('Trace access is unavailable');
    }
    return true;
  }
}
