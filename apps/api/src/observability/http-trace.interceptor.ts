import { Injectable, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { resolveApiTraceId, TRACE_ID_HEADER } from '../trace/trace-id.middleware';
import { TraceObservabilityService } from './trace-observability.service';
import { TraceContext } from './trace-context';

const HTTP_TRACE_FAILURE = new Error('HTTP request ended with an error');

interface HttpTraceRequest {
  method?: string;
  path?: string;
  route?: { path?: string | string[] };
  headers: Record<string, string | string[] | undefined>;
  traceId?: string;
}

interface HttpTraceResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  once(event: 'finish' | 'close', listener: () => void): unknown;
  removeListener(event: 'finish' | 'close', listener: () => void): unknown;
}

const API_PREFIX = '/api/v1';

function isExcludedPath(requestPath: string | undefined): boolean {
  if (typeof requestPath !== 'string') return false;

  const pathWithoutQuery = requestPath.split('?', 1)[0];
  const trimmedPath = pathWithoutQuery.length > 1
    ? pathWithoutQuery.replace(/\/+$/, '')
    : pathWithoutQuery;
  const path = trimmedPath.startsWith(`${API_PREFIX}/`)
    ? trimmedPath.slice(API_PREFIX.length)
    : trimmedPath;

  return path === '/health'
    || path === '/spans'
    || path.startsWith('/spans/');
}

@Injectable()
export class HttpTraceInterceptor implements NestInterceptor {
  constructor(
    private readonly observability: TraceObservabilityService,
    private readonly traceContext: TraceContext,
  ) {}

  intercept(context: ExecutionContext, next: { handle(): Observable<unknown> }): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<HttpTraceRequest>();
    if (isExcludedPath(request.path)) return next.handle();

    const recorder = this.observability.recorder();
    if (!recorder) return next.handle();

    const response = http.getResponse<HttpTraceResponse>();
    const traceId = resolveApiTraceId(request.traceId ?? request.headers[TRACE_ID_HEADER]);
    request.traceId = traceId;
    response.setHeader(TRACE_ID_HEADER, traceId);

    return new Observable((subscriber) => {
      const span = recorder.start('http.server', traceId);
      if (typeof request.method === 'string') span.set('http.method', request.method);
      if (typeof request.route?.path === 'string') span.set('http.route', request.route.path);

      let spanError: unknown;
      let hasSpanError = false;
      let responseFinished = false;
      let ended = false;
      const complete = (statusCode: number, responseFailed: boolean): void => {
        if (ended) return;
        ended = true;
        try { response.removeListener('finish', onFinish); } catch { /* best-effort cleanup */ }
        try { response.removeListener('close', onClose); } catch { /* best-effort cleanup */ }
        try {
          span.set('http.status_code', statusCode);
          const failure = hasSpanError
            ? (spanError === undefined ? HTTP_TRACE_FAILURE : spanError)
            : responseFailed
              ? HTTP_TRACE_FAILURE
              : undefined;
          span.end(failure);
        } catch {
          // Tracing must never throw from a response event or change the business response.
        }
      };
      const onFinish = (): void => {
        responseFinished = true;
        const statusCode = response.statusCode;
        complete(statusCode, statusCode >= 400);
      };
      const onClose = (): void => {
        if (responseFinished) return;
        // An unfinished response is a client disconnect, even if Node still reports its
        // default 200 status. Use 499 because request/response span attributes stay bounded.
        complete(499, true);
      };
      response.once('finish', onFinish);
      response.once('close', onClose);

      let subscription: { unsubscribe(): void } | undefined;
      try {
        subscription = this.traceContext.run(recorder, span, () => {
          const source = next.handle();
          return source.subscribe({
            next: (value) => this.traceContext.run(recorder, span, () => subscriber.next(value)),
            error: (error: unknown) => {
              hasSpanError = true;
              spanError = error;
              this.traceContext.run(recorder, span, () => subscriber.error(error));
            },
            complete: () => this.traceContext.run(recorder, span, () => subscriber.complete()),
          });
        });
      } catch (error) {
        hasSpanError = true;
        spanError = error;
        this.traceContext.run(recorder, span, () => subscriber.error(error));
      }

      return () => subscription?.unsubscribe();
    });
  }
}
