import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, QueryResult, QueryResultRow } from 'pg';

export const HEALTH_PROBE_POOL_OPTIONS = {
  max: 1,
  connectionTimeoutMillis: 1_200,
  query_timeout: 1_200,
  statement_timeout: 1_200,
  application_name: 'trace-ops-health-probe',
} as const;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;
  private readonly healthPool: Pool;

  constructor(config: ConfigService) {
    const connectionString = config.get<string>('DATABASE_URL');
    this.pool = new Pool({ connectionString });
    this.healthPool = new Pool({ connectionString, ...HEALTH_PROBE_POOL_OPTIONS });

    // `pg.Pool` emits `error` for idle-client socket failures. Pool is an
    // EventEmitter, so leaving this event unhandled would escalate it as an
    // uncaught error. Consume it without logging or retaining the raw Error;
    // active query failures still reject through the `query()` Promise.
    const consumeIdleClientError = (): void => undefined;
    this.pool.on('error', consumeIdleClientError);
    this.healthPool.on('error', consumeIdleClientError);
  }

  async ping(): Promise<void> {
    await this.healthPool.query('SELECT 1');
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, values as unknown[]);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.pool.end(), this.healthPool.end()]);
  }
}
