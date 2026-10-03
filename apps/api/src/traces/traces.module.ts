import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { OverviewModule } from '../overview/overview.module';
import { TracesController } from './traces.controller';
import { TraceListService } from './trace-list.service';
import { TraceDetailService } from './trace-detail.service';
import { TraceReadGuard } from './trace-read.guard';

@Module({
  imports: [DatabaseModule, OverviewModule],
  controllers: [TracesController],
  providers: [TraceReadGuard, TraceListService, TraceDetailService],
})
export class TracesModule {}
