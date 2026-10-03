import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { AlertsService } from './alerts.service';

@Controller('alerts')
@UseGuards(AdminTokenGuard)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

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
}
