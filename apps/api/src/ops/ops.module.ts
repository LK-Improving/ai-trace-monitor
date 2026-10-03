import { Module } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { DatabaseModule } from '../database/database.module';
import { OverviewModule } from '../overview/overview.module';
import { SpansModule } from '../spans/spans.module';
import { OpsHealthController } from './ops-health.controller';
import { OpsHealthService } from './ops-health.service';

@Module({
  imports: [DatabaseModule, OverviewModule, SpansModule],
  controllers: [OpsHealthController],
  providers: [AdminTokenGuard, OpsHealthService],
})
export class OpsModule {}
