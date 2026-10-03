import {
  HttpException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ALERT_SCHEMA_LOCK_ID = '7321198204142';

function alertSchemaSql(): string {
  const configuredPath = process.env.TRACE_OPS_ALERT_SCHEMA_PATH;
  if (configuredPath) {
    const path = resolve(configuredPath);
    if (!existsSync(path)) throw new Error('Alert schema migration file is unavailable');
    const roots = [process.cwd(), resolve(process.cwd(), '../..'), resolve(__dirname, '../../../../')];
    const securityMigration = roots
      .map((root) => resolve(root, 'infra/postgres/init/004-project-access-privacy-audit.sql'))
      .find(existsSync);
    if (!securityMigration) throw new Error('Project access migration file is unavailable');
    return [readFileSync(path, 'utf8'), readFileSync(securityMigration, 'utf8')].join('\n');
  }
  const roots = [
    process.cwd(),
    resolve(process.cwd(), '../..'),
    resolve(__dirname, '../../../../'),
  ];
  for (const root of roots) {
    const paths = [
      resolve(root, 'infra/postgres/init/002-alerts.sql'),
      resolve(root, 'infra/postgres/init/003-alert-notifications.sql'),
      resolve(root, 'infra/postgres/init/004-project-access-privacy-audit.sql'),
    ];
    if (paths.every(existsSync)) return paths.map((path) => readFileSync(path, 'utf8')).join('\n');
  }
  throw new Error('Alert schema migration files are unavailable');
}

@Injectable()
export class AlertsDatabase implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.get<string>('DATABASE_URL'),
      max: 5,
      connectionTimeoutMillis: 5_000,
    });
  }

  async onModuleInit(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [ALERT_SCHEMA_LOCK_ID]);
      await client.query(alertSchemaSql());
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error('Alert schema migration failed');
    } finally {
      client.release();
    }
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    try {
      return await this.pool.query<T>(text, values as unknown[]);
    } catch (error) {
      throw new Error('Alert storage query failed', { cause: error });
    }
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof HttpException) throw error;
      throw new Error('Alert storage transaction failed');
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
