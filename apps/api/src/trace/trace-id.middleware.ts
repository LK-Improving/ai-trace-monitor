import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export const TRACE_ID_HEADER = 'x-trace-id';
const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function resolveApiTraceId(
  headerValue: string | readonly string[] | null | undefined,
  generate: () => string = () => `trace_v1_${randomUUID()}`,
): string {
  const candidate = typeof headerValue === 'string'
    ? headerValue
    : Array.isArray(headerValue) && headerValue.length === 1
      ? headerValue[0]
      : undefined;
  return typeof candidate === 'string' && TRACE_ID_PATTERN.test(candidate) ? candidate : generate();
}

interface RequestWithTraceHeader {
  headers: Record<string, string | string[] | undefined>;
  traceId?: string;
}

interface ResponseWithHeaders {
  setHeader(name: string, value: string): void;
}

@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(request: RequestWithTraceHeader, response: ResponseWithHeaders, next: () => void): void {
    const traceId = resolveApiTraceId(request.headers[TRACE_ID_HEADER]);
    request.traceId = traceId;
    response.setHeader(TRACE_ID_HEADER, traceId);
    next();
  }
}
