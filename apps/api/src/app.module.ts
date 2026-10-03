import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { OverviewModule } from './overview/overview.module';
import { ObservabilityModule } from './observability/observability.module';
import { ProjectsModule } from './projects/projects.module';
import { SpansModule } from './spans/spans.module';
import { TraceIdMiddleware } from './trace/trace-id.middleware';
import { TracesModule } from './traces/traces.module';
import { MetricsModule } from './metrics/metrics.module';
import { AlertsModule } from './alerts/alerts.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '../../.env' }),
    DatabaseModule,
    ProjectsModule,
    OverviewModule,
    SpansModule,
    ObservabilityModule,
    TracesModule,
    MetricsModule,
    AlertsModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceIdMiddleware).forRoutes('{*path}');
  }
}
