import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { MetricsOverviewService } from './metrics-overview.service';
import { AiMetricsService } from './ai-metrics.service';

@Controller('metrics')
@UseGuards(AdminTokenGuard)
export class MetricsController {
  constructor(private readonly overview: MetricsOverviewService, private readonly ai: AiMetricsService) {}

  @Get('overview')
  getOverview(@Query() query: Record<string, unknown>) { return this.overview.getOverview(query); }

  @Get('ai')
  getAiMetrics(@Query() query: Record<string, unknown>) { return this.ai.getMetrics(query); }
}
