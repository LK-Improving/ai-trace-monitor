import { randomUUID } from 'node:crypto';
import {
  Environment,
  EnvironmentSchema,
  SpanEvent,
  SpanEventSchema,
  SPAN_SCHEMA_VERSION,
  TraceIdSchema,
  redactSpanAttributes,
} from '@trace-ops/contracts';

export interface TraceBinding {
  projectId: string;
  service: string;
  environment: Environment;
}

export type SpanSink = (event: SpanEvent) => unknown;

export interface ActiveSpan {
  readonly id: string;
  readonly traceId: string;
  set(key: string, value: unknown): this;
  setUsage(input: number, output: number): this;
  end(error?: unknown): SpanEvent;
}

export interface TraceRecorderMetrics {
  accepted: number;
  dropped: number;
  errors: number;
}

const MAX_ATTRIBUTES_BYTES = 16 * 1024;
const MAX_ATTRIBUTE_KEY_LENGTH = 256;
const MAX_ATTRIBUTE_STRING_LENGTH = 4_000;
const MAX_ATTRIBUTE_COLLECTION_ITEMS = 100;
const MAX_ATTRIBUTE_ENUMERATED_KEYS = 256;
const MAX_ATTRIBUTE_DEPTH = 8;
const MAX_NORMALIZED_NODES = 1_024;
const MAX_INLINE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const TRACE_ID_PROBE = 'trace_v1_recorder';
const SPAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type SafeBinding = Readonly<TraceBinding>;

interface NormalizeBudget {
  remainingNodes: number;
  seen: WeakSet<object>;
}

function safeNormalize(
  value: unknown,
  budget: NormalizeBudget = { remainingNodes: MAX_NORMALIZED_NODES, seen: new WeakSet<object>() },
  depth = 0,
): unknown {
  if (budget.remainingNodes <= 0) return '[node-budget-exhausted]';
  budget.remainingNodes -= 1;
  if (depth > MAX_ATTRIBUTE_DEPTH) return '[depth-limited]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > MAX_ATTRIBUTE_STRING_LENGTH
      ? `${value.slice(0, MAX_ATTRIBUTE_STRING_LENGTH)}…`
      : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[non-finite-number]';
  if (typeof value === 'bigint') {
    return value >= -MAX_INLINE_BIGINT && value <= MAX_INLINE_BIGINT ? `${value}n` : '[bigint]';
  }
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'symbol') return '[symbol]';
  if (typeof value === 'function') return '[function]';

  try {
    if (budget.seen.has(value)) return '[circular]';
    budget.seen.add(value);

    if (Array.isArray(value)) {
      let originalLength: number;
      try {
        originalLength = value.length;
      } catch {
        return '[unserializable]';
      }
      if (!Number.isSafeInteger(originalLength) || originalLength < 0) return '[unserializable]';
      const length = Math.min(originalLength, MAX_ATTRIBUTE_COLLECTION_ITEMS);

      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        if (budget.remainingNodes <= 0) {
          output.push('[node-budget-exhausted]');
          break;
        }
        try {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          output.push(
            descriptor && 'value' in descriptor
              ? safeNormalize(descriptor.value, budget, depth + 1)
              : descriptor
                ? '[accessor]'
                : '[undefined]',
          );
        } catch {
          output.push('[unserializable]');
        }
      }
      if (originalLength > length) output.push('[items-limited]');
      return output;
    }

    const keys: string[] = [];
    let truncated = false;
    try {
      let inspected = 0;
      for (const key in value) {
        inspected += 1;
        if (keys.length >= MAX_ATTRIBUTE_COLLECTION_ITEMS || inspected > MAX_ATTRIBUTE_ENUMERATED_KEYS) {
          truncated = true;
          break;
        }
        if (Object.prototype.hasOwnProperty.call(value, key)) keys.push(key);
      }
    } catch {
      return '[unserializable]';
    }

    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (budget.remainingNodes <= 0) {
        truncated = true;
        break;
      }
      if (key.length > MAX_ATTRIBUTE_KEY_LENGTH) continue;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) continue;
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: 'value' in descriptor
            ? safeNormalize(descriptor.value, budget, depth + 1)
            : '[accessor]',
          writable: true,
        });
      } catch {
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: '[unserializable]',
          writable: true,
        });
      }
    }
    if (truncated) {
      Object.defineProperty(output, '_truncated', {
        configurable: true,
        enumerable: true,
        value: '[items-limited]',
        writable: true,
      });
    }
    return output;
  } catch {
    return '[unserializable]';
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateBinding(binding: TraceBinding): SafeBinding {
  let candidate: TraceBinding;
  try {
    if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
      throw new TypeError();
    }
    candidate = {
      projectId: binding.projectId,
      service: binding.service,
      environment: binding.environment,
    };
  } catch {
    throw new TypeError('Invalid TraceRecorder binding');
  }

  const validation = SpanEventSchema.safeParse({
    schemaVersion: SPAN_SCHEMA_VERSION,
    projectId: candidate.projectId,
    environment: candidate.environment,
    traceId: TRACE_ID_PROBE,
    spanId: 'span_v1_recorder',
    service: candidate.service,
    operation: 'trace.recorder',
    startTime: 0,
    endTime: 0,
    status: 'ok',
    attributes: {},
  });
  if (!validation.success || !EnvironmentSchema.safeParse(candidate.environment).success) {
    throw new TypeError('Invalid TraceRecorder binding');
  }

  return Object.freeze({
    projectId: validation.data.projectId.toLowerCase(),
    service: validation.data.service,
    environment: validation.data.environment,
  });
}

function measureAttributes(attributes: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(attributes), 'utf8');
}

function makeAttributeSnapshot(entries: Iterable<readonly [string, unknown]>): Record<string, unknown> {
  const unredacted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of entries) {
    Object.defineProperty(unredacted, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return redactSpanAttributes(unredacted);
}

function validateSpanStart(
  binding: SafeBinding,
  operation: string,
  traceId: string,
  parentSpanId: string | undefined,
  spanId: string,
): { traceId: string; parentSpanId?: string } {
  const parsedTraceId = TraceIdSchema.safeParse(traceId);
  if (!parsedTraceId.success) throw new TypeError('Invalid trace ID');
  if (!SPAN_ID_PATTERN.test(spanId)) throw new TypeError('Invalid span ID');
  if (parentSpanId !== undefined && !SPAN_ID_PATTERN.test(parentSpanId)) {
    throw new TypeError('Invalid parent span ID');
  }

  const candidate = SpanEventSchema.safeParse({
    schemaVersion: SPAN_SCHEMA_VERSION,
    projectId: binding.projectId,
    environment: binding.environment,
    traceId: parsedTraceId.data,
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    service: binding.service,
    operation,
    startTime: 0,
    endTime: 0,
    status: 'ok',
    attributes: {},
  });
  if (!candidate.success) throw new TypeError('Invalid span operation or identifiers');

  return {
    traceId: candidate.data.traceId,
    ...(candidate.data.parentSpanId === undefined ? {} : { parentSpanId: candidate.data.parentSpanId }),
  };
}

class ActiveSpanImpl implements ActiveSpan {
  private readonly spanId: string;
  private readonly activeTraceId: string;

  private readonly startedAt: number;
  private readonly attributes = new Map<string, unknown>();
  private tokenUsage: { input: number; output: number; total: number } | undefined;
  private completedEvent: SpanEvent | undefined;
  private ended = false;

  constructor(
    private readonly binding: SafeBinding,
    private readonly operation: string,
    traceId: string,
    parentSpanId: string | undefined,
    private readonly sink: SpanSink,
    private readonly onSinkResult: (result: unknown) => void,
  ) {
    this.spanId = `span_v1_${randomUUID()}`;
    const validated = validateSpanStart(binding, operation, traceId, parentSpanId, this.spanId);
    this.activeTraceId = validated.traceId;
    this.parentSpanId = validated.parentSpanId;
    this.startedAt = Date.now();
  }

  private readonly parentSpanId: string | undefined;

  get id(): string {
    return this.spanId;
  }

  get traceId(): string {
    return this.activeTraceId;
  }

  set(key: string, value: unknown): this {
    if (this.ended) throw new TypeError('Cannot modify an ended span');
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_ATTRIBUTE_KEY_LENGTH) {
      throw new TypeError('Invalid span attribute key');
    }
    if (key === 'durationMs' || key === 'error.type') {
      throw new TypeError('Span attribute key is reserved');
    }

    const next = new Map(this.attributes);
    next.set(key, safeNormalize(value));
    const redacted = makeAttributeSnapshot(next.entries());
    const bounded = {
      ...redacted,
      durationMs: Number.MAX_SAFE_INTEGER,
      'error.type': 'exception',
    };
    if (measureAttributes(bounded) > MAX_ATTRIBUTES_BYTES) {
      throw new RangeError('Span attributes exceed the size limit');
    }

    this.attributes.clear();
    for (const [attributeKey, attributeValue] of Object.entries(redacted)) {
      this.attributes.set(attributeKey, attributeValue);
    }
    return this;
  }

  setUsage(input: number, output: number): this {
    if (this.ended) throw new TypeError('Cannot modify an ended span');
    if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) {
      throw new TypeError('Token usage must contain non-negative safe integers');
    }
    const total = input + output;
    if (!Number.isSafeInteger(total)) {
      throw new TypeError('Total token usage exceeds the safe integer range');
    }
    this.tokenUsage = { input, output, total };
    return this;
  }

  end(error?: unknown): SpanEvent {
    if (this.completedEvent) return cloneJson(this.completedEvent);

    const endedAt = Math.max(this.startedAt, Date.now());
    const attributes = makeAttributeSnapshot(this.attributes.entries());
    attributes.durationMs = endedAt - this.startedAt;

    const failed = error !== undefined;
    if (failed) attributes['error.type'] = this.isErrorObject(error) ? 'exception' : 'unknown';

    const validation = SpanEventSchema.safeParse({
      schemaVersion: SPAN_SCHEMA_VERSION,
      projectId: this.binding.projectId,
      environment: this.binding.environment,
      traceId: this.traceId,
      spanId: this.id,
      ...(this.parentSpanId === undefined ? {} : { parentSpanId: this.parentSpanId }),
      service: this.binding.service,
      operation: this.operation,
      startTime: this.startedAt,
      endTime: endedAt,
      status: failed ? 'error' : 'ok',
      attributes,
      ...(this.tokenUsage === undefined ? {} : { tokenUsage: this.tokenUsage }),
    });
    if (!validation.success) throw new TypeError('Unable to create a valid span event');

    // Set terminal state before invoking user code so re-entrant end() cannot publish twice.
    this.completedEvent = cloneJson(validation.data);
    this.ended = true;
    const publishedSnapshot = cloneJson(this.completedEvent);
    try {
      this.onSinkResult(this.sink(publishedSnapshot));
    } catch {
      this.onSinkResult(TRACE_SINK_THROWN);
    }
    return cloneJson(this.completedEvent);
  }

  private isErrorObject(error: unknown): boolean {
    try {
      return error instanceof Error;
    } catch {
      return false;
    }
  }
}

const TRACE_SINK_THROWN = Symbol('trace-sink-thrown');

export class TraceRecorder {
  private accepted = 0;
  private dropped = 0;
  private errors = 0;
  private readonly binding: SafeBinding;

  constructor(binding: TraceBinding, private readonly sink: SpanSink) {
    this.binding = validateBinding(binding);
    if (typeof sink !== 'function') throw new TypeError('Invalid TraceRecorder sink');
  }

  start(operation: string, traceId: string, parentSpanId?: string): ActiveSpan {
    return new ActiveSpanImpl(
      this.binding,
      operation,
      traceId,
      parentSpanId,
      this.sink,
      (result) => this.recordSinkResult(result),
    );
  }

  metrics(): TraceRecorderMetrics {
    return { accepted: this.accepted, dropped: this.dropped, errors: this.errors };
  }

  private recordSinkResult(result: unknown): void {
    if (result === TRACE_SINK_THROWN) {
      this.recordSinkFailure();
      return;
    }

    if ((typeof result === 'object' && result !== null) || typeof result === 'function') {
      let then: unknown;
      try {
        then = (result as { then?: unknown }).then;
      } catch {
        this.recordSinkFailure();
        return;
      }
      if (typeof then === 'function') {
        // Assimilate manually after reading `then` once; both rejection and hostile thenables
        // are observed so they cannot escape as unhandled rejections.
        const settled = new Promise<void>((resolve, reject) => {
          try {
            (then as (this: unknown, resolve: () => void, reject: (reason?: unknown) => void) => void)
              .call(result, resolve, reject);
          } catch (error) {
            reject(error);
          }
        });
        void settled.then(
          (resolved) => {
            try {
              this.recordSinkResult(resolved);
            } catch {
              this.recordSinkFailure();
            }
          },
          () => this.recordSinkFailure(),
        );
        return;
      }
      try {
        if ((result as { accepted?: unknown }).accepted === false) {
          this.dropped += 1;
          return;
        }
      } catch {
        this.recordSinkFailure();
        return;
      }
    }

    this.accepted += 1;
  }

  private recordSinkFailure(): void {
    this.dropped += 1;
    this.errors += 1;
  }
}
