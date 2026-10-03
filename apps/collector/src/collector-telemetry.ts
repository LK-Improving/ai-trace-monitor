import { performance } from 'node:perf_hooks';

export type CollectorHealthStatus = 'running' | 'degraded' | 'unavailable';

export type CollectorTelemetrySnapshot = {
  status: CollectorHealthStatus;
  topic: string;
  consumerGroup: string;
  uptimeSeconds: number;
  processedMessages: number | null;
  insertedSpans: number | null;
  invalidMessages: number | null;
  failedBatches: number | null;
  clickhouseWriteFailures: number | null;
  committedBatches: number | null;
  lastCommitAt: string | null;
  lastClickHouseWriteAt: string | null;
};

export type CollectorTelemetryClock = {
  monotonicNow(): number;
  wallClockNow(): Date;
};

const DEFAULT_CLOCK: CollectorTelemetryClock = {
  monotonicNow: () => performance.now(),
  wallClockNow: () => new Date(),
};

function increment(current: number, amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0) return current;
  return Math.min(Number.MAX_SAFE_INTEGER, current + amount);
}

/** Process-local, payload-free counters for the internal health endpoint. */
export class CollectorTelemetry {
  private readonly startedAt: number;
  // Degraded means the process is starting and the consumer is not ready yet.
  private status: CollectorHealthStatus = 'degraded';
  private unavailable = false;
  // These counters are known zero from process start; API-side unreachable or
  // unavailable Collector projections use null instead of inventing values.
  private processedMessages = 0;
  private insertedSpans = 0;
  private invalidMessages = 0;
  private failedBatches = 0;
  private clickhouseWriteFailures = 0;
  private committedBatches = 0;
  private lastCommitAt: string | null = null;
  private lastClickHouseWriteAt: string | null = null;

  constructor(
    private readonly topic: string,
    private readonly consumerGroup: string,
    private readonly clock: CollectorTelemetryClock = DEFAULT_CLOCK,
  ) {
    this.startedAt = this.clock.monotonicNow();
  }

  markRunning(): void {
    if (this.unavailable) return;
    this.status = 'running';
  }

  markDegraded(): void {
    if (!this.unavailable) this.status = 'degraded';
  }

  markUnavailable(): void {
    this.unavailable = true;
    this.status = 'unavailable';
  }

  recordProcessedMessages(count: number): void {
    // Count every eachBatch delivery attempt, including Kafka redelivery/retry.
    this.processedMessages = increment(this.processedMessages, count);
  }

  recordInvalidMessage(): void {
    // Invalid data is counted on every actual classification, including redelivery.
    this.invalidMessages = increment(this.invalidMessages, 1);
  }

  recordClickHouseWriteSuccess(insertedSpanCount: number): void {
    this.insertedSpans = increment(this.insertedSpans, insertedSpanCount);
    this.lastClickHouseWriteAt = this.clock.wallClockNow().toISOString();
  }

  recordClickHouseWriteFailure(): void {
    this.clickhouseWriteFailures = increment(this.clickhouseWriteFailures, 1);
  }

  recordCommitSuccess(): void {
    this.committedBatches = increment(this.committedBatches, 1);
    this.lastCommitAt = this.clock.wallClockNow().toISOString();
    this.markRunning();
  }

  recordBatchFailure(): void {
    this.failedBatches = increment(this.failedBatches, 1);
    this.markDegraded();
  }

  snapshot(): CollectorTelemetrySnapshot {
    const elapsedMilliseconds = Math.max(0, this.clock.monotonicNow() - this.startedAt);
    return {
      status: this.status,
      topic: this.topic,
      consumerGroup: this.consumerGroup,
      uptimeSeconds: Math.floor(elapsedMilliseconds / 1_000),
      processedMessages: this.processedMessages,
      insertedSpans: this.insertedSpans,
      invalidMessages: this.invalidMessages,
      failedBatches: this.failedBatches,
      clickhouseWriteFailures: this.clickhouseWriteFailures,
      committedBatches: this.committedBatches,
      lastCommitAt: this.lastCommitAt,
      lastClickHouseWriteAt: this.lastClickHouseWriteAt,
    };
  }
}

/** Count a delivered batch once and preserve the original Kafka retry behavior. */
export async function observeBatchAttempt<Result>(
  telemetry: CollectorTelemetry,
  messageCount: number,
  operation: () => Promise<Result>,
): Promise<Result> {
  telemetry.recordProcessedMessages(messageCount);
  try {
    return await operation();
  } catch (error) {
    telemetry.recordBatchFailure();
    throw error;
  }
}

/** Instrument only the actual ClickHouse insert call, not setup or heartbeat failures. */
export async function observeClickHouseWrite<Result>(
  telemetry: CollectorTelemetry,
  insertedSpanCount: number,
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    const result = await operation();
    telemetry.recordClickHouseWriteSuccess(insertedSpanCount);
    return result;
  } catch (error) {
    telemetry.recordClickHouseWriteFailure();
    throw error;
  }
}
