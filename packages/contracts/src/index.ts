import { z } from 'zod';

export const TRACE_ID_HEADER = 'x-trace-id' as const;
export const PROJECT_KEY_FIELD = 'projectKey' as const;
export const PROJECT_KEY_SCOPE = 'spans:write' as const;
export const SPAN_SCHEMA_VERSION = 1 as const;

export const EnvironmentSchema = z.enum(['dev', 'staging', 'prod']);
export type Environment = z.infer<typeof EnvironmentSchema>;

export const ProjectKeyScopeSchema = z.literal(PROJECT_KEY_SCOPE);
// `tr_` + base64url encoding of 32 random bytes (43 characters).
export const ProjectKeySchema = z.string().regex(/^tr_[A-Za-z0-9_-]{43}$/);

// Keep IDs safe for HTTP headers and Kafka keys. This accepts the documented
// trace_v1_<uuid> form as well as valid IDs supplied by existing callers.
export const TraceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export function generateTraceId(randomUUID: () => string = () => globalThis.crypto.randomUUID()): string {
  return TraceIdSchema.parse(`trace_v1_${randomUUID()}`);
}

/**
 * Resolve one inbound x-trace-id. A valid single header wins; absent,
 * malformed, or ambiguous duplicate headers produce a fresh ID. Request-body
 * fields are intentionally not accepted as trace context.
 */
export function resolveTraceId(
  headerValue: string | readonly string[] | null | undefined,
  generate: () => string = generateTraceId,
): string {
  const candidate = typeof headerValue === 'string'
    ? headerValue
    : Array.isArray(headerValue) && headerValue.length === 1
      ? headerValue[0]
      : undefined;
  const parsed = TraceIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : TraceIdSchema.parse(generate());
}

/** Use for both successful and failed HTTP responses after resolving the ID. */
export function traceIdResponseHeaders(traceId: string): Record<typeof TRACE_ID_HEADER, string> {
  return { [TRACE_ID_HEADER]: TraceIdSchema.parse(traceId) };
}

const traceSpanFields = {
  traceId: TraceIdSchema,
  spanId: z.string().min(1).max(128),
  parentSpanId: z.string().min(1).max(128).optional(),
  service: z.string().min(1).max(120),
  operation: z.string().min(1).max(160),
  startTime: z.number().int().nonnegative(),
  endTime: z.number().int().nonnegative().optional(),
  status: z.enum(['ok', 'error']),
  attributes: z.record(z.string(), z.unknown()).default({}),
  tokenUsage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .optional(),
  error: z.string().max(8_000).optional(),
};

function validateSpanTimes(
  span: { startTime: number; endTime?: number },
  context: z.RefinementCtx,
): void {
  if (span.endTime !== undefined && span.endTime < span.startTime) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'endTime must be greater than or equal to startTime',
      path: ['endTime'],
    });
  }
}

export const TraceSpanSchema = z.object(traceSpanFields).superRefine(validateSpanTimes);

export const SpanEventSchema = z
  .object({
    ...traceSpanFields,
    // Missing schemaVersion is the legacy v1 wire shape. Parsers materialize
    // it as 1; other versions are rejected until an explicit migration exists.
    schemaVersion: z.literal(SPAN_SCHEMA_VERSION).default(SPAN_SCHEMA_VERSION),
    projectId: z.string().uuid(),
    environment: EnvironmentSchema,
  })
  .superRefine(validateSpanTimes);

/** Public ingestion body follows the requirements document; the key is auth-only. */
export const SpanIngestRequestSchema = z
  .object({
    [PROJECT_KEY_FIELD]: ProjectKeySchema,
    environment: EnvironmentSchema,
    spans: z.array(TraceSpanSchema).min(1).max(500),
  })
  .strict();

/** Trusted API-to-pipeline envelope after project-key authentication. */
export const SpanIngestBatchSchema = z.object({
  projectId: z.string().uuid(),
  environment: EnvironmentSchema,
  spans: z.array(TraceSpanSchema).min(1).max(500),
});

export type TraceSpan = z.infer<typeof TraceSpanSchema>;
export type SpanEvent = z.infer<typeof SpanEventSchema>;
export type SpanIngestRequest = z.infer<typeof SpanIngestRequestSchema>;
export type SpanIngestBatch = z.infer<typeof SpanIngestBatchSchema>;

const sensitiveAttributeName =
  /(prompt|response|user.?input|document.?content|completion.?text|raw.?messages?|authorization|password|credential|(?:api|project|private|secret|signing)[._-]?key|(?:api|project|access|refresh|auth|bearer|client)[._-]?token)/i;

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limited]';
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => redactValue(entry, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !sensitiveAttributeName.test(key))
        .map(([key, entry]) => [key, redactValue(entry, depth + 1)]),
    );
  }
  if (typeof value === 'string' && value.length > 4_000) return `${value.slice(0, 4_000)}…`;
  return value;
}

export function redactSpanAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  return redactValue(attributes) as Record<string, unknown>;
}

function toClickHouseDate(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace('T', ' ').replace('Z', '');
}

export function toClickHouseRow(event: SpanEvent) {
  const endTime = event.endTime ?? event.startTime;
  const attributes = redactSpanAttributes(event.attributes);
  const tokenUsage = event.tokenUsage;

  return {
    event_time: toClickHouseDate(event.startTime),
    project_id: event.projectId,
    environment: event.environment,
    trace_id: event.traceId,
    span_id: event.spanId,
    parent_span_id: event.parentSpanId ?? '',
    service: event.service,
    operation: event.operation,
    status: event.status,
    start_time: toClickHouseDate(event.startTime),
    end_time: toClickHouseDate(endTime),
    duration_ms: Math.max(0, endTime - event.startTime),
    input_tokens: tokenUsage?.input ?? 0,
    output_tokens: tokenUsage?.output ?? 0,
    total_tokens: tokenUsage?.total ?? 0,
    model: typeof attributes.model === 'string' ? attributes.model : '',
    attributes: JSON.stringify(attributes),
    error: event.error ?? '',
  };
}
