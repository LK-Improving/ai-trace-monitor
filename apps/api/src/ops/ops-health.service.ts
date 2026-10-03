import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Admin, Kafka } from 'kafkajs';
import { performance } from 'node:perf_hooks';
import { ClickHouseService } from '../overview/clickhouse.service';
import { DatabaseService } from '../database/database.service';
import { SpanKafkaQueue } from '../spans/span-kafka-queue.service';

type OverallStatus = 'healthy' | 'degraded' | 'unavailable';
type KafkaStatus = OverallStatus;
type CollectorStatus = 'running' | 'degraded' | 'unavailable';

interface KafkaPartitionLag {
  partition: number;
  lag: number | null;
}

interface KafkaHealth {
  status: KafkaStatus;
  topic: string;
  consumerGroup: string;
  totalLag: number | null;
  partitions: KafkaPartitionLag[];
}

interface CollectorHealth {
  status: CollectorStatus;
  topic: string;
  consumerGroup: string;
  uptimeSeconds: number | null;
  processedMessages: number | null;
  insertedSpans: number | null;
  invalidMessages: number | null;
  failedBatches: number | null;
  clickhouseWriteFailures: number | null;
  committedBatches: number | null;
  lastCommitAt: string | null;
  lastClickHouseWriteAt: string | null;
}

interface CollectorInternalHealth {
  status: 'running' | 'degraded';
  topic: string;
  consumerGroup: string;
  uptimeSeconds: number;
  processedMessages: number;
  insertedSpans: number;
  invalidMessages: number;
  failedBatches: number;
  clickhouseWriteFailures: number;
  committedBatches: number;
  lastCommitAt: string | null;
  lastClickHouseWriteAt: string | null;
}

const PROBE_TIMEOUT_MS = 1_200;
const KAFKA_SNAPSHOT_TIMEOUT_MS = 4_000;
const KAFKA_SNAPSHOT_CACHE_MS = 1_000;
const KAFKA_DISCONNECT_TIMEOUT_MS = 500;
const COLLECTOR_BODY_MAX_BYTES = 16 * 1024;
const DEFAULT_COLLECTOR_OPS_HEALTH_PORT = 3011;
const COLLECTOR_OPS_HEALTH_PATH = '/internal/ops/health';
const COLLECTOR_FIELDS = [
  'status', 'topic', 'consumerGroup', 'uptimeSeconds', 'processedMessages', 'insertedSpans',
  'invalidMessages', 'failedBatches', 'clickhouseWriteFailures', 'committedBatches',
  'lastCommitAt', 'lastClickHouseWriteAt',
] as const;

function configuredName(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback;
  return /^[A-Za-z0-9._-]{1,249}$/.test(candidate) ? candidate : fallback;
}

function collectorHealthEndpoint(config: ConfigService): string | undefined {
  const value = config.get<string>('COLLECTOR_OPS_HEALTH_PORT');
  if (value === undefined) return `http://127.0.0.1:${DEFAULT_COLLECTOR_OPS_HEALTH_PORT}${COLLECTOR_OPS_HEALTH_PATH}`;
  if (!/^[0-9]{1,5}$/.test(value)) return undefined;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
  return `http://127.0.0.1:${port}${COLLECTOR_OPS_HEALTH_PATH}`;
}

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(2));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('probe-timeout')), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function parseOffset(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^-?\d{1,24}$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

export function calculatePartitionLags(
  endOffsets: readonly { partition: number; high: string }[],
  committedOffsets: readonly { partition: number; offset: string }[],
  committedOffsetsAvailable = true,
): KafkaPartitionLag[] {
  const committedByPartition = new Map(committedOffsets.map(({ partition, offset }) => [partition, offset]));
  return endOffsets
    .filter(({ partition }) => Number.isSafeInteger(partition) && partition >= 0)
    .map(({ partition, high }) => {
      const end = parseOffset(high);
      const hasCommittedEntry = committedByPartition.has(partition);
      const committedValue = committedByPartition.get(partition);
      const committed = !committedOffsetsAvailable
        ? null
        : !hasCommittedEntry || committedValue === '-1'
          ? 0n
          : parseOffset(committedValue);
      if (end === null || committed === null) return { partition, lag: null };
      if (end < committed) return { partition, lag: null };
      const rawLag = end - committed;
      if (rawLag > BigInt(Number.MAX_SAFE_INTEGER)) return { partition, lag: null };
      return { partition, lag: Number(rawLag) };
    })
    .sort((left, right) => left.partition - right.partition);
}

export function buildKafkaOffsetSnapshot(
  topic: string,
  consumerGroup: string,
  endOffsets: readonly { partition: number; high: string }[],
  committedOffsets: readonly { partition: number; offset: string }[],
): KafkaHealth {
  const partitions = calculatePartitionLags(endOffsets, committedOffsets);
  const allKnown = partitions.length > 0 && partitions.every(({ lag }) => lag !== null);
  const sum = allKnown ? partitions.reduce((total, { lag }) => total + (lag ?? 0), 0) : null;
  const totalLag = sum !== null && Number.isSafeInteger(sum) ? sum : null;
  return {
    status: totalLag === null ? 'degraded' : 'healthy',
    topic,
    consumerGroup,
    totalLag,
    partitions,
  };
}

function parseTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validCollectorResponse(value: unknown): CollectorInternalHealth | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...COLLECTOR_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return undefined;
  if (record.status !== 'running' && record.status !== 'degraded') return undefined;
  if (
    typeof record.topic !== 'string' || !/^[A-Za-z0-9._-]{1,249}$/.test(record.topic)
    || typeof record.consumerGroup !== 'string' || !/^[A-Za-z0-9._-]{1,249}$/.test(record.consumerGroup)
    || typeof record.uptimeSeconds !== 'number' || !Number.isFinite(record.uptimeSeconds) || record.uptimeSeconds < 0
  ) return undefined;
  for (const key of [
    'processedMessages', 'insertedSpans', 'invalidMessages', 'failedBatches',
    'clickhouseWriteFailures', 'committedBatches',
  ] as const) {
    if (!nonNegativeSafeInteger(record[key])) return undefined;
  }
  const lastCommitAt = parseTimestamp(record.lastCommitAt);
  const lastClickHouseWriteAt = parseTimestamp(record.lastClickHouseWriteAt);
  if (lastCommitAt === undefined || lastClickHouseWriteAt === undefined) return undefined;
  return {
    status: record.status,
    topic: record.topic,
    consumerGroup: record.consumerGroup,
    uptimeSeconds: record.uptimeSeconds,
    processedMessages: record.processedMessages as number,
    insertedSpans: record.insertedSpans as number,
    invalidMessages: record.invalidMessages as number,
    failedBatches: record.failedBatches as number,
    clickhouseWriteFailures: record.clickhouseWriteFailures as number,
    committedBatches: record.committedBatches as number,
    lastCommitAt,
    lastClickHouseWriteAt,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('collector-body-unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > COLLECTOR_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('collector-body-too-large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

function nullableCollector(topic: string, consumerGroup: string): CollectorHealth {
  return {
    status: 'unavailable', topic, consumerGroup, uptimeSeconds: null,
    processedMessages: null, insertedSpans: null, invalidMessages: null,
    failedBatches: null, clickhouseWriteFailures: null, committedBatches: null,
    lastCommitAt: null, lastClickHouseWriteAt: null,
  };
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

@Injectable()
export class OpsHealthService implements OnModuleDestroy {
  private readonly topic: string;
  private readonly consumerGroup: string;
  private readonly brokers: string[];
  private readonly kafka: Kafka;
  private kafkaAdmin?: Admin;
  private kafkaAdminConnected = false;
  private kafkaAdminConnecting?: Promise<Admin>;
  private kafkaSnapshotPromise?: Promise<KafkaHealth>;
  private kafkaSnapshotCache?: { expiresAt: number; value: KafkaHealth };
  private destroyed = false;

  constructor(
    private readonly config: ConfigService,
    private readonly database: DatabaseService,
    private readonly queue: SpanKafkaQueue,
    private readonly clickhouse: ClickHouseService,
  ) {
    this.topic = configuredName(config.get<string>('KAFKA_TOPIC'), 'ai-spans');
    this.consumerGroup = configuredName(config.get<string>('KAFKA_GROUP_ID'), 'trace-ops-collector');
    this.brokers = (config.get<string>('KAFKA_BROKERS') ?? 'localhost:9092')
      .split(',').map((broker) => broker.trim()).filter(Boolean);
    this.kafka = new Kafka({
      clientId: 'trace-ops-api-ops-health',
      brokers: this.brokers.length > 0 ? this.brokers : ['127.0.0.1:9092'],
      connectionTimeout: PROBE_TIMEOUT_MS,
      requestTimeout: PROBE_TIMEOUT_MS,
      enforceRequestTimeout: true,
      retry: { initialRetryTime: 100, retries: 0 },
    });
  }

  async check() {
    const checkedAt = new Date().toISOString();
    const [postgres, kafka, collector, clickhouse] = await Promise.all([
      this.probePostgres(), this.probeKafka(), this.probeCollector(), this.probeClickHouse(),
    ]);
    const queueMetrics = this.queue.metrics();
    const spanQueue = {
      producerState: queueMetrics.producerState,
      depth: safeCount(queueMetrics.queueDepth),
      capacity: safeCount(queueMetrics.maxQueueSpans),
      queueBytes: safeCount(queueMetrics.queueBytes),
      maxQueueBytes: safeCount(queueMetrics.maxQueueBytes),
      accepted: safeCount(queueMetrics.acceptedSpans),
      published: safeCount(queueMetrics.publishedSpans),
      dropped: safeCount(queueMetrics.droppedSpans),
      publishErrors: safeCount(queueMetrics.publishErrorCount),
      retries: safeCount(queueMetrics.retryCount),
    };
    const dependencyStatuses = [postgres.status, kafka.status, collector.status, clickhouse.status];
    const allUnavailable = dependencyStatuses.every((status) => status === 'unavailable');
    const fullyHealthy = postgres.status === 'healthy'
      && kafka.status === 'healthy'
      && collector.status === 'running'
      && clickhouse.status === 'healthy'
      && ['idle', 'connecting', 'ready'].includes(spanQueue.producerState);
    const status: OverallStatus = allUnavailable ? 'unavailable' : fullyHealthy ? 'healthy' : 'degraded';

    return {
      status,
      checkedAt,
      processUptimeSeconds: Math.max(0, Math.floor(process.uptime())),
      postgres,
      kafka,
      collector,
      clickhouse,
      spanQueue,
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    this.kafkaSnapshotCache = undefined;
    const admin = this.kafkaAdmin;
    this.kafkaAdmin = undefined;
    if (admin) {
      await withTimeout(admin.disconnect(), KAFKA_DISCONNECT_TIMEOUT_MS).catch(() => undefined);
      return;
    }
    const connecting = this.kafkaAdminConnecting;
    if (connecting) {
      await withTimeout(connecting, KAFKA_DISCONNECT_TIMEOUT_MS)
        .then((connectedAdmin) => withTimeout(connectedAdmin.disconnect(), KAFKA_DISCONNECT_TIMEOUT_MS))
        .catch(() => undefined);
    }
  }

  protected async probePostgres() {
    const startedAt = performance.now();
    try {
      await withTimeout(this.database.ping(), PROBE_TIMEOUT_MS + 100);
      return { status: 'healthy' as const, latencyMs: roundMilliseconds(performance.now() - startedAt) };
    } catch {
      return { status: 'unavailable' as const, latencyMs: null };
    }
  }

  protected async probeClickHouse() {
    const startedAt = performance.now();
    let isHealthy = false;
    try {
      isHealthy = await withTimeout(this.clickhouse.ping(PROBE_TIMEOUT_MS), PROBE_TIMEOUT_MS + 100);
    } catch {
      isHealthy = false;
    }
    return {
      status: isHealthy ? 'healthy' as const : 'unavailable' as const,
      pingLatencyMs: isHealthy ? roundMilliseconds(performance.now() - startedAt) : null,
      queryLatency: this.clickhouse.queryLatencySnapshot(),
    };
  }

  protected async probeCollector(): Promise<CollectorHealth> {
    const endpoint = collectorHealthEndpoint(this.config);
    if (!endpoint) return nullableCollector(this.topic, this.consumerGroup);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('collector-not-ready');
      const source = validCollectorResponse(await readBoundedJson(response));
      if (!source) throw new Error('collector-response-invalid');
      return {
        ...source,
        status: source.topic === this.topic && source.consumerGroup === this.consumerGroup
          ? source.status
          : 'degraded',
      };
    } catch {
      return nullableCollector(this.topic, this.consumerGroup);
    } finally {
      clearTimeout(timer);
    }
  }

  protected probeKafka(): Promise<KafkaHealth> {
    const unavailable: KafkaHealth = {
      status: 'unavailable', topic: this.topic, consumerGroup: this.consumerGroup,
      totalLag: null, partitions: [],
    };
    if (this.destroyed || this.brokers.length === 0) return Promise.resolve(unavailable);
    const now = performance.now();
    if (this.kafkaSnapshotCache && this.kafkaSnapshotCache.expiresAt > now) {
      return Promise.resolve(this.kafkaSnapshotCache.value);
    }
    if (this.kafkaSnapshotPromise) return this.kafkaSnapshotPromise;

    const snapshot = withTimeout(this.fetchKafkaSnapshot(), KAFKA_SNAPSHOT_TIMEOUT_MS)
      .catch(async () => {
        await this.invalidateKafkaAdmin();
        return unavailable;
      })
      .then((value) => {
        this.kafkaSnapshotCache = { expiresAt: performance.now() + KAFKA_SNAPSHOT_CACHE_MS, value };
        return value;
      })
      .finally(() => {
        if (this.kafkaSnapshotPromise === snapshot) this.kafkaSnapshotPromise = undefined;
      });
    this.kafkaSnapshotPromise = snapshot;
    return snapshot;
  }

  private async fetchKafkaSnapshot(): Promise<KafkaHealth> {
    const unavailable: KafkaHealth = {
      status: 'unavailable', topic: this.topic, consumerGroup: this.consumerGroup,
      totalLag: null, partitions: [],
    };
    let admin: Admin | undefined;
    try {
      admin = await this.getKafkaAdmin();
      const [endResult, committedResult] = await Promise.allSettled([
        withTimeout(admin.fetchTopicOffsets(this.topic), PROBE_TIMEOUT_MS),
        withTimeout(admin.fetchOffsets({
          groupId: this.consumerGroup, topics: [this.topic], resolveOffsets: false,
        }), PROBE_TIMEOUT_MS),
      ]);
      if (endResult.status === 'rejected') {
        await this.invalidateKafkaAdmin(admin);
        return unavailable;
      }
      if (committedResult.status === 'rejected') {
        return {
          ...unavailable,
          status: 'degraded',
          partitions: calculatePartitionLags(endResult.value, [], false),
        };
      }
      const committedOffsets = committedResult.value.find(({ topic }) => topic === this.topic)?.partitions ?? [];
      return buildKafkaOffsetSnapshot(this.topic, this.consumerGroup, endResult.value, committedOffsets);
    } catch {
      await this.invalidateKafkaAdmin(admin);
      return unavailable;
    }
  }

  private getKafkaAdmin(): Promise<Admin> {
    if (this.kafkaAdmin && this.kafkaAdminConnected) return Promise.resolve(this.kafkaAdmin);
    if (this.kafkaAdminConnecting) return this.kafkaAdminConnecting;
    if (this.destroyed) return Promise.reject(new Error('ops-health-shutdown'));

    const admin = this.kafkaAdmin ?? (this.kafkaAdmin = this.kafka.admin());
    const connecting = withTimeout(admin.connect(), PROBE_TIMEOUT_MS)
      .then(() => {
        if (this.destroyed) throw new Error('ops-health-shutdown');
        this.kafkaAdminConnected = true;
        return admin;
      })
      .catch(async (error: unknown) => {
        this.kafkaAdminConnected = false;
        await withTimeout(admin.disconnect(), KAFKA_DISCONNECT_TIMEOUT_MS).catch(() => undefined);
        throw error;
      });
    this.kafkaAdminConnecting = connecting;
    void connecting.finally(() => {
      if (this.kafkaAdminConnecting === connecting) this.kafkaAdminConnecting = undefined;
    }).catch(() => undefined);
    return connecting;
  }

  private async invalidateKafkaAdmin(expected?: Admin): Promise<void> {
    const admin = this.kafkaAdmin;
    if (!admin || (expected && admin !== expected)) return;
    this.kafkaAdminConnected = false;
    await withTimeout(admin.disconnect(), KAFKA_DISCONNECT_TIMEOUT_MS).catch(() => undefined);
  }
}
