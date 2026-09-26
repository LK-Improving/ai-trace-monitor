import { KafkaJSError } from 'kafkajs';

const DEFAULT_HEARTBEAT_PERIOD_MS = 1_000;

export type ClickHouseSinkOptions<Row> = {
  insert(rows: Row[]): Promise<unknown>;
  heartbeat(): Promise<void>;
  canContinue(): boolean;
  heartbeatPeriodMs?: number;
};

/** Write one ClickHouse batch while keeping the Kafka consumer session alive. */
export async function insertWithHeartbeat<Row>(
  rows: Row[],
  options: ClickHouseSinkOptions<Row>,
): Promise<void> {
  const heartbeatPeriodMs = options.heartbeatPeriodMs ?? DEFAULT_HEARTBEAT_PERIOD_MS;
  let stopped = false;
  let heartbeatFailed = false;
  let insertFailed = false;
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
        // Discard Kafka's error object; it may contain details that should not
        // be retained or exposed by the Collector.
        heartbeatFailed = true;
        return;
      }
    }
  })();

  try {
    if (options.canContinue()) await options.insert(rows);
  } catch {
    // ClickHouse errors may contain request/response details. Keep no reference
    // to the original error and expose only a fixed KafkaJS retry signal below.
    insertFailed = true;
  } finally {
    stopped = true;
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
    const wake = wakeHeartbeat;
    wakeHeartbeat = undefined;
    wake?.();
    // Wait for an already-running heartbeat so its failure cannot be missed
    // before the caller advances to the offset commit step.
    await heartbeatLoop;
  }

  // A shutdown or partition reassignment must leave the batch uncommitted.
  if (!options.canContinue()) return;
  if (heartbeatFailed) {
    throw new KafkaJSError('Kafka heartbeat failed during ClickHouse batch insert', { retriable: true });
  }
  if (insertFailed) {
    throw new KafkaJSError('ClickHouse batch insert failed', { retriable: true });
  }
}
