import { SpanEventSchema, toClickHouseRow } from '@trace-ops/contracts';

export type CollectorMessage = {
  offset: string;
  value: Buffer | null;
};

export type InvalidReason = 'empty_payload' | 'invalid_json' | 'invalid_schema';

export type ProcessSpanBatchOptions = {
  insert(rows: ReturnType<typeof toClickHouseRow>[]): Promise<void>;
  commit(lastProcessedOffset: string, nextOffset: string): Promise<void>;
  onInvalid?(reason: InvalidReason, offset: string): void;
};

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
    } catch {
      // Schema-valid values can still be unrepresentable by ClickHouse (for
      // example, timestamps outside JavaScript's supported date range).
      markInvalid('invalid_schema', message.offset);
    }
  }

  const lastProcessedOffset = messages[messages.length - 1]!.offset;
  const nextOffset = (BigInt(lastProcessedOffset) + 1n).toString();

  if (rows.length > 0) {
    // A rejected insert deliberately prevents the commit below. Kafka will
    // replay the batch after the consumer's retry/restart policy takes over.
    await options.insert(rows);
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
