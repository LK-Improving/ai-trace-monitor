import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { OpsHealthService } from './ops-health.service';

@Controller('ops/health')
@UseGuards(AdminTokenGuard)
export class OpsHealthController {
  constructor(private readonly health: OpsHealthService) {}

  @Get()
  check() {
    return this.health.check();
  }
}
