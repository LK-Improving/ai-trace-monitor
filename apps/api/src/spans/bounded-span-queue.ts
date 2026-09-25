import type { SpanEvent } from '@trace-ops/contracts';

export interface KafkaSpanMessage {
  key: string;
  value: string;
}

export interface KafkaSpanProducer {
  connect(): Promise<void>;
  send(input: { topic: string; messages: KafkaSpanMessage[] }): Promise<unknown>;
  disconnect(): Promise<void>;
}

export type KafkaSpanProducerFactory = (brokers: string[]) => KafkaSpanProducer;
export type ProducerState = 'idle' | 'connecting' | 'ready' | 'unavailable' | 'closing' | 'closed';

export interface BoundedSpanQueueOptions {
  topic: string;
  brokers: string[];
  producerFactory: KafkaSpanProducerFactory;
  maxQueueSpans?: number;
  maxQueueBytes?: number;
  batchSize?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  shutdownTimeoutMs?: number;
}

interface QueuedSpan {
  key: string;
  value: string;
  bytes: number;
  retries: number;
  settled: boolean;
}

export interface SpanQueueMetrics {
  producerState: ProducerState;
  topic: string;
  queueDepth: number;
  queueBytes: number;
  maxQueueSpans: number;
  maxQueueBytes: number;
  acceptedSpans: number;
  publishedSpans: number;
  droppedSpans: number;
  publishErrorCount: number;
  retryCount: number;
  rejectedBatchCount: number;
}

export interface SpanEnqueueResult {
  accepted: boolean;
  acceptedSpans: number;
  droppedSpans: number;
  queueDepth: number;
  producerState: ProducerState;
  reason?: 'queue_full' | 'shutting_down';
}

const DEFAULT_MAX_QUEUE_SPANS = 5_000;
const DEFAULT_MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 200;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_500;
const HARD_MAX_QUEUE_SPANS = 25_000;
const HARD_MAX_QUEUE_BYTES = 128 * 1024 * 1024;
const HARD_MAX_BATCH_SIZE = 500;
const HARD_MAX_RETRIES = 8;

/**
 * Bounded, process-local best-effort queue. HTTP callers only enqueue here;
 * Kafka I/O is performed later by a single asynchronous drain loop.
 */
export class BoundedSpanQueue {
  private readonly topic: string;
  private readonly brokers: string[];
  private readonly producerFactory: KafkaSpanProducerFactory;
  private readonly maxQueueSpans: number;
  private readonly maxQueueBytes: number;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly queue: QueuedSpan[] = [];
  private inFlight: QueuedSpan[] = [];
  private producer?: KafkaSpanProducer;
  private connected = false;
  private state: ProducerState = 'idle';
  private queueBytes = 0;
  private acceptedSpans = 0;
  private publishedSpans = 0;
  private droppedSpans = 0;
  private publishErrorCount = 0;
  private retryCount = 0;
  private rejectedBatchCount = 0;
  private drainTimer?: NodeJS.Timeout;
  private drainPromise?: Promise<number | undefined>;
  private closePromise?: Promise<void>;
  private closing = false;

  constructor(options: BoundedSpanQueueOptions) {
    this.topic = options.topic;
    this.brokers = options.brokers;
    this.producerFactory = options.producerFactory;
    this.maxQueueSpans = boundedPositiveInt(options.maxQueueSpans, DEFAULT_MAX_QUEUE_SPANS, HARD_MAX_QUEUE_SPANS);
    this.maxQueueBytes = boundedPositiveInt(options.maxQueueBytes, DEFAULT_MAX_QUEUE_BYTES, HARD_MAX_QUEUE_BYTES);
    this.batchSize = Math.min(
      boundedPositiveInt(options.batchSize, DEFAULT_BATCH_SIZE, HARD_MAX_BATCH_SIZE),
      this.maxQueueSpans,
    );
    this.maxRetries = boundedNonNegativeInt(options.maxRetries, DEFAULT_MAX_RETRIES, HARD_MAX_RETRIES);
    this.retryDelayMs = boundedPositiveInt(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS, 30_000);
    this.shutdownTimeoutMs = boundedPositiveInt(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS, 15_000);
  }

  enqueue(events: readonly SpanEvent[]): SpanEnqueueResult {
    const count = events.length;
    if (this.closing || this.state === 'closed') {
      this.droppedSpans += count;
      this.rejectedBatchCount += 1;
      return this.enqueueResult(false, 0, count, 'shutting_down');
    }

    const entries = events.map((event): QueuedSpan => {
      const value = JSON.stringify(event);
      return {
        key: event.traceId,
        value,
        bytes: Buffer.byteLength(value, 'utf8'),
        retries: 0,
        settled: false,
      };
    });
    const bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    if (
      this.queueDepth() + count > this.maxQueueSpans ||
      this.queueBytes + bytes > this.maxQueueBytes
    ) {
      this.droppedSpans += count;
      this.rejectedBatchCount += 1;
      return this.enqueueResult(false, 0, count, 'queue_full');
    }

    this.queue.push(...entries);
    this.queueBytes += bytes;
    this.acceptedSpans += count;
    this.scheduleDrain(0);
    return this.enqueueResult(true, count, 0);
  }

  metrics(): SpanQueueMetrics {
    return {
      producerState: this.state,
      topic: this.topic,
      queueDepth: this.queueDepth(),
      queueBytes: this.queueBytes,
      maxQueueSpans: this.maxQueueSpans,
      maxQueueBytes: this.maxQueueBytes,
      acceptedSpans: this.acceptedSpans,
      publishedSpans: this.publishedSpans,
      droppedSpans: this.droppedSpans,
      publishErrorCount: this.publishErrorCount,
      retryCount: this.retryCount,
      rejectedBatchCount: this.rejectedBatchCount,
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeQueue();
    return this.closePromise;
  }

  private async closeQueue(): Promise<void> {
    this.closing = true;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    this.setState('closing');

    for (const item of this.queue.splice(0)) this.settle(item, 'dropped');

    if (this.drainPromise) {
      const completed = await settlesWithin(this.drainPromise, this.shutdownTimeoutMs);
      if (!completed) {
        for (const item of this.inFlight) this.settle(item, 'dropped');
      }
    }

    if (this.producer) {
      try {
        await settlesWithin(this.producer.disconnect(), this.shutdownTimeoutMs);
      } catch {
        // Shutdown must remain bounded even when the client throws synchronously.
      }
    }
    this.connected = false;
    this.setState('closed');
  }

  private enqueueResult(
    accepted: boolean,
    acceptedSpans: number,
    droppedSpans: number,
    reason?: SpanEnqueueResult['reason'],
  ): SpanEnqueueResult {
    return {
      accepted,
      acceptedSpans,
      droppedSpans,
      queueDepth: this.queueDepth(),
      producerState: this.state,
      ...(reason ? { reason } : {}),
    };
  }

  private queueDepth(): number {
    return this.queue.length + this.inFlight.filter((item) => !item.settled).length;
  }

  private scheduleDrain(delayMs: number): void {
    if (this.closing || this.drainTimer || this.drainPromise || this.queue.length === 0) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      const run = this.drain();
      this.drainPromise = run;
      void run.then(
        (nextDelay) => {
          this.drainPromise = undefined;
          if (this.queue.length > 0 && !this.closing) this.scheduleDrain(nextDelay ?? 0);
        },
        () => {
          this.drainPromise = undefined;
          if (this.queue.length > 0 && !this.closing) this.scheduleDrain(this.retryDelayMs);
        },
      );
    }, delayMs);
  }

  private async drain(): Promise<number | undefined> {
    while (this.queue.length > 0 && !this.closing) {
      const batch = this.takeBatch();
      this.inFlight = batch;
      try {
        await this.ensureConnected();
        await this.producer!.send({
          topic: this.topic,
          messages: batch.map(({ key, value }) => ({ key, value })),
        });
        for (const item of batch) this.settle(item, 'published');
        this.setState('ready');
      } catch {
        this.publishErrorCount += 1;
        if (!this.closing && batch[0].retries < this.maxRetries) {
          const delay = this.retryDelayMs * 2 ** batch[0].retries;
          for (const item of batch) item.retries += 1;
          this.retryCount += batch.length;
          this.inFlight = [];
          this.queue.unshift(...batch);
          await this.disconnectForRetry();
          this.setState('unavailable');
          return delay;
        }
        for (const item of batch) this.settle(item, 'dropped');
        this.setState('unavailable');
      } finally {
        this.inFlight = [];
      }
    }
    return undefined;
  }

  private takeBatch(): QueuedSpan[] {
    const firstAttempt = this.queue[0].retries;
    const batch: QueuedSpan[] = [];
    while (
      batch.length < this.batchSize &&
      this.queue.length > 0 &&
      this.queue[0].retries === firstAttempt
    ) {
      batch.push(this.queue.shift()!);
    }
    return batch;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.producer) this.producer = this.producerFactory(this.brokers);
    if (this.connected) return;
    this.setState('connecting');
    await this.producer.connect();
    this.connected = true;
    this.setState('ready');
  }

  private async disconnectForRetry(): Promise<void> {
    if (!this.producer || !this.connected) return;
    this.connected = false;
    try {
      await settlesWithin(this.producer.disconnect(), 500);
    } catch {
      // The next bounded retry will reconnect through KafkaJS.
    }
  }

  private settle(item: QueuedSpan, result: 'published' | 'dropped'): void {
    if (item.settled) return;
    item.settled = true;
    this.queueBytes -= item.bytes;
    if (result === 'published') this.publishedSpans += 1;
    else this.droppedSpans += 1;
  }

  private setState(state: ProducerState): void {
    if (this.state === 'closed') return;
    if (this.closing && state !== 'closing' && state !== 'closed') return;
    this.state = state;
  }
}

function boundedPositiveInt(value: number | undefined, fallback: number, max: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, max) : fallback;
}

function boundedNonNegativeInt(value: number | undefined, fallback: number, max: number): number {
  return Number.isSafeInteger(value) && value! >= 0 ? Math.min(value!, max) : fallback;
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}
