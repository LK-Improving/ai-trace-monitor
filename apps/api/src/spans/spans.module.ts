import { Module } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { SpansController } from './spans.controller';
import { SpanIngestService } from './span-ingest.service';
import { SpanKafkaQueue } from './span-kafka-queue.service';

@Module({
  controllers: [SpansController],
  providers: [AdminTokenGuard, SpanIngestService, SpanKafkaQueue],
  exports: [SpanKafkaQueue],
})
export class SpansModule {}
