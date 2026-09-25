import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { SpanIngestService } from './span-ingest.service';

interface HttpStatusResponse {
  status(code: number): HttpStatusResponse;
}

interface SpanRequestWithTraceId {
  traceId: string;
}

@Controller('spans')
export class SpansController {
  constructor(private readonly spans: SpanIngestService) {}

  @Post()
  async ingest(
    @Body() body: unknown,
    @Req() request: SpanRequestWithTraceId,
    @Res({ passthrough: true }) response: HttpStatusResponse,
  ) {
    const result = await this.spans.ingest(body, request.traceId);
    response.status(result.status === 'queued' ? HttpStatus.ACCEPTED : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }

  @Get('status')
  @UseGuards(AdminTokenGuard)
  status() {
    return this.spans.metrics();
  }
}
