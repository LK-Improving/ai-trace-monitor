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
