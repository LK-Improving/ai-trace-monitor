import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActiveSpan, TraceRecorder } from './trace-recorder';

const UNDEFINED_SPAN_FAILURE = new Error('Trace span failed with undefined');

export interface ActiveTraceContext {
  recorder: TraceRecorder;
  span: ActiveSpan;
}

@Injectable()
export class TraceContext {
  private readonly storage = new AsyncLocalStorage<ActiveTraceContext>();

  run<T>(recorder: TraceRecorder, span: ActiveSpan, fn: () => T): T {
    return this.storage.run({ recorder, span }, fn);
  }

  current(): ActiveTraceContext | undefined {
    return this.storage.getStore();
  }

  async withSpan<T>(operation: string, fn: (span: ActiveSpan) => Promise<T> | T): Promise<T> {
    const parent = this.current();
    if (!parent) {
      throw new Error('TraceContext.withSpan requires an active trace context');
    }

    const span = parent.recorder.start(operation, parent.span.traceId, parent.span.id);
    let failed = false;
    let failure: unknown;

    try {
      return await this.run(parent.recorder, span, () => fn(span));
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      span.end(failed ? (failure === undefined ? UNDEFINED_SPAN_FAILURE : failure) : undefined);
    }
  }
}
