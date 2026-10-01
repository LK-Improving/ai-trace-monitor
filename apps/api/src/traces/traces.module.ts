import { Module } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { DatabaseModule } from '../database/database.module';
import { OverviewModule } from '../overview/overview.module';
import { TracesController } from './traces.controller';
import { TraceListService } from './trace-list.service';
import { TraceDetailService } from './trace-detail.service';

@Module({
  imports: [DatabaseModule, OverviewModule],
  controllers: [TracesController],
  providers: [AdminTokenGuard, TraceListService, TraceDetailService],
})
export class TracesModule {}
