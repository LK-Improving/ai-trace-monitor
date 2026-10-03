import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export const TRACE_ID_HEADER = 'x-trace-id';
export const PARENT_SPAN_ID_HEADER = 'x-parent-span-id';
const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PARENT_SPAN_ID_PATTERN = /^[0-9a-f]{32}$/;

function singleHeaderValue(headerValue: string | readonly string[] | null | undefined): string | undefined {
  const candidate = typeof headerValue === 'string'
    ? headerValue
    : Array.isArray(headerValue) && headerValue.length === 1
      ? headerValue[0]
      : undefined;
  return typeof candidate === 'string' ? candidate : undefined;
}

function validApiTraceId(headerValue: string | readonly string[] | null | undefined): string | undefined {
  const candidate = singleHeaderValue(headerValue);
  return candidate !== undefined && TRACE_ID_PATTERN.test(candidate) ? candidate : undefined;
}

function generateApiTraceId(): string {
  return `trace_v1_${randomUUID()}`;
}

export function resolveApiTraceId(
  headerValue: string | readonly string[] | null | undefined,
  generate: () => string = generateApiTraceId,
): string {
  return validApiTraceId(headerValue) ?? generate();
}

export function resolveApiParentSpanId(
  headerValue: string | readonly string[] | null | undefined,
): string | undefined {
  const candidate = singleHeaderValue(headerValue);
  return typeof candidate === 'string' && PARENT_SPAN_ID_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

interface RequestWithTraceHeader {
  headers: Record<string, string | string[] | undefined>;
  traceId?: string;
  parentSpanId?: string;
}

interface ResponseWithHeaders {
  setHeader(name: string, value: string): void;
}

@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(request: RequestWithTraceHeader, response: ResponseWithHeaders, next: () => void): void {
    const incomingTraceId = validApiTraceId(request.headers[TRACE_ID_HEADER]);
    const traceId = incomingTraceId ?? generateApiTraceId();
    request.traceId = traceId;
    request.parentSpanId = incomingTraceId
      ? resolveApiParentSpanId(request.headers[PARENT_SPAN_ID_HEADER])
      : undefined;
    response.setHeader(TRACE_ID_HEADER, traceId);
    next();
  }
}
