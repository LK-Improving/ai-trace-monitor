import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClickHouseLogLevel, createClient } from '@clickhouse/client';

export type ClickHouseQueryParams = Record<string, string | number>;

@Injectable()
export class ClickHouseService implements OnModuleDestroy {
  private readonly client: ReturnType<typeof createClient>;

  constructor(config: ConfigService) {
    this.client = createClient({
      url: config.get<string>('CLICKHOUSE_URL') ?? 'http://localhost:8123',
      database: config.get<string>('CLICKHOUSE_DATABASE') ?? 'observability',
      username: config.get<string>('CLICKHOUSE_USER') ?? 'trace_ops',
      password: config.get<string>('CLICKHOUSE_PASSWORD') ?? 'trace_ops_dev_only',
      // ClickHouse errors may contain query or payload details; do not log them.
      log: { level: ClickHouseLogLevel.OFF },
      request_timeout: 10000,
    });
  }

  async query<Row extends Record<string, unknown>>(
    query: string,
    queryParams: ClickHouseQueryParams,
  ): Promise<Row[]> {
    try {
      const result = await this.client.query({
        query,
        query_params: queryParams,
        format: 'JSONEachRow',
        clickhouse_settings: {
          max_execution_time: 5,
          max_rows_to_read: '1000000',
          max_bytes_to_read: '67108864',
          max_result_rows: '2001',
          max_result_bytes: '8388608',
          max_memory_usage: '134217728',
          read_overflow_mode: 'throw',
          result_overflow_mode: 'throw',
        },
      });
      return await result.json<Row>();
    } catch {
      // Do not retain or forward ClickHouse's error: it can contain SQL details.
      throw new Error('Analytics query failed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }
}
