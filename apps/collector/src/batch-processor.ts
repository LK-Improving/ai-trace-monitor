import { createHash } from 'node:crypto';
import { SpanEventSchema, toClickHouseRow, type SpanEvent } from '@trace-ops/contracts';

export type CollectorMessage = {
  offset: string;
  value: Buffer | null;
};

export type InvalidReason = 'empty_payload' | 'invalid_json' | 'invalid_schema';

export type ProcessSpanBatchOptions = {
  source: { topic: string; partition: number };
  insert(rows: ReturnType<typeof toClickHouseRow>[], deduplicationToken: string): Promise<void>;
  processAlerts?(spans: readonly SpanEvent[]): Promise<void>;
  commit(lastProcessedOffset: string, nextOffset: string): Promise<void>;
  onInvalid?(reason: InvalidReason, offset: string): void;
};

/** Identify the exact Kafka delivery batch so an ambiguous ClickHouse insert can be retried safely. */
export function createClickHouseDeduplicationToken(
  topic: string,
  partition: number,
  messages: readonly CollectorMessage[],
): string {
  const identity = JSON.stringify([topic, partition, messages.map(({ offset }) => offset)]);
  return `trace-ops-${createHash('sha256').update(identity).digest('hex')}`;
}

export type ProcessSpanBatchResult = {
  insertedCount: number;
  invalidCount: number;
  lastProcessedOffset?: string;
  nextOffset?: string;
};

/** Parse and persist one Kafka partition batch before advancing its offset. */
export async function processSpanBatch(
  messages: readonly CollectorMessage[],
  options: ProcessSpanBatchOptions,
): Promise<ProcessSpanBatchResult> {
  if (messages.length === 0) {
    return { insertedCount: 0, invalidCount: 0 };
  }

  const rows: ReturnType<typeof toClickHouseRow>[] = [];
  const spans: SpanEvent[] = [];
  let invalidCount = 0;

  const markInvalid = (reason: InvalidReason, offset: string): void => {
    invalidCount += 1;
    options.onInvalid?.(reason, offset);
  };

  for (const message of messages) {
    if (message.value === null || message.value.byteLength === 0) {
      markInvalid('empty_payload', message.offset);
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(message.value.toString('utf8')) as unknown;
    } catch {
      markInvalid('invalid_json', message.offset);
      continue;
    }

    const parsed = SpanEventSchema.safeParse(payload);
    if (!parsed.success) {
      markInvalid('invalid_schema', message.offset);
      continue;
    }

    try {
      const row = toClickHouseRow(parsed.data);
      // Span.error can contain arbitrary exception text. Keep the structured
      // status and attributes, but never persist that free-form body.
      rows.push({ ...row, error: '' });
      spans.push(parsed.data);
    } catch {
      // Schema-valid values can still be unrepresentable by ClickHouse (for
      // example, timestamps outside JavaScript's supported date range).
      markInvalid('invalid_schema', message.offset);
    }
  }

  const lastProcessedOffset = messages[messages.length - 1]!.offset;
  const nextOffset = (BigInt(lastProcessedOffset) + 1n).toString();

  // Persist alerts first: a PostgreSQL outage must not leave already-written
  // business Spans behind an uncommitted Kafka offset. Both this side effect
  // (occurrence ledger) and ClickHouse inserts are idempotent on replay.
  if (spans.length > 0) await options.processAlerts?.(spans);

  if (rows.length > 0) {
    // The token is scoped to topic/partition and the complete ordered offset
    // list. A lost ClickHouse acknowledgement can therefore be retried without
    // duplicating this exact Kafka batch.
    const deduplicationToken = createClickHouseDeduplicationToken(
      options.source.topic,
      options.source.partition,
      messages,
    );
    await options.insert(rows, deduplicationToken);
  }

  // Invalid messages are deliberately discarded after safe classification;
  // committing the last offset prevents a poison message from blocking a
  // partition forever. For an all-invalid batch, this is the only operation.
  await options.commit(lastProcessedOffset, nextOffset);

  return {
    insertedCount: rows.length,
    invalidCount,
    lastProcessedOffset,
    nextOffset,
  };
}
