import { Module } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { DatabaseModule } from '../database/database.module';
import { ClickHouseService } from './clickhouse.service';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';

@Module({
  imports: [DatabaseModule],
  controllers: [OverviewController],
  providers: [AdminTokenGuard, ClickHouseService, OverviewService],
  exports: [ClickHouseService],
})
export class OverviewModule {}
