import { TraceDetailQuery } from './trace-query';

const MAX_SPANS = 2_000;
const MAX_FETCHED_SPANS = MAX_SPANS + 1;
const MAX_ATTRIBUTE_JSON_LENGTH = 64 * 1024;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const ERROR_CATEGORIES = new Set([
  'rate_limit',
  'timeout',
  'authentication',
  'content_filter',
  'provider_error',
  'network_error',
  'invalid_response',
  'cancelled',
  'invalid_request',
]);
const FINISH_REASONS = new Set([
  'stop',
  'length',
  'tool_calls',
  'function_call',
  'content_filter',
  'unknown',
  'other',
]);
const HTTP_METHODS = new Set([
  'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE',
]);

type SpanStatus = 'ok' | 'error';

export interface SpanView {
  spanId: string;
  parentSpanId: string | null;
  service: string;
  operation: string;
  status: SpanStatus;
  startTime: string;
  endTime: string;
  durationMs: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  attributes: Record<string, unknown>;
}

export interface TraceDetailResponse {
  traceId: string;
  projectId: string;
  environment: TraceDetailQuery['environment'];
  rootSpan: SpanView | null;
  spans: SpanView[];
  summary: {
    spanCount: number;
    durationMs: number;
    totalTokens: number;
    status: SpanStatus;
    truncated: boolean;
  };
  errors: Array<{ spanId: string; category: string }>;
  redaction: { contentIncluded: false };
  tree: {
    roots: string[];
    nodes: Array<{ spanId: string; parentSpanId: string | null; children: string[] }>;
    orphanSpanIds: string[];
    cycleSpanIds: string[];
    multipleRoots: boolean;
  };
}

interface NormalizedSpan extends SpanView {
  startMs: number;
  endMs: number;
  eventMs: number;
  rawModel: string;
  attributesJson: string;
}

function invalidStorageResult(): never {
  throw new Error('Invalid trace storage result');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isContractId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function timestamp(value: unknown): { iso: string; milliseconds: number } {
  let parsed: Date;
  if (value instanceof Date) {
    parsed = value;
  } else if (typeof value === 'string' && value.length <= 40) {
    const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
      ? value
      : `${value.replace(' ', 'T')}Z`;
    parsed = new Date(normalized);
  } else {
    return invalidStorageResult();
  }

  const milliseconds = parsed.getTime();
  if (!Number.isFinite(milliseconds)) return invalidStorageResult();
  return { iso: parsed.toISOString(), milliseconds };
}

function numericValue(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
    return invalidStorageResult();
  }
  return parsed;
}

function tokenValue(value: unknown): number {
  const digits = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)
      ? value
      : '';
  if (!digits || BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER)) {
    return invalidStorageResult();
  }
  return Number(digits);
}

function safeModel(value: unknown): string | null {
  return typeof value === 'string' && MODEL_NAME.test(value) ? value : null;
}

function projectRankSnapshot(value: unknown): unknown | undefined {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 20) return undefined;
  const totalCount = value.total_count;
  if (!Number.isSafeInteger(totalCount) || (totalCount as number) < 0 || (totalCount as number) > 100
    || typeof value.truncated !== 'boolean') return undefined;

  const items: Array<{ idHash: string; rank: number; score: number }> = [];
  for (const item of value.items) {
    if (!isRecord(item)
      || typeof item.idHash !== 'string'
      || !/^[a-f\d]{64}$/i.test(item.idHash)
      || !Number.isSafeInteger(item.rank)
      || (item.rank as number) < 1
      || (item.rank as number) > 20
      || typeof item.score !== 'number'
      || !Number.isFinite(item.score)
      || Math.abs(item.score) > 1_000_000) return undefined;
    items.push({ idHash: item.idHash.toLowerCase(), rank: item.rank as number, score: item.score });
  }
  return { items, total_count: totalCount as number, truncated: value.truncated };
}

function projectAttributes(raw: string): Record<string, unknown> {
  if (raw.length > MAX_ATTRIBUTE_JSON_LENGTH) return {};
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(decoded)) return {};

  const projected: Record<string, unknown> = {};
  const read = (key: string): unknown => Object.prototype.hasOwnProperty.call(decoded, key)
    ? decoded[key]
    : undefined;
  const putModel = (key: string): void => {
    const value = safeModel(read(key));
    if (value !== null) projected[key] = value;
  };
  const putDuration = (key: string): void => {
    const value = read(key);
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 120_000) {
      projected[key] = value;
    }
  };

  for (const key of ['model', 'requested_model', 'llm.model', 'llm.response_model']) putModel(key);
  for (const key of ['llm.streaming', 'llm.usage_available', 'rag.empty']) {
    const value = read(key);
    if (typeof value === 'boolean') projected[key] = value;
  }
  const finishReason = read('llm.finish_reason');
  if (typeof finishReason === 'string' && FINISH_REASONS.has(finishReason)) {
    projected['llm.finish_reason'] = finishReason;
  }
  for (const key of ['llm.total_latency_ms', 'llm.ttft_ms', 'rag.recall_ms', 'rag.rerank_ms']) {
    putDuration(key);
  }

  const topK = read('topK');
  if (Number.isSafeInteger(topK) && (topK as number) >= 1 && (topK as number) <= 100) {
    projected.topK = topK;
  }
  const recalledCount = read('rag.recalled_count');
  if (Number.isSafeInteger(recalledCount)
    && (recalledCount as number) >= 0
    && (recalledCount as number) <= 100) {
    projected['rag.recalled_count'] = recalledCount;
  }
  const sources = read('sources');
  if (Array.isArray(sources)
    && sources.length <= 100
    && sources.every((source) => typeof source === 'string' && /^[a-f\d]{64}$/i.test(source))) {
    projected.sources = sources.map((source) => (source as string).toLowerCase());
  }
  for (const key of ['rag.rerank_before', 'rag.rerank_after']) {
    const snapshot = projectRankSnapshot(read(key));
    if (snapshot !== undefined) projected[key] = snapshot;
  }

  const method = read('http.method');
  if (typeof method === 'string' && HTTP_METHODS.has(method)) projected['http.method'] = method;
  const statusCode = read('http.status_code');
  if (Number.isSafeInteger(statusCode) && (statusCode as number) >= 100 && (statusCode as number) <= 599) {
    projected['http.status_code'] = statusCode;
  }
  const category = read('ai.error_category');
  if (typeof category === 'string' && ERROR_CATEGORIES.has(category)) {
    projected['ai.error_category'] = category;
  }

  return projected;
}

function normalizeRow(value: unknown): NormalizedSpan {
  if (!isRecord(value)) return invalidStorageResult();
  const spanId = value.span_id;
  const parent = value.parent_span_id;
  const service = value.service;
  const operation = value.operation;
  const status = value.status;
  const attributesJson = value.attributes;
  if (!isContractId(spanId)
    || typeof parent !== 'string'
    || (parent !== '' && !isContractId(parent))
    || typeof service !== 'string' || service.length < 1 || service.length > 120 || /[\u0000-\u001f\u007f]/.test(service)
    || typeof operation !== 'string' || operation.length < 1 || operation.length > 160 || /[\u0000-\u001f\u007f]/.test(operation)
    || (status !== 'ok' && status !== 'error')
    || typeof attributesJson !== 'string') return invalidStorageResult();

  const start = timestamp(value.start_time);
  const end = timestamp(value.end_time);
  const event = timestamp(value.event_time);
  const durationMs = numericValue(value.duration_ms);
  if (end.milliseconds < start.milliseconds || durationMs !== end.milliseconds - start.milliseconds) {
    return invalidStorageResult();
  }

  const inputTokens = tokenValue(value.input_tokens);
  const outputTokens = tokenValue(value.output_tokens);
  const totalTokens = tokenValue(value.total_tokens);
  const modelValue = value.model;
  if (typeof modelValue !== 'string' || modelValue.length > 4_000) return invalidStorageResult();

  return {
    spanId,
    parentSpanId: parent || null,
    service,
    operation,
    status,
    startTime: start.iso,
    endTime: end.iso,
    durationMs,
    model: safeModel(modelValue),
    inputTokens,
    outputTokens,
    totalTokens,
    attributes: projectAttributes(attributesJson),
    startMs: start.milliseconds,
    endMs: end.milliseconds,
    eventMs: event.milliseconds,
    rawModel: modelValue,
    attributesJson,
  };
}

function compareVersion(left: NormalizedSpan, right: NormalizedSpan): number {
  const numeric = [
    left.eventMs - right.eventMs,
    left.endMs - right.endMs,
    left.startMs - right.startMs,
  ];
  for (const difference of numeric) if (difference !== 0) return difference;

  const strings = [
    compareString(left.parentSpanId ?? '', right.parentSpanId ?? ''),
    compareString(left.service, right.service),
    compareString(left.operation, right.operation),
    compareString(left.status, right.status),
    left.totalTokens - right.totalTokens,
    compareString(left.rawModel, right.rawModel),
    left.durationMs - right.durationMs,
    left.inputTokens - right.inputTokens,
    left.outputTokens - right.outputTokens,
    compareString(left.attributesJson, right.attributesJson),
  ];
  return strings.find((difference) => difference !== 0) ?? 0;
}

function buildTree(spans: readonly NormalizedSpan[]) {
  const spanIds = new Set(spans.map((span) => span.spanId));
  const parentById = new Map<string, string | null>();
  const orphanSpanIds = new Set<string>();
  for (const span of spans) {
    const parentSpanId = span.parentSpanId;
    if (parentSpanId === null) {
      parentById.set(span.spanId, null);
    } else if (!spanIds.has(parentSpanId)) {
      orphanSpanIds.add(span.spanId);
      parentById.set(span.spanId, null);
    } else {
      parentById.set(span.spanId, parentSpanId);
    }
  }

  const order = new Map(spans.map((span, index) => [span.spanId, index]));
  const visited = new Set<string>();
  const cycleSpanIds = new Set<string>();
  for (const span of spans) {
    if (visited.has(span.spanId)) continue;
    const path: string[] = [];
    const position = new Map<string, number>();
    let current: string | null | undefined = span.spanId;
    while (current !== null && current !== undefined
      && !visited.has(current) && !position.has(current)) {
      position.set(current, path.length);
      path.push(current);
      current = parentById.get(current);
    }

    if (current !== null && current !== undefined && position.has(current)) {
      const cycle = path.slice(position.get(current));
      for (const spanId of cycle) cycleSpanIds.add(spanId);
      const cutSpanId = cycle.reduce((earliest, candidate) =>
        (order.get(candidate) ?? 0) < (order.get(earliest) ?? 0) ? candidate : earliest);
      parentById.set(cutSpanId, null);
    }
    for (const spanId of path) visited.add(spanId);
  }

  const roots: string[] = [];
  const childrenById = new Map(spans.map((span) => [span.spanId, [] as string[]]));
  const nodes = spans.map((span) => {
    const parentSpanId = parentById.get(span.spanId) ?? null;
    if (parentSpanId === null) roots.push(span.spanId);
    else childrenById.get(parentSpanId)?.push(span.spanId);
    return { spanId: span.spanId, parentSpanId, children: childrenById.get(span.spanId)! };
  });

  return {
    roots,
    nodes,
    orphanSpanIds: spans.filter((span) => orphanSpanIds.has(span.spanId)).map((span) => span.spanId),
    cycleSpanIds: spans.filter((span) => cycleSpanIds.has(span.spanId)).map((span) => span.spanId),
    parentById,
  };
}

export function projectTraceDetail(
  query: TraceDetailQuery,
  rows: readonly unknown[],
): TraceDetailResponse {
  if (!Array.isArray(rows) || rows.length > MAX_FETCHED_SPANS) return invalidStorageResult();
  const versions = new Map<string, NormalizedSpan>();
  for (const rawRow of rows) {
    const candidate = normalizeRow(rawRow);
    const previous = versions.get(candidate.spanId);
    if (!previous || compareVersion(candidate, previous) > 0) versions.set(candidate.spanId, candidate);
  }

  const ordered = [...versions.values()].sort((left, right) =>
    left.startMs - right.startMs || compareString(left.spanId, right.spanId));
  const truncated = rows.length > MAX_SPANS || ordered.length > MAX_SPANS;
  const visible = ordered.slice(0, MAX_SPANS);
  const tree = buildTree(visible);
  const spans: SpanView[] = visible.map((span) => ({
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    service: span.service,
    operation: span.operation,
    status: span.status,
    startTime: span.startTime,
    endTime: span.endTime,
    durationMs: span.durationMs,
    model: span.model,
    inputTokens: span.inputTokens,
    outputTokens: span.outputTokens,
    totalTokens: span.totalTokens,
    attributes: span.attributes,
  }));
  const originalRoots = new Set(visible
    .filter((span) => span.parentSpanId === null)
    .map((span) => span.spanId));
  const rootSpan = spans.find((span) => originalRoots.has(span.spanId)) ?? null;
  const summaryStart = visible.length > 0 ? Math.min(...visible.map((span) => span.startMs)) : 0;
  const summaryEnd = visible.length > 0 ? Math.max(...visible.map((span) => span.endMs)) : 0;
  let totalTokens = 0;
  for (const span of visible) {
    if (span.rawModel !== '' || span.operation === 'llm.generate') {
      totalTokens += span.totalTokens;
      if (!Number.isSafeInteger(totalTokens)) return invalidStorageResult();
    }
  }

  return {
    traceId: query.traceId,
    projectId: query.projectId,
    environment: query.environment,
    rootSpan,
    spans,
    summary: {
      spanCount: spans.length,
      durationMs: summaryEnd - summaryStart,
      totalTokens,
      status: spans.some((span) => span.status === 'error') ? 'error' : 'ok',
      truncated,
    },
    errors: spans
      .filter((span) => span.status === 'error')
      .map((span) => ({
        spanId: span.spanId,
        category: typeof span.attributes['ai.error_category'] === 'string'
          ? span.attributes['ai.error_category']
          : 'unknown',
      })),
    redaction: { contentIncluded: false },
    tree: {
      roots: tree.roots,
      nodes: tree.nodes,
      orphanSpanIds: tree.orphanSpanIds,
      cycleSpanIds: tree.cycleSpanIds,
      multipleRoots: tree.roots.length > 1,
    },
  };
}
