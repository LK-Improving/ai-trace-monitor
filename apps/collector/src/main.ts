import { createClient } from '@clickhouse/client';
import { Kafka, logLevel } from 'kafkajs';
import { SpanEventSchema, toClickHouseRow } from '@trace-ops/contracts';

const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map((broker) => broker.trim());
const topic = process.env.KAFKA_TOPIC ?? 'ai-spans';
const groupId = process.env.KAFKA_GROUP_ID ?? 'trace-ops-collector';
const table = process.env.CLICKHOUSE_TABLE ?? 'trace_spans';

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
  database: process.env.CLICKHOUSE_DATABASE ?? 'observability',
});

async function bootstrap() {
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });
  console.log(`Collector subscribed to ${topic}; ClickHouse table: ${table}`);

  await consumer.run({
    autoCommit: false,
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
      if (!isRunning() || isStale()) return;

      const rows: ReturnType<typeof toClickHouseRow>[] = [];
      let invalidCount = 0;

      for (const message of batch.messages) {
        const raw = message.value?.toString();
        if (!raw) {
          invalidCount += 1;
          resolveOffset(message.offset);
          continue;
        }

        try {
          const event = SpanEventSchema.parse(JSON.parse(raw));
          rows.push(toClickHouseRow(event));
        } catch (error) {
          invalidCount += 1;
          const reason = error instanceof Error ? error.message : 'invalid span payload';
          console.warn(`Skipped invalid Span at ${batch.topic}/${batch.partition}/${message.offset}: ${reason}`);
        }
        resolveOffset(message.offset);
      }

      if (rows.length > 0) {
        await clickhouse.insert({ table, values: rows, format: 'JSONEachRow' });
      }

      if (invalidCount > 0) console.warn(`Invalid Span count in batch: ${invalidCount}`);
      const nextOffset = (BigInt(batch.lastOffset()) + 1n).toString();
      await consumer.commitOffsets([{ topic: batch.topic, partition: batch.partition, offset: nextOffset }]);
      await heartbeat();
    },
  });
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`Received ${signal}; stopping Collector...`);
  await consumer.stop().catch(() => undefined);
  await Promise.allSettled([consumer.disconnect(), clickhouse.close()]);
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

void bootstrap().catch(async (error: unknown) => {
  console.error('Collector startup failed:', error);
  await Promise.allSettled([consumer.disconnect(), clickhouse.close()]);
  process.exitCode = 1;
});
