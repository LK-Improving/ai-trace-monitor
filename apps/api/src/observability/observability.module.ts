import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { SpansModule } from '../spans/spans.module';
import { HttpTraceInterceptor } from './http-trace.interceptor';
import { TraceContext } from './trace-context';
import { TraceObservabilityService } from './trace-observability.service';
import { AiAdaptersService } from './ai-adapters.service';

@Module({
  imports: [SpansModule],
  providers: [
    TraceObservabilityService,
    TraceContext,
    AiAdaptersService,
    { provide: APP_INTERCEPTOR, useClass: HttpTraceInterceptor },
  ],
  exports: [TraceContext, TraceObservabilityService, AiAdaptersService],
})
export class ObservabilityModule {}
