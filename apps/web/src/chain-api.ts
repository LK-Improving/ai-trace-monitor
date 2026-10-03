import { apiFetch } from './api';
import type { OverviewEnvironment, OverviewRange } from './overview-api';

export type TraceEnvironment = Exclude<OverviewEnvironment, 'all'>;
export type TraceStatus = 'ok' | 'error';

export interface TimeWindow {
  from: string;
  to: string;
}

export interface TraceListItem {
  traceId: string;
  environment: TraceEnvironment;
  rootOperation: string;
  services: string[];
  status: TraceStatus;
  durationMs: number;
  totalTokens: number;
  startedAt: string;
  spanCount: number;
}

export interface TraceListResponse {
  items: TraceListItem[];
  total: number;
  page: number;
  pageSize: number;
  range: TimeWindow;
}

export interface TraceListQuery {
  projectId: string;
  environment: OverviewEnvironment;
  range: OverviewRange;
  page?: number;
  pageSize?: number;
  traceId?: string;
  service?: string;
  status?: TraceStatus;
  window?: TimeWindow;
}

export interface RankSnapshot {
  items: Array<{ idHash: string; rank: number; score: number }>;
  total_count: number;
  truncated: boolean;
}

export type SafeTraceAttributes = Record<string, string | number | boolean | string[] | RankSnapshot>;

export interface TraceSpan {
  spanId: string;
  parentSpanId: string | null;
  service: string;
  operation: string;
  status: TraceStatus;
  startTime: string;
  endTime: string;
  durationMs: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  attributes: SafeTraceAttributes;
}

export interface TraceDetailResponse {
  traceId: string;
  projectId: string;
  environment: TraceEnvironment;
  rootSpan: TraceSpan | null;
  spans: TraceSpan[];
  summary: {
    spanCount: number;
    durationMs: number;
    totalTokens: number;
    status: TraceStatus;
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

export interface TraceDetailQuery {
  projectId: string;
  environment: TraceEnvironment;
  traceId: string;
  window: TimeWindow;
}

export interface LlmMetrics {
  callCount: number;
  errorCount: number;
  errorRate: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  ttftSampleCount: number;
  p50TtftMs: number;
  p95TtftMs: number;
  p99TtftMs: number;
}

export interface AiMetricsResponse {
  generatedAt: string;
  range: { key: OverviewRange; from: string; to: string };
  llm: LlmMetrics & { models: Array<LlmMetrics & { model: string }> };
  rag: {
    callCount: number;
    successCount: number;
    errorCount: number;
    successRate: number;
    emptyRecallCount: number;
    observedRecallCount: number;
    emptyRecallRate: number | null;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    recallSampleCount: number;
    p95RecallMs: number;
    rerankSampleCount: number;
    p95RerankMs: number;
  };
}

export class ChainApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ChainApiError';
  }
}

const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const HASH_PATTERN = /^[a-f\d]{64}$/i;
const ENVIRONMENTS = new Set(['dev', 'staging', 'prod']);
const RANGES = new Set<OverviewRange>(['1h', '24h', '7d']);
const ERROR_CATEGORIES = new Set([
  'rate_limit', 'timeout', 'authentication', 'content_filter', 'provider_error',
  'network_error', 'invalid_response', 'cancelled', 'invalid_request', 'unknown',
]);
const SAFE_ATTRIBUTE_MODELS = ['model', 'requested_model', 'llm.model', 'llm.response_model'] as const;
const SAFE_ATTRIBUTE_FLAGS = ['llm.streaming', 'llm.usage_available', 'rag.empty'] as const;
const SAFE_ATTRIBUTE_MEASUREMENTS = ['llm.total_latency_ms', 'llm.ttft_ms', 'rag.recall_ms', 'rag.rerank_ms'] as const;
const SAFE_ATTRIBUTE_RANKS = ['rag.rerank_before', 'rag.rerank_after'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value: unknown, maximum = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTraceEnvironment(value: unknown): value is TraceEnvironment {
  return typeof value === 'string' && ENVIRONMENTS.has(value);
}

function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID_PATTERN.test(value);
}

function isSpanId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function invalidPayload(): ChainApiError {
  return new ChainApiError('接口响应格式与约定不一致，请联系后端确认。');
}

function parseWindow(value: unknown): TimeWindow {
  if (!isRecord(value) || !isTimestamp(value.from) || !isTimestamp(value.to)
    || Date.parse(value.from) >= Date.parse(value.to)
    || Date.parse(value.to) - Date.parse(value.from) > 30 * 24 * 60 * 60 * 1000) {
    throw invalidPayload();
  }
  return { from: value.from, to: value.to };
}

export function createTimeWindow(range: OverviewRange, nowMs = Date.now()): TimeWindow {
  if (!RANGES.has(range) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('Invalid time range');
  }
  const durationMs = range === '1h' ? 60 * 60 * 1000 : range === '7d' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return {
    from: new Date(nowMs - durationMs).toISOString(),
    to: new Date(nowMs).toISOString(),
  };
}

export function createTimeWindowAround(timestamp: string): TimeWindow {
  const centerMs = Date.parse(timestamp);
  if (!isTimestamp(timestamp) || !Number.isSafeInteger(centerMs)) {
    throw new TypeError('Invalid time window center');
  }

  const radiusMs = 15 * 60 * 1000;
  const from = new Date(centerMs - radiusMs).toISOString();
  const to = new Date(centerMs + radiusMs).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(from)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(to)) {
    throw new TypeError('Invalid time window center');
  }
  return { from, to };
}

function httpErrorMessage(status: number, resource: 'Trace' | 'AI 指标'): string {
  if (status === 401) {
    return '未授权（401）：请检查本地 Vite 服务端的 PLATFORM_ADMIN_TOKEN 配置；令牌不会保存在浏览器。';
  }
  if (status === 403) return `当前凭证无权读取该${resource}数据（403）。`;
  if (status === 404) return `${resource}接口暂不可用（404），请确认后端服务及查询范围。`;
  if (status >= 500) return `服务暂时不可用（HTTP ${status}），请稍后重试。`;
  return `请求失败（HTTP ${status}）。`;
}

async function getJson(path: string, signal: AbortSignal | undefined, resource: 'Trace' | 'AI 指标'): Promise<unknown> {
  let response: Response;
  try {
    response = await apiFetch(path, { signal });
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    throw new ChainApiError('无法连接 API 服务，请确认本地后端正在运行。');
  }
  if (!response.ok) throw new ChainApiError(httpErrorMessage(response.status, resource), response.status);
  try {
    return await response.json() as unknown;
  } catch {
    throw new ChainApiError('接口未返回有效 JSON 数据。', response.status);
  }
}

export function parseTraceListPayload(value: unknown, expected?: { page: number; pageSize: number; window: TimeWindow }): TraceListResponse {
  if (!isRecord(value) || !Array.isArray(value.items) || !isSafeInteger(value.total)
    || !Number.isSafeInteger(value.page) || (value.page as number) < 1
    || !Number.isSafeInteger(value.pageSize) || (value.pageSize as number) < 1 || (value.pageSize as number) > 100) {
    throw invalidPayload();
  }
  const range = parseWindow(value.range);
  if (expected && (value.page !== expected.page || value.pageSize !== expected.pageSize
    || range.from !== expected.window.from || range.to !== expected.window.to)) throw invalidPayload();

  const items: TraceListItem[] = value.items.map((item) => {
    if (!isRecord(item) || !isTraceId(item.traceId) || !isTraceEnvironment(item.environment)
      || !isText(item.rootOperation, 160) || !Array.isArray(item.services) || item.services.length > 2_000
      || !item.services.every((service) => isText(service, 120))
      || (item.status !== 'ok' && item.status !== 'error')
      || !isSafeInteger(item.durationMs) || !isSafeInteger(item.totalTokens)
      || !isTimestamp(item.startedAt) || !isSafeInteger(item.spanCount)) throw invalidPayload();
    return {
      traceId: item.traceId,
      environment: item.environment,
      rootOperation: item.rootOperation,
      services: [...item.services],
      status: item.status,
      durationMs: item.durationMs,
      totalTokens: item.totalTokens,
      startedAt: item.startedAt,
      spanCount: item.spanCount,
    };
  });
  const pageSize = value.pageSize as number;
  if (items.length > pageSize) throw invalidPayload();
  return { items, total: value.total, page: value.page as number, pageSize, range };
}

function parseRankSnapshot(value: unknown): RankSnapshot {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 20
    || !isSafeInteger(value.total_count) || value.total_count > 100 || typeof value.truncated !== 'boolean') {
    throw invalidPayload();
  }
  const items = value.items.map((item) => {
    if (!isRecord(item) || typeof item.idHash !== 'string' || !HASH_PATTERN.test(item.idHash)
      || !Number.isSafeInteger(item.rank) || (item.rank as number) < 1 || (item.rank as number) > 20
      || typeof item.score !== 'number' || !Number.isFinite(item.score) || Math.abs(item.score) > 1_000_000) {
      throw invalidPayload();
    }
    return { idHash: item.idHash.toLowerCase(), rank: item.rank as number, score: item.score };
  });
  return { items, total_count: value.total_count, truncated: value.truncated };
}

function parseSafeAttributes(value: unknown): SafeTraceAttributes {
  if (!isRecord(value)) throw invalidPayload();
  const attributes: SafeTraceAttributes = {};
  for (const key of SAFE_ATTRIBUTE_MODELS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (typeof value[key] !== 'string' || !MODEL_PATTERN.test(value[key] as string)) throw invalidPayload();
    attributes[key] = value[key] as string;
  }
  for (const key of SAFE_ATTRIBUTE_FLAGS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (typeof value[key] !== 'boolean') throw invalidPayload();
    attributes[key] = value[key] as boolean;
  }
  for (const key of SAFE_ATTRIBUTE_MEASUREMENTS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (!isNonNegativeNumber(value[key]) || (value[key] as number) > 120_000) throw invalidPayload();
    attributes[key] = value[key] as number;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'topK')) {
    if (!Number.isSafeInteger(value.topK) || (value.topK as number) < 1 || (value.topK as number) > 100) throw invalidPayload();
    attributes.topK = value.topK as number;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'rag.recalled_count')) {
    if (!Number.isSafeInteger(value['rag.recalled_count']) || (value['rag.recalled_count'] as number) < 0
      || (value['rag.recalled_count'] as number) > 100) throw invalidPayload();
    attributes['rag.recalled_count'] = value['rag.recalled_count'] as number;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'sources')) {
    if (!Array.isArray(value.sources) || value.sources.length > 100
      || !value.sources.every((source) => typeof source === 'string' && HASH_PATTERN.test(source))) throw invalidPayload();
    attributes.sources = value.sources.map((source) => (source as string).toLowerCase());
  }
  for (const key of SAFE_ATTRIBUTE_RANKS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) attributes[key] = parseRankSnapshot(value[key]);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'http.method')) {
    const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE']);
    if (typeof value['http.method'] !== 'string' || !methods.has(value['http.method'] as string)) throw invalidPayload();
    attributes['http.method'] = value['http.method'] as string;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'http.status_code')) {
    if (!Number.isSafeInteger(value['http.status_code']) || (value['http.status_code'] as number) < 100
      || (value['http.status_code'] as number) > 599) throw invalidPayload();
    attributes['http.status_code'] = value['http.status_code'] as number;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'llm.finish_reason')) {
    const reasons = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter', 'unknown', 'other']);
    if (typeof value['llm.finish_reason'] !== 'string' || !reasons.has(value['llm.finish_reason'] as string)) throw invalidPayload();
    attributes['llm.finish_reason'] = value['llm.finish_reason'] as string;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'ai.error_category')) {
    if (typeof value['ai.error_category'] !== 'string' || !ERROR_CATEGORIES.has(value['ai.error_category'] as string)) throw invalidPayload();
    attributes['ai.error_category'] = value['ai.error_category'] as string;
  }
  return attributes;
}

function parseSpan(value: unknown): TraceSpan {
  if (!isRecord(value) || !isSpanId(value.spanId)
    || !(value.parentSpanId === null || isSpanId(value.parentSpanId))
    || !isText(value.service, 120) || !isText(value.operation, 160)
    || (value.status !== 'ok' && value.status !== 'error')
    || !isTimestamp(value.startTime) || !isTimestamp(value.endTime)
    || Date.parse(value.endTime) < Date.parse(value.startTime)
    || !isNonNegativeNumber(value.durationMs) || Date.parse(value.endTime) - Date.parse(value.startTime) !== value.durationMs
    || !(value.model === null || (typeof value.model === 'string' && MODEL_PATTERN.test(value.model)))
    || !isSafeInteger(value.inputTokens) || !isSafeInteger(value.outputTokens) || !isSafeInteger(value.totalTokens)) {
    throw invalidPayload();
  }
  return {
    spanId: value.spanId,
    parentSpanId: value.parentSpanId,
    service: value.service,
    operation: value.operation,
    status: value.status,
    startTime: value.startTime,
    endTime: value.endTime,
    durationMs: value.durationMs,
    model: value.model,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    attributes: parseSafeAttributes(value.attributes),
  };
}

export function parseTraceDetailPayload(value: unknown, expected?: Pick<TraceDetailQuery, 'traceId' | 'projectId' | 'environment'>): TraceDetailResponse {
  if (!isRecord(value) || !isTraceId(value.traceId) || !isText(value.projectId, 64) || !isTraceEnvironment(value.environment)
    || !Array.isArray(value.spans) || value.spans.length > 2_000 || !isRecord(value.summary)
    || !isSafeInteger(value.summary.spanCount) || value.summary.spanCount !== value.spans.length
    || !isSafeInteger(value.summary.durationMs) || !isSafeInteger(value.summary.totalTokens)
    || (value.summary.status !== 'ok' && value.summary.status !== 'error')
    || typeof value.summary.truncated !== 'boolean' || !Array.isArray(value.errors)
    || !isRecord(value.redaction) || value.redaction.contentIncluded !== false || !isRecord(value.tree)) {
    throw invalidPayload();
  }
  if (expected && (value.traceId !== expected.traceId || value.projectId !== expected.projectId
    || value.environment !== expected.environment)) throw invalidPayload();

  const spans = value.spans.map(parseSpan);
  const spanIds = new Set(spans.map(({ spanId }) => spanId));
  if (spanIds.size !== spans.length) throw invalidPayload();
  const rootSpan = value.rootSpan === null ? null : parseSpan(value.rootSpan);
  if (rootSpan && (!spanIds.has(rootSpan.spanId) || spans.find(({ spanId }) => spanId === rootSpan.spanId)?.parentSpanId !== null)) {
    throw invalidPayload();
  }

  if (!Array.isArray(value.tree.roots) || !Array.isArray(value.tree.nodes)
    || value.tree.nodes.length !== spans.length || !Array.isArray(value.tree.orphanSpanIds)
    || !Array.isArray(value.tree.cycleSpanIds) || typeof value.tree.multipleRoots !== 'boolean') throw invalidPayload();
  const nodes = value.tree.nodes.map((node) => {
    if (!isRecord(node) || !isSpanId(node.spanId) || !spanIds.has(node.spanId)
      || !(node.parentSpanId === null || (isSpanId(node.parentSpanId) && spanIds.has(node.parentSpanId)))
      || !Array.isArray(node.children) || !node.children.every((id) => isSpanId(id) && spanIds.has(id))) throw invalidPayload();
    return { spanId: node.spanId, parentSpanId: node.parentSpanId, children: [...node.children] as string[] };
  });
  const nodeIds = new Set(nodes.map(({ spanId }) => spanId));
  const nodesById = new Map(nodes.map((node) => [node.spanId, node]));
  const roots = value.tree.roots.map((id) => {
    if (!isSpanId(id) || !nodeIds.has(id)) throw invalidPayload();
    return id;
  });
  const orphanSpanIds = value.tree.orphanSpanIds.map((id) => {
    if (!isSpanId(id) || !spanIds.has(id)) throw invalidPayload();
    return id;
  });
  const cycleSpanIds = value.tree.cycleSpanIds.map((id) => {
    if (!isSpanId(id) || !spanIds.has(id)) throw invalidPayload();
    return id;
  });
  if (nodeIds.size !== spans.length || new Set(roots).size !== roots.length
    || new Set(orphanSpanIds).size !== orphanSpanIds.length || new Set(cycleSpanIds).size !== cycleSpanIds.length
    || value.tree.multipleRoots !== (roots.length > 1)) throw invalidPayload();
  const rootIds = new Set(roots);
  const effectiveRootIds = new Set<string>();
  for (const node of nodes) {
    if (node.parentSpanId === null) effectiveRootIds.add(node.spanId);
  }
  if (rootIds.size !== effectiveRootIds.size || [...rootIds].some((id) => !effectiveRootIds.has(id))) throw invalidPayload();
  const orphanIds = new Set(orphanSpanIds);
  const cycleIds = new Set(cycleSpanIds);
  for (const span of spans) {
    const originalParent = span.parentSpanId;
    const effectiveParent = nodesById.get(span.spanId)?.parentSpanId ?? null;
    const parentExists = originalParent !== null && spanIds.has(originalParent);
    if (orphanIds.has(span.spanId) !== (originalParent !== null && !parentExists)) throw invalidPayload();
    if (!orphanIds.has(span.spanId) && !cycleIds.has(span.spanId) && originalParent !== effectiveParent) throw invalidPayload();
    if (orphanIds.has(span.spanId) && effectiveParent !== null) throw invalidPayload();
  }
  for (const node of nodes) {
    if (new Set(node.children).size !== node.children.length) throw invalidPayload();
    for (const childId of node.children) {
      if (nodesById.get(childId)?.parentSpanId !== node.spanId) throw invalidPayload();
    }
    if (node.parentSpanId !== null && !nodesById.get(node.parentSpanId)?.children.includes(node.spanId)) throw invalidPayload();
  }

  const errors = value.errors.map((error) => {
    if (!isRecord(error) || !isSpanId(error.spanId) || !spanIds.has(error.spanId)
      || typeof error.category !== 'string' || !ERROR_CATEGORIES.has(error.category)) throw invalidPayload();
    return { spanId: error.spanId, category: error.category };
  });
  return {
    traceId: value.traceId,
    projectId: value.projectId,
    environment: value.environment,
    rootSpan,
    spans,
    summary: {
      spanCount: value.summary.spanCount,
      durationMs: value.summary.durationMs,
      totalTokens: value.summary.totalTokens,
      status: value.summary.status,
      truncated: value.summary.truncated,
    },
    errors,
    redaction: { contentIncluded: false },
    tree: { roots, nodes, orphanSpanIds, cycleSpanIds, multipleRoots: value.tree.multipleRoots },
  };
}

export interface FlattenedTraceSpan {
  span: TraceSpan;
  depth: number;
  orphan: boolean;
  cycle: boolean;
}

export function flattenTraceTree(detail: TraceDetailResponse): FlattenedTraceSpan[] {
  const spansById = new Map(detail.spans.map((span) => [span.spanId, span]));
  const nodesById = new Map(detail.tree.nodes.map((node) => [node.spanId, node]));
  const orphanIds = new Set(detail.tree.orphanSpanIds);
  const cycleIds = new Set(detail.tree.cycleSpanIds);
  const visited = new Set<string>();
  const flattened: FlattenedTraceSpan[] = [];
  const stack: Array<{ spanId: string; depth: number }> = [];

  for (const rootId of [...detail.tree.roots, ...detail.spans.map(({ spanId }) => spanId)]) {
    if (visited.has(rootId) || !spansById.has(rootId)) continue;
    stack.push({ spanId: rootId, depth: 0 });
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current.spanId)) continue;
      visited.add(current.spanId);
      const span = spansById.get(current.spanId);
      if (!span) continue;
      flattened.push({
        span,
        depth: current.depth,
        orphan: orphanIds.has(current.spanId),
        cycle: cycleIds.has(current.spanId),
      });
      const children = nodesById.get(current.spanId)?.children ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        if (!visited.has(children[index])) stack.push({ spanId: children[index], depth: current.depth + 1 });
      }
    }
  }
  return flattened;
}

export function parseAiMetricsPayload(value: unknown, expectedRange?: OverviewRange): AiMetricsResponse {
  if (!isRecord(value) || !isTimestamp(value.generatedAt) || !isRecord(value.range)
    || !RANGES.has(value.range.key as OverviewRange) || (expectedRange !== undefined && value.range.key !== expectedRange)
    || !isTimestamp(value.range.from) || !isTimestamp(value.range.to) || !isRecord(value.llm)
    || !Array.isArray(value.llm.models) || value.llm.models.length > 100 || !isRecord(value.rag)) throw invalidPayload();

  const parseLlm = (item: unknown): LlmMetrics => {
    if (!isRecord(item) || !isSafeInteger(item.callCount) || !isSafeInteger(item.errorCount)
      || item.errorCount > item.callCount || !isNonNegativeNumber(item.errorRate) || item.errorRate > 1
      || !isSafeInteger(item.inputTokens) || !isSafeInteger(item.outputTokens) || !isSafeInteger(item.totalTokens)
      || !isNonNegativeNumber(item.p50LatencyMs) || !isNonNegativeNumber(item.p95LatencyMs)
      || !isNonNegativeNumber(item.p99LatencyMs) || !isSafeInteger(item.ttftSampleCount)
      || item.ttftSampleCount > item.callCount || !isNonNegativeNumber(item.p50TtftMs)
      || !isNonNegativeNumber(item.p95TtftMs) || !isNonNegativeNumber(item.p99TtftMs)) throw invalidPayload();
    return {
      callCount: item.callCount,
      errorCount: item.errorCount,
      errorRate: item.errorRate,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      totalTokens: item.totalTokens,
      p50LatencyMs: item.p50LatencyMs,
      p95LatencyMs: item.p95LatencyMs,
      p99LatencyMs: item.p99LatencyMs,
      ttftSampleCount: item.ttftSampleCount,
      p50TtftMs: item.p50TtftMs,
      p95TtftMs: item.p95TtftMs,
      p99TtftMs: item.p99TtftMs,
    };
  };

  const llm = parseLlm(value.llm);
  const models = value.llm.models.map((item) => {
    if (!isRecord(item) || !(item.model === '(unknown)' || (typeof item.model === 'string' && MODEL_PATTERN.test(item.model)))) {
      throw invalidPayload();
    }
    return { model: item.model as string, ...parseLlm(item) };
  });
  if (new Set(models.map(({ model }) => model)).size !== models.length) throw invalidPayload();

  const rag = value.rag;
  if (!isSafeInteger(rag.callCount) || !isSafeInteger(rag.successCount) || !isSafeInteger(rag.errorCount)
    || rag.successCount + rag.errorCount !== rag.callCount || !isNonNegativeNumber(rag.successRate) || rag.successRate > 1
    || !isSafeInteger(rag.emptyRecallCount) || !isSafeInteger(rag.observedRecallCount)
    || rag.emptyRecallCount > rag.observedRecallCount || rag.observedRecallCount > rag.successCount
    || !(rag.emptyRecallRate === null || (isNonNegativeNumber(rag.emptyRecallRate) && rag.emptyRecallRate <= 1))
    || !isNonNegativeNumber(rag.p50LatencyMs) || !isNonNegativeNumber(rag.p95LatencyMs)
    || !isNonNegativeNumber(rag.p99LatencyMs) || !isSafeInteger(rag.recallSampleCount)
    || rag.recallSampleCount > rag.callCount || !isNonNegativeNumber(rag.p95RecallMs)
    || !isSafeInteger(rag.rerankSampleCount) || rag.rerankSampleCount > rag.callCount
    || !isNonNegativeNumber(rag.p95RerankMs)) throw invalidPayload();

  return {
    generatedAt: value.generatedAt,
    range: { key: value.range.key as OverviewRange, from: value.range.from, to: value.range.to },
    llm: { ...llm, models },
    rag: {
      callCount: rag.callCount,
      successCount: rag.successCount,
      errorCount: rag.errorCount,
      successRate: rag.successRate,
      emptyRecallCount: rag.emptyRecallCount,
      observedRecallCount: rag.observedRecallCount,
      emptyRecallRate: rag.emptyRecallRate,
      p50LatencyMs: rag.p50LatencyMs,
      p95LatencyMs: rag.p95LatencyMs,
      p99LatencyMs: rag.p99LatencyMs,
      recallSampleCount: rag.recallSampleCount,
      p95RecallMs: rag.p95RecallMs,
      rerankSampleCount: rag.rerankSampleCount,
      p95RerankMs: rag.p95RerankMs,
    },
  };
}

export async function fetchTraceList(query: TraceListQuery, signal?: AbortSignal): Promise<TraceListResponse> {
  if (!isText(query.projectId, 64) || !(query.environment === 'all' || isTraceEnvironment(query.environment))
    || !RANGES.has(query.range)) throw new TypeError('Invalid Trace list filters');
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
    || (page - 1) * pageSize > 10_000) throw new TypeError('Invalid Trace pagination');
  if (query.traceId !== undefined && !isTraceId(query.traceId)) throw new TypeError('Invalid Trace ID filter');
  if (query.service !== undefined && (!isText(query.service, 120) || query.service.trim() !== query.service)) {
    throw new TypeError('Invalid Trace service filter');
  }
  if (query.status !== undefined && query.status !== 'ok' && query.status !== 'error') throw new TypeError('Invalid Trace status filter');
  const window = query.window ? parseWindow(query.window) : createTimeWindow(query.range);
  const params = new URLSearchParams({
    projectId: query.projectId,
    environment: query.environment,
    from: window.from,
    to: window.to,
    page: String(page),
    pageSize: String(pageSize),
  });
  if (query.traceId !== undefined) params.set('traceId', query.traceId);
  if (query.service !== undefined) params.set('service', query.service);
  if (query.status !== undefined) params.set('status', query.status);
  return parseTraceListPayload(
    await getJson(`/api/v1/traces?${params.toString()}`, signal, 'Trace'),
    { page, pageSize, window },
  );
}

export async function fetchTraceDetail(query: TraceDetailQuery, signal?: AbortSignal): Promise<TraceDetailResponse> {
  if (!isText(query.projectId, 64) || !isTraceEnvironment(query.environment) || !isTraceId(query.traceId)) {
    throw new TypeError('Invalid Trace detail filters');
  }
  const window = parseWindow(query.window);
  const params = new URLSearchParams({ projectId: query.projectId, environment: query.environment, from: window.from, to: window.to });
  const id = encodeURIComponent(query.traceId);
  return parseTraceDetailPayload(
    await getJson(`/api/v1/traces/${id}?${params.toString()}`, signal, 'Trace'),
    query,
  );
}

export async function fetchAiMetrics(projectId: string, environment: OverviewEnvironment, range: OverviewRange, signal?: AbortSignal): Promise<AiMetricsResponse> {
  if (!isText(projectId, 64) || !(environment === 'all' || isTraceEnvironment(environment)) || !RANGES.has(range)) {
    throw new TypeError('Invalid AI metrics filters');
  }
  const params = new URLSearchParams({ projectId, environment, range });
  return parseAiMetricsPayload(await getJson(`/api/v1/metrics/ai?${params.toString()}`, signal, 'AI 指标'), range);
}

export function chainErrorMessage(error: unknown): string {
  if (error instanceof ChainApiError) return error.message;
  return '读取数据失败，请稍后重试。';
}
