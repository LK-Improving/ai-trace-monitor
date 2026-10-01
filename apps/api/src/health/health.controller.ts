import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { TraceObservabilityService } from '../observability/trace-observability.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly tracing: TraceObservabilityService,
  ) {}

  @Get()
  async check() {
    try {
      await this.database.ping();
      return { status: 'ok', dependencies: { postgres: 'ok' }, tracing: this.tracing.status(), checkedAt: new Date().toISOString() };
    } catch {
      return { status: 'degraded', dependencies: { postgres: 'unavailable' }, tracing: this.tracing.status(), checkedAt: new Date().toISOString() };
    }
  }
}
