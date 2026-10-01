import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { OverviewService } from './overview.service';

@Controller('overview')
@UseGuards(AdminTokenGuard)
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get()
  getOverview(@Query() query: Record<string, unknown>) {
    return this.overview.getOverview(query);
  }
}
