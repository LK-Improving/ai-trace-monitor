import { Module } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { DatabaseModule } from '../database/database.module';
import { OverviewModule } from '../overview/overview.module';
import { MetricsController } from './metrics.controller';
import { MetricsOverviewService } from './metrics-overview.service';
import { AiMetricsService } from './ai-metrics.service';

@Module({ imports: [DatabaseModule, OverviewModule], controllers: [MetricsController],
  providers: [AdminTokenGuard, MetricsOverviewService, AiMetricsService] })
export class MetricsModule {}
