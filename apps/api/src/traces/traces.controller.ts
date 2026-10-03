import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { TraceReadGuard } from './trace-read.guard';
import { TraceListService } from './trace-list.service';
import { TraceDetailService } from './trace-detail.service';

@Controller('traces')
@UseGuards(TraceReadGuard)
export class TracesController {
  constructor(private readonly listService: TraceListService, private readonly detailService: TraceDetailService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) { return this.listService.list(query); }

  @Get(':traceId')
  detail(@Param('traceId') traceId: string, @Query() query: Record<string, unknown>) {
    return this.detailService.detail(traceId, query);
  }
}
