import { Module } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { AlertsController } from './alerts.controller';
import { AlertsDatabase } from './alerts.database';
import { AlertsService } from './alerts.service';
import { AlertNotificationsService } from './alert-notifications.service';
import { AlertNotificationWorker } from './alert-notifications.worker';

@Module({
  controllers: [AlertsController],
  providers: [AdminTokenGuard, AlertsDatabase, AlertsService, AlertNotificationsService, AlertNotificationWorker],
})
export class AlertsModule {}
