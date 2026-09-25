import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  async check() {
    try {
      await this.database.ping();
      return { status: 'ok', dependencies: { postgres: 'ok' }, checkedAt: new Date().toISOString() };
    } catch {
      return { status: 'degraded', dependencies: { postgres: 'unavailable' }, checkedAt: new Date().toISOString() };
    }
  }
}
