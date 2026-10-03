import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Environment,
  AdditionalRedactedFieldsSchema,
  PROJECT_KEY_SCOPE,
  SpanEvent,
  SpanEventSchema,
  SpanIngestBatchSchema,
  SpanIngestRequestSchema,
  SPAN_SCHEMA_VERSION,
  redactSpanAttributes,
} from '@trace-ops/contracts';
import { DatabaseService } from '../database/database.service';
import { SpanKafkaQueue } from './span-kafka-queue.service';

interface ProjectKeyCandidate {
  key_id: string;
  project_id: string;
  key_hash: string;
  scopes: string[];
  revoked_at: Date | string | null;
  project_status: string;
}

interface ProjectPrivacyPolicyCandidate {
  additional_redacted_fields: unknown;
  capture_prompt_response: boolean;
}

export type InvalidBatchReasonCode = 'invalid_request_schema' | 'service_environment_unregistered';

interface InvalidBatchRejectionSummary {
  reasonCode: InvalidBatchReasonCode;
  requestTraceId: string;
  timestamp: string;
}

@Injectable()
export class SpanIngestService {
  private rejectedInvalidBatchCount = 0;
  private lastInvalidBatchRejection: InvalidBatchRejectionSummary | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly queue: SpanKafkaQueue,
  ) {}

  async ingest(value: unknown, requestTraceId = 'trace_unavailable') {
    const request = SpanIngestRequestSchema.safeParse(value);
    if (!request.success) this.rejectInvalidBatch('invalid_request_schema', requestTraceId);

    const candidate = await this.authenticateKey(request.data.projectKey);
    if (
      !candidate ||
      candidate.revoked_at !== null ||
      !Array.isArray(candidate.scopes) ||
      !candidate.scopes.includes(PROJECT_KEY_SCOPE) ||
      candidate.project_status !== 'active'
    ) {
      throw new UnauthorizedException('Invalid project key');
    }

    const services = [...new Set(request.data.spans.map((span) => span.service))];
    const registeredServices = await this.query<{ name: string }>(
      `SELECT name FROM services
       WHERE project_id = $1 AND environment = $2 AND name = ANY($3::text[])`,
      [candidate.project_id, request.data.environment, services],
    );
    if (new Set(registeredServices.rows.map((row) => row.name)).size !== services.length) {
      this.rejectInvalidBatch('service_environment_unregistered', requestTraceId);
    }

    const privacyPolicy = await this.query<ProjectPrivacyPolicyCandidate>(
      `SELECT additional_redacted_fields, capture_prompt_response
       FROM project_privacy_policies WHERE project_id = $1`,
      [candidate.project_id],
    );
    const redactedFields = privacyPolicy.rows.length === 1
      ? AdditionalRedactedFieldsSchema.safeParse(privacyPolicy.rows[0].additional_redacted_fields)
      : null;
    if (
      !redactedFields?.success
      || privacyPolicy.rows[0].capture_prompt_response !== false
    ) {
      // A missing, corrupt, or unsupported policy must never bypass redaction.
      throw new ServiceUnavailableException('Span ingestion privacy policy is unavailable');
    }

    const lastUsed = await this.query<{ id: string }>(
      `UPDATE project_keys SET last_used_at = now()
       WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
      [candidate.key_id],
    );
    if (lastUsed.rowCount !== 1) throw new UnauthorizedException('Invalid project key');

    const batch = SpanIngestBatchSchema.safeParse({
      projectId: candidate.project_id,
      environment: request.data.environment,
      spans: request.data.spans,
    });
    if (!batch.success) this.rejectInvalidBatch('invalid_request_schema', requestTraceId);

    const events: SpanEvent[] = batch.data.spans.map((span) => {
      const event = SpanEventSchema.safeParse({
        ...span,
        // Span.error is unstructured free text and may contain prompts, user
        // content, or credentials. Keep status, but never forward that text.
        error: undefined,
        attributes: redactSpanAttributes(span.attributes, redactedFields.data),
        schemaVersion: SPAN_SCHEMA_VERSION,
        projectId: batch.data.projectId,
        environment: batch.data.environment as Environment,
      });
      if (!event.success) this.rejectInvalidBatch('invalid_request_schema', requestTraceId);
      return event.data;
    });

    const result = this.queue.enqueue(events);
    const accepted = result.accepted;
    return {
      status: accepted ? 'queued' : 'rejected',
      delivery: accepted ? 'queued_in_memory' : 'not_queued',
      durability: accepted ? 'best_effort' : 'not_accepted',
      acceptedSpans: result.acceptedSpans,
      droppedSpans: result.droppedSpans,
      queueDepth: result.queueDepth,
      producerState: result.producerState,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }

  metrics() {
    return {
      ...this.queue.metrics(),
      rejectedInvalidBatchCount: this.rejectedInvalidBatchCount,
      lastInvalidBatchRejection: this.lastInvalidBatchRejection,
    };
  }

  private rejectInvalidBatch(reasonCode: InvalidBatchReasonCode, requestTraceId: string): never {
    this.rejectedInvalidBatchCount += 1;
    this.lastInvalidBatchRejection = {
      reasonCode,
      requestTraceId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestTraceId)
        ? requestTraceId
        : 'trace_unavailable',
      timestamp: new Date().toISOString(),
    };
    throw new BadRequestException(
      reasonCode === 'invalid_request_schema'
        ? 'Invalid span ingestion request'
        : 'Span service or environment is not registered for this project',
    );
  }

  private async authenticateKey(projectKey: string): Promise<ProjectKeyCandidate | undefined> {
    const keyPrefix = projectKey.slice(0, 11);
    const candidates = await this.query<ProjectKeyCandidate>(
      `SELECT pk.id AS key_id, pk.project_id, pk.key_hash, pk.scopes, pk.revoked_at,
              p.status AS project_status
       FROM project_keys pk
       JOIN projects p ON p.id = pk.project_id
       WHERE pk.key_prefix = $1
       ORDER BY pk.created_at DESC, pk.id ASC
       LIMIT 64`,
      [keyPrefix],
    );

    const suppliedHash = createHash('sha256').update(projectKey, 'utf8').digest();
    let matched: ProjectKeyCandidate | undefined;
    for (const row of candidates.rows) {
      const validHash = typeof row.key_hash === 'string' && /^[a-f\d]{64}$/i.test(row.key_hash);
      const storedHash = validHash ? Buffer.from(row.key_hash, 'hex') : Buffer.alloc(suppliedHash.length);
      const equal = timingSafeEqual(suppliedHash, storedHash);
      if (equal && validHash) matched = row;
    }
    return matched;
  }

  private async query<T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(
    sql: string,
    values: readonly unknown[],
  ) {
    try {
      return await this.database.query<T>(sql, values);
    } catch {
      throw new ServiceUnavailableException('Span ingestion dependencies are unavailable');
    }
  }
}
