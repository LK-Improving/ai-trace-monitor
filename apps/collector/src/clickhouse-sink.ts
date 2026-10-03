import { KafkaJSError } from 'kafkajs';
import type { ClickHouseClient } from '@clickhouse/client';

const DEFAULT_HEARTBEAT_PERIOD_MS = 1_000;
export const CLICKHOUSE_DEDUPLICATION_WINDOW = 10_000;

type ClickHouseTableRow = { engine: string };

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error('ClickHouse database/table name is invalid');
  }
  return `\`${value}\``;
}

/** Upgrade an existing local MergeTree table before consuming Kafka messages. */
export async function ensureClickHouseInsertDeduplication(
  clickhouse: Pick<ClickHouseClient, 'query' | 'command'>,
  database: string,
  table: string,
): Promise<boolean> {
  try {
    const result = await clickhouse.query({
      query: `SELECT engine FROM system.tables
              WHERE database = {database:String} AND name = {table:String}
              LIMIT 1`,
      query_params: { database, table },
      format: 'JSONEachRow',
    });
    const rows = await result.json<ClickHouseTableRow>();
    const engine = rows[0]?.engine;
    if (engine === undefined) return false;

    if (engine.startsWith('Replicated') && engine.endsWith('MergeTree')) return true;
    if (!engine.endsWith('MergeTree')) {
      throw new Error('ClickHouse table engine does not support insert deduplication');
    }

    await clickhouse.command({
      query: `ALTER TABLE ${quoteIdentifier(database)}.${quoteIdentifier(table)}
              MODIFY SETTING non_replicated_deduplication_window = ${CLICKHOUSE_DEDUPLICATION_WINDOW}`,
    });
    return true;
  } catch {
    // Do not leak credentials, SQL or server response details into Collector logs.
    throw new Error('ClickHouse insert deduplication setup failed');
  }
}

export type ClickHouseSinkOptions<Row> = {
  insert(rows: Row[]): Promise<unknown>;
  heartbeat(): Promise<void>;
  canContinue(): boolean;
  heartbeatPeriodMs?: number;
};

export type HeartbeatOperationOptions = {
  heartbeat(): Promise<void>;
  canContinue(): boolean;
  operationName: string;
  heartbeatPeriodMs?: number;
};

/** Run a persistence operation while keeping its Kafka consumer session alive. */
export async function runWithHeartbeat<Result>(
  operation: () => Promise<Result>,
  options: HeartbeatOperationOptions,
): Promise<Result> {
  const heartbeatPeriodMs = options.heartbeatPeriodMs ?? DEFAULT_HEARTBEAT_PERIOD_MS;
  let stopped = false;
  let heartbeatFailed = false;
  let operationFailed = false;
  let operationResult: Result;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeHeartbeat: (() => void) | undefined;

  const heartbeatLoop = (async () => {
    while (!stopped) {
      await new Promise<void>((resolve) => {
        heartbeatTimer = setTimeout(resolve, heartbeatPeriodMs);
        wakeHeartbeat = () => {
          if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
          heartbeatTimer = undefined;
          resolve();
        };
      });
      heartbeatTimer = undefined;
      wakeHeartbeat = undefined;

      if (stopped || !options.canContinue()) return;
      try {
        await options.heartbeat();
      } catch {
        // Keep payload-adjacent broker details out of Collector errors.
        heartbeatFailed = true;
        return;
      }
    }
  })();

  try {
    if (options.canContinue()) operationResult = await operation();
  } catch {
    // Persistence/provider errors may include SQL, payload or server details.
    operationFailed = true;
  } finally {
    stopped = true;
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
    const wake = wakeHeartbeat;
    wakeHeartbeat = undefined;
    wake?.();
    await heartbeatLoop;
  }

  // A shutdown or partition reassignment must leave the batch uncommitted.
  if (!options.canContinue()) return operationResult!;
  if (heartbeatFailed) {
    throw new KafkaJSError(`${options.operationName} heartbeat failed`, { retriable: true });
  }
  if (operationFailed) {
    throw new KafkaJSError(`${options.operationName} failed`, { retriable: true });
  }
  return operationResult!;
}

/** Write one ClickHouse batch while keeping the Kafka consumer session alive. */
export async function insertWithHeartbeat<Row>(
  rows: Row[],
  options: ClickHouseSinkOptions<Row>,
): Promise<void> {
  await runWithHeartbeat(() => options.insert(rows), {
    heartbeat: options.heartbeat,
    canContinue: options.canContinue,
    operationName: 'ClickHouse batch insert',
    heartbeatPeriodMs: options.heartbeatPeriodMs,
  });
}
