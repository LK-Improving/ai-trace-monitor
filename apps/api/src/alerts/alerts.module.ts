import { Module } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { AlertsController } from './alerts.controller';
import { AlertsDatabase } from './alerts.database';
import { AlertsService } from './alerts.service';

@Module({
  controllers: [AlertsController],
  providers: [AdminTokenGuard, AlertsDatabase, AlertsService],
})
export class AlertsModule {}
