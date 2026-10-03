import { ClickHouseLogLevel, createClient } from '@clickhouse/client';
import { Kafka, logLevel } from 'kafkajs';
import { Pool } from 'pg';
import { processSpanBatch, type CollectorMessage, type InvalidReason } from './batch-processor';
import {
  ensureClickHouseInsertDeduplication,
  insertWithHeartbeat,
  runWithHeartbeat,
} from './clickhouse-sink';
import { AlertEngine } from './alert-engine';
import {
  CollectorTelemetry,
  observeBatchAttempt,
  observeClickHouseWrite,
} from './collector-telemetry';
import { createOpsHealthServer, listenOpsHealthServer } from './ops-health';

const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map((broker) => broker.trim());
const topic = process.env.KAFKA_TOPIC ?? 'ai-spans';
const groupId = process.env.KAFKA_GROUP_ID ?? 'trace-ops-collector';
const table = process.env.CLICKHOUSE_TABLE ?? 'trace_spans';
const clickhouseDatabase = process.env.CLICKHOUSE_DATABASE ?? 'observability';

const kafka = new Kafka({
  clientId: 'trace-ops-collector',
  brokers,
  logLevel: logLevel.WARN,
});
const consumer = kafka.consumer({ groupId });
const clickhouse = createClient({
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER ?? 'trace_ops',
  password: process.env.CLICKHOUSE_PASSWORD ?? 'trace_ops_dev_only',
  database: clickhouseDatabase,
  // The client's default error logger may include server response details.
  // Keep payload-adjacent ClickHouse errors out of logs; retry via safe Kafka errors below.
  log: { level: ClickHouseLogLevel.OFF },
});
const alertEngine = new AlertEngine(new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5_000,
}));
const telemetry = new CollectorTelemetry(topic, groupId);
const opsHealthServer = createOpsHealthServer(telemetry);
consumer.on(consumer.events.GROUP_JOIN, () => telemetry.markRunning());
consumer.on(consumer.events.CRASH, () => telemetry.markDegraded());
consumer.on(consumer.events.DISCONNECT, () => telemetry.markDegraded());
opsHealthServer.once('error', () => {
  // Listener failures are operationally useful, but provider error details are not safe to log.
  console.error('Collector internal health endpoint could not start');
});
listenOpsHealthServer(opsHealthServer);

let stopping = false;
let clickhouseDeduplicationReady = false;
let clickhouseDeduplicationSetup: Promise<boolean> | undefined;
let startupOperation: Promise<unknown> | undefined;
let closePromise: Promise<void> | undefined;

async function ensureClickHouseDeduplication(): Promise<boolean> {
  if (clickhouseDeduplicationReady) return true;
  const setup = clickhouseDeduplicationSetup ??= ensureClickHouseInsertDeduplication(
    clickhouse,
    clickhouseDatabase,
    table,
  );
  try {
    const ready = await setup;
    clickhouseDeduplicationReady ||= ready;
    return ready;
  } finally {
    if (clickhouseDeduplicationSetup === setup) clickhouseDeduplicationSetup = undefined;
  }
}

function withStartupOperation<T>(operation: Promise<T>): Promise<T> {
  startupOperation = operation;
  return operation.finally(() => {
    if (startupOperation === operation) startupOperation = undefined;
  });
}

function isActive(isRunning: () => boolean, isStale: () => boolean): boolean {
  return !stopping && isRunning() && !isStale();
}

const invalidReasonNames: readonly InvalidReason[] = [
  'empty_payload',
  'invalid_json',
  'invalid_schema',
];

function logInvalidBatch(
  counts: Record<InvalidReason, number>,
  batchTopic: string,
  partition: number,
): void {
  const invalidCount = invalidReasonNames.reduce((total, reason) => total + counts[reason], 0);
  if (invalidCount === 0) return;

  // Log only safe categories and counts, never payloads or validation details.
  console.warn(`Collector discarded ${invalidCount} invalid message(s) from ${batchTopic}[${partition}]`, counts);
}

async function bootstrap(): Promise<void> {
  // Existing Compose volumes do not rerun init SQL; upgrade their table before
  // the Collector starts writing. If the table is created later, each batch
  // retries this check before inserting.
  await ensureClickHouseDeduplication();
  await alertEngine.initialize();
  await withStartupOperation(consumer.connect());
  if (stopping) return;

  await withStartupOperation(consumer.subscribe({ topic, fromBeginning: true }));
  if (stopping) return;

  console.log(`Collector subscribed to ${topic}; ClickHouse table: ${table}`);
  await consumer.run({
    autoCommit: false,
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
      if (!isActive(isRunning, isStale)) return;

      const invalidCounts: Record<InvalidReason, number> = {
        empty_payload: 0,
        invalid_json: 0,
        invalid_schema: 0,
      };
      const messages: CollectorMessage[] = batch.messages.map(({ offset, value }) => ({ offset, value }));

      try {
        await observeBatchAttempt(telemetry, messages.length, async () => {
          await heartbeat();
          await processSpanBatch(messages, {
            source: { topic: batch.topic, partition: batch.partition },
            insert: async (rows, deduplicationToken) => {
              if (!await ensureClickHouseDeduplication()) {
                throw new Error('ClickHouse target table is not ready');
              }
              await insertWithHeartbeat(rows, {
                insert: async (batchRows) => observeClickHouseWrite(
                  telemetry,
                  batchRows.length,
                  () => clickhouse.insert({
                    table,
                    values: batchRows,
                    format: 'JSONEachRow',
                    clickhouse_settings: { insert_deduplication_token: deduplicationToken },
                  }),
                ),
                heartbeat,
                canContinue: () => isActive(isRunning, isStale),
              });
            },
            processAlerts: async (spans) => {
              await runWithHeartbeat(() => alertEngine.processSpans(spans), {
                heartbeat,
                canContinue: () => isActive(isRunning, isStale),
                operationName: 'Alert persistence',
              });
            },
            commit: async (lastProcessedOffset, nextOffset) => {
              if (!isActive(isRunning, isStale)) return;

              await consumer.commitOffsets([{
                topic: batch.topic,
                partition: batch.partition,
                offset: nextOffset,
              }]);
              telemetry.recordCommitSuccess();
              resolveOffset(lastProcessedOffset);
            },
            onInvalid: (reason) => {
              invalidCounts[reason] += 1;
              telemetry.recordInvalidMessage();
            },
          });
        });
      } finally {
        logInvalidBatch(invalidCounts, batch.topic, batch.partition);
      }
    },
  });
}

async function closeResources(): Promise<void> {
  if (closePromise) return closePromise;
  stopping = true;
  telemetry.markUnavailable();

  closePromise = (async () => {
    if (startupOperation) await startupOperation.catch(() => undefined);

    try {
      await consumer.stop();
    } catch {
      console.error('Collector encountered a consumer shutdown failure');
      process.exitCode = 1;
    }

    const results = await Promise.allSettled([
      consumer.disconnect(),
      clickhouse.close(),
      alertEngine.close(),
      closeOpsHealthServer(),
    ]);
    if (results.some((result) => result.status === 'rejected')) {
      console.error('Collector encountered a resource cleanup failure');
      process.exitCode = 1;
    }
  })();

  return closePromise;
}

async function closeOpsHealthServer(): Promise<void> {
  if (!opsHealthServer.listening) return;
  opsHealthServer.closeAllConnections();
  await new Promise<void>((resolve) => {
    opsHealthServer.close(() => resolve());
  });
}

async function shutdown(signal: string): Promise<void> {
  if (!closePromise) console.log(`Received ${signal}; stopping Collector...`);
  await closeResources();
}

process.once('SIGINT', () => {
  void shutdown('SIGINT').catch(() => {
    process.exitCode = 1;
  });
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM').catch(() => {
    process.exitCode = 1;
  });
});

void bootstrap().catch(async () => {
  telemetry.markUnavailable();
  console.error('Collector stopped after an unrecoverable startup or runtime failure');
  process.exitCode = 1;
  await closeResources();
});
