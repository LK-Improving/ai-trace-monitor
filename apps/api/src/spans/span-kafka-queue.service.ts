import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka } from 'kafkajs';
import { BoundedSpanQueue } from './bounded-span-queue';

function envPositiveInt(config: ConfigService, name: string, fallback: number): number {
  const value = Number(config.get<string>(name));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function envNonNegativeInt(config: ConfigService, name: string, fallback: number): number {
  const value = Number(config.get<string>(name));
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

@Injectable()
export class SpanKafkaQueue extends BoundedSpanQueue implements OnModuleDestroy {
  constructor(config: ConfigService) {
    const brokers = (config.get<string>('KAFKA_BROKERS') ?? 'localhost:9092')
      .split(',')
      .map((broker) => broker.trim())
      .filter(Boolean);

    super({
      topic: config.get<string>('KAFKA_TOPIC')?.trim() || 'ai-spans',
      brokers: brokers.length > 0 ? brokers : ['localhost:9092'],
      maxQueueSpans: envPositiveInt(config, 'SPAN_QUEUE_MAX_SPANS', 5_000),
      maxQueueBytes: envPositiveInt(config, 'SPAN_QUEUE_MAX_BYTES', 16 * 1024 * 1024),
      batchSize: envPositiveInt(config, 'SPAN_QUEUE_BATCH_SIZE', 100),
      maxRetries: envNonNegativeInt(config, 'SPAN_QUEUE_MAX_RETRIES', 3),
      producerFactory: (resolvedBrokers) => {
        const kafka = new Kafka({
          clientId: 'trace-ops-api',
          brokers: resolvedBrokers,
          connectionTimeout: 3_000,
          requestTimeout: 5_000,
          retry: { initialRetryTime: 200, retries: 1 },
        });
        return kafka.producer({ allowAutoTopicCreation: false });
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
