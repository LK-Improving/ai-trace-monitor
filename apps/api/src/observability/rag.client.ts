import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AiAdapterError, beginObservation, httpError, providerEndpoint, readProviderJson } from './ai-observation';
import type { TraceContext } from './trace-context';

export interface RagDocument {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

export interface QdrantRagClientOptions {
  baseUrl: string;
  collection: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface RagRetrieveInput {
  vector: number[];
  topK: number;
  signal?: AbortSignal;
  rerank?: (documents: RagDocument[], signal?: AbortSignal) => Promise<RagDocument[]>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const MAX_VECTOR_DIMENSIONS = 4_096;
const MAX_TOP_K = 100;
const MAX_RERANK_SNAPSHOT_ITEMS = 20;
const COLLECTION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

interface ValidatedInput {
  vector: number[];
  topK: number;
  signal?: AbortSignal;
  rerank?: RagRetrieveInput['rerank'];
}

interface Deadline {
  readonly signal: AbortSignal;
  run<T>(operation: () => T | PromiseLike<T>): Promise<T>;
  error(): AiAdapterError | undefined;
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOwnData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !('value' in descriptor)) throw new AiAdapterError('invalid_response');
  return descriptor.value;
}

function readOptionalOwnData(
  record: Record<string, unknown>,
  key: string,
): { present: boolean; value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { present: false };
  if (!('value' in descriptor)) throw new AiAdapterError('invalid_response');
  return { present: true, value: descriptor.value };
}

function safeAdapterError(error: unknown, fallback: ConstructorParameters<typeof AiAdapterError>[0]): AiAdapterError {
  try {
    if (error instanceof AiAdapterError) return error;
  } catch {
    // Hostile thrown values never become telemetry or public error details.
  }
  return new AiAdapterError(fallback);
}

function validateInput(input: RagRetrieveInput): ValidatedInput {
  try {
    if (!isRecord(input)) throw new Error();
    const vectorValue = readOwnData(input, 'vector');
    const topK = readOwnData(input, 'topK');
    if (!Array.isArray(vectorValue) || vectorValue.length < 1 || vectorValue.length > MAX_VECTOR_DIMENSIONS) {
      throw new Error();
    }
    if (!Number.isInteger(topK) || (topK as number) < 1 || (topK as number) > MAX_TOP_K) throw new Error();

    const vector: number[] = [];
    for (let index = 0; index < vectorValue.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(vectorValue, String(index));
      if (!descriptor || !('value' in descriptor)) throw new Error();
      const value = descriptor.value;
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        throw new Error();
      }
      vector.push(value);
    }

    const signalField = readOptionalOwnData(input, 'signal');
    const signal = signalField.value;
    if (signalField.present && signal !== undefined) {
      if (typeof signal !== 'object' || signal === null
        || typeof (signal as AbortSignal).addEventListener !== 'function'
        || typeof (signal as AbortSignal).removeEventListener !== 'function'
        || typeof (signal as AbortSignal).aborted !== 'boolean') throw new Error();
    }

    const rerankField = readOptionalOwnData(input, 'rerank');
    const rerank = rerankField.value;
    if (rerankField.present && rerank !== undefined && typeof rerank !== 'function') throw new Error();

    return {
      vector,
      topK: topK as number,
      ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
      ...(rerank === undefined ? {} : { rerank: rerank as RagRetrieveInput['rerank'] }),
    };
  } catch {
    throw new AiAdapterError('invalid_request');
  }
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new AiAdapterError('invalid_request');
  }
  return timeoutMs;
}

function createDeadline(timeoutMs: number, externalSignal?: AbortSignal): Deadline {
  const controller = new AbortController();
  let rejectDeadline!: (error: AiAdapterError) => void;
  let terminalError: AiAdapterError | undefined;
  let timer: NodeJS.Timeout | undefined;
  const deadlinePromise = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  // Keep the deferred rejection observed even if cancellation races with cleanup.
  void deadlinePromise.catch(() => undefined);

  const fail = (error: AiAdapterError): void => {
    if (terminalError) return;
    terminalError = error;
    controller.abort();
    rejectDeadline(error);
  };
  const onExternalAbort = (): void => fail(new AiAdapterError('cancelled'));

  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  if (!terminalError) {
    timer = setTimeout(() => fail(new AiAdapterError('timeout')), timeoutMs);
  }

  return {
    signal: controller.signal,
    run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
      if (terminalError) return Promise.reject(terminalError);
      const work = Promise.resolve().then(operation);
      return Promise.race([work, deadlinePromise]);
    },
    error: () => terminalError,
    dispose(): void {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function pointIdKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function hashPointId(id: string | number): string {
  return createHash('sha256').update(String(id), 'utf8').digest('hex');
}

function validPointId(id: unknown): id is string | number {
  return typeof id === 'string' ? id.length > 0 && id.length <= 256
    : typeof id === 'number' && Number.isSafeInteger(id) && id >= 0;
}

function validateDocument(value: unknown): RagDocument {
  if (!isRecord(value)) throw new AiAdapterError('invalid_response');
  const id = readOwnData(value, 'id');
  const score = readOwnData(value, 'score');
  if (!validPointId(id)
    || typeof score !== 'number' || !Number.isFinite(score)) throw new AiAdapterError('invalid_response');

  const payloadField = readOptionalOwnData(value, 'payload');
  if (payloadField.present && payloadField.value !== null && !isRecord(payloadField.value)) throw new AiAdapterError('invalid_response');
  return {
    id,
    score,
    ...(payloadField.present && payloadField.value !== null ? { payload: payloadField.value as Record<string, unknown> } : {}),
  };
}

function parseQdrantPoints(value: unknown, topK: number): RagDocument[] {
  try {
    if (!isRecord(value)) throw new Error();
    const result = readOwnData(value, 'result');
    if (!isRecord(result)) throw new Error();
    const points = readOwnData(result, 'points');
    if (!Array.isArray(points) || points.length > topK || points.length > MAX_TOP_K) throw new Error();

    const documents: RagDocument[] = [];
    const ids = new Set<string>();
    for (let index = 0; index < points.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(points, String(index));
      if (!descriptor || !('value' in descriptor)) throw new Error();
      const document = validateDocument(descriptor.value);
      const key = pointIdKey(document.id);
      if (ids.has(key)) throw new Error();
      ids.add(key);
      documents.push(document);
    }
    return documents;
  } catch {
    throw new AiAdapterError('invalid_response');
  }
}

function cloneDocuments(documents: RagDocument[]): RagDocument[] {
  return documents.map(document => ({
    id: document.id,
    score: document.score,
    ...(document.payload === undefined
      ? {}
      : { payload: JSON.parse(JSON.stringify(document.payload)) as Record<string, unknown> }),
  }));
}

function validateRerankedDocuments(value: unknown, recalled: RagDocument[]): RagDocument[] {
  try {
    if (!Array.isArray(value) || value.length > recalled.length || value.length > MAX_TOP_K) throw new Error();
    const originalById = new Map(recalled.map(document => [pointIdKey(document.id), document]));
    const usedIds = new Set<string>();
    const reranked: RagDocument[] = [];

    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !isRecord(descriptor.value)) throw new Error();
      const candidate = descriptor.value;
      const id = readOwnData(candidate, 'id');
      const score = readOwnData(candidate, 'score');
      if (!validPointId(id)
        || typeof score !== 'number' || !Number.isFinite(score)) throw new Error();

      const key = pointIdKey(id);
      const original = originalById.get(key);
      if (!original || usedIds.has(key)) throw new Error();
      const payload = readOptionalOwnData(candidate, 'payload');
      if (payload.present && !isRecord(payload.value)) throw new Error();
      usedIds.add(key);
      // Keep Qdrant payload intact; rerankers may change scores and order, not point content.
      reranked.push({
        id: original.id,
        score,
        ...(original.payload === undefined ? {} : { payload: original.payload }),
      });
    }
    return reranked;
  } catch {
    throw new AiAdapterError('invalid_response');
  }
}

function rankSnapshot(documents: RagDocument[]): {
  items: Array<{ idHash: string; rank: number; score: number }>;
  total_count: number;
  truncated: boolean;
} {
  return {
    items: documents.slice(0, MAX_RERANK_SNAPSHOT_ITEMS).map((document, index) => ({
      idHash: hashPointId(document.id),
      rank: index + 1,
      score: document.score,
    })),
    total_count: documents.length,
    truncated: documents.length > MAX_RERANK_SNAPSHOT_ITEMS,
  };
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

export class QdrantRagClient {
  private readonly baseEndpoint: URL;
  private readonly collection: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(private readonly context: TraceContext, options: QdrantRagClientOptions) {
    try {
      if (!options || typeof options !== 'object') throw new Error();
      if (typeof options.collection !== 'string' || !COLLECTION_PATTERN.test(options.collection)) throw new Error();
      if (options.apiKey !== undefined
        && (typeof options.apiKey !== 'string' || /[\r\n]/.test(options.apiKey))) throw new Error();
      this.baseEndpoint = providerEndpoint(options.baseUrl);
      this.collection = options.collection;
      this.apiKey = options.apiKey;
      this.timeoutMs = normalizeTimeout(options.timeoutMs);
    } catch (error) {
      throw safeAdapterError(error, 'invalid_request');
    }
  }

  async retrieve(input: RagRetrieveInput): Promise<RagDocument[]> {
    const observation = beginObservation(this.context, 'rag.retrieve');
    return observation.run(async () => {
      let deadline: Deadline | undefined;
      try {
        const request = validateInput(input);
        observation.set('topK', request.topK);
        deadline = createDeadline(this.timeoutMs, request.signal);

        const endpoint = new URL(this.baseEndpoint.toString());
        endpoint.pathname = `${endpoint.pathname}collections/${encodeURIComponent(this.collection)}/points/query`;

        const recallObservation = beginObservation(this.context, 'rag.recall');
        const recallStartedAt = performance.now();
        let documents: RagDocument[];
        try {
          documents = await recallObservation.run(() => deadline!.run(async () => {
            const headers: Record<string, string> = {
              accept: 'application/json',
              'content-type': 'application/json',
            };
            if (this.apiKey !== undefined) headers['api-key'] = this.apiKey;

            const response = await fetch(endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                query: request.vector,
                limit: request.topK,
                with_payload: true,
                with_vector: false,
              }),
              redirect: 'error',
              signal: deadline!.signal,
            });
            if (!response.ok) {
              try { void response.body?.cancel().catch(() => undefined); } catch { /* best-effort connection cleanup */ }
              throw httpError(response.status);
            }
            return parseQdrantPoints(await readProviderJson(response), request.topK);
          }));
          observation.set('rag.recall_ms', elapsedMs(recallStartedAt));
          observation.set('rag.recalled_count', documents.length);
          observation.set('rag.empty', documents.length === 0);
          observation.set('sources', documents.slice(0, MAX_TOP_K).map(document => hashPointId(document.id)));
          observation.set('rag.rerank_ms', 0);
          recallObservation.finish();
        } catch (error) {
          const safeError = safeAdapterError(error, 'network_error');
          observation.set('rag.recall_ms', elapsedMs(recallStartedAt));
          recallObservation.finish(safeError);
          throw safeError;
        }

        if (request.rerank) {
          const rerankObservation = beginObservation(this.context, 'rag.rerank');
          const rerankStartedAt = performance.now();
          observation.set('rag.rerank_before', rankSnapshot(documents));
          let rerankedValue: unknown;
          try {
            rerankedValue = await rerankObservation.run(() => deadline!.run(
              () => request.rerank!(cloneDocuments(documents), deadline!.signal),
            ));
          } catch (error) {
            const deadlineError = deadline.error();
            const safeError = deadlineError && error === deadlineError
              ? deadlineError
              : new AiAdapterError('provider_error');
            observation.set('rag.rerank_ms', elapsedMs(rerankStartedAt));
            rerankObservation.finish(safeError);
            throw safeError;
          }

          try {
            documents = validateRerankedDocuments(rerankedValue, documents);
          } catch {
            const safeError = new AiAdapterError('invalid_response');
            observation.set('rag.rerank_ms', elapsedMs(rerankStartedAt));
            rerankObservation.finish(safeError);
            throw safeError;
          }
          observation.set('rag.rerank_ms', elapsedMs(rerankStartedAt));
          observation.set('rag.rerank_after', rankSnapshot(documents));
          rerankObservation.finish();
        }

        observation.finish();
        return documents;
      } catch (error) {
        const safeError = safeAdapterError(error, 'provider_error');
        observation.finish(safeError);
        throw safeError;
      } finally {
        deadline?.dispose();
      }
    });
  }
}
