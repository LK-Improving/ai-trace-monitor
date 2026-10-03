import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { AlertsService } from './alerts.service';
import { AlertNotificationsService } from './alert-notifications.service';

@Controller('alerts')
@UseGuards(AdminTokenGuard)
export class AlertsController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly notifications: AlertNotificationsService,
  ) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.alerts.list(query);
  }

  @Get('summary')
  summary(@Query() query: Record<string, unknown>) {
    return this.alerts.summary(query);
  }

  @Patch(':id/state')
  updateState(@Param('id') id: string, @Body() body: unknown) {
    return this.alerts.updateState(id, body);
  }

  @Get('channels')
  listChannels(@Query() query: Record<string, unknown>) {
    return this.notifications.listChannels(query);
  }

  @Post('channels')
  createChannel(@Body() body: unknown) {
    return this.notifications.createChannel(body);
  }

  @Patch('channels/:id')
  patchChannel(@Param('id') id: string, @Body() body: unknown) {
    return this.notifications.patchChannel(id, body);
  }

  @Delete('channels/:id')
  deleteChannel(@Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.notifications.deleteChannel(id, query);
  }

  @Post('channels/:id/test')
  testChannel(@Param('id') id: string, @Body() body: unknown) {
    return this.notifications.testChannel(id, body);
  }

  @Get('deliveries')
  listDeliveries(@Query() query: Record<string, unknown>) {
    return this.notifications.listDeliveries(query);
  }

  @Post('deliveries/:id/retry')
  retryDelivery(@Param('id') id: string, @Body() body: unknown) {
    return this.notifications.retryDelivery(id, body);
  }
}
