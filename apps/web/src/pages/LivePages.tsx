import { useEffect, useMemo, useRef, useState } from 'react';
import {
  chainErrorMessage,
  createTimeWindow,
  fetchAiMetrics,
  fetchTraceDetail,
  fetchTraceList,
  flattenTraceTree,
  type AiMetricsResponse,
  type RankSnapshot,
  type TraceDetailResponse,
  type TraceEnvironment,
  type TraceListResponse,
  type TraceStatus,
  type TimeWindow,
} from '../chain-api';
import type { OverviewEnvironment, OverviewRange } from '../overview-api';
import { Icon, PageIntro, StatusPill } from '../components/ui';

export interface TraceSelection {
  traceId: string;
  environment: TraceEnvironment;
  window: TimeWindow;
}

interface RequestState<T> {
  scopeKey: string;
  status: 'loading' | 'ready' | 'error';
  data?: T;
  message?: string;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}M`;
  if (value >= 10_000) return `${(value / 1_000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}K`;
  return formatCount(value);
}

function formatLatency(value: number): string {
  return value >= 1000
    ? `${(value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}s`
    : `${Math.round(value)}ms`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(new Date(value));
}

function isRankSnapshot(value: unknown): value is RankSnapshot {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function MetricCard({ label, value, detail, tone = 'blue' }: { label: string; value: string; detail: string; tone?: 'blue' | 'orange' | 'green' }) {
  return <article className="metric-card"><div className="metric-topline"><span className="metric-label">{label}</span><span className={`metric-swatch ${tone}`} /></div><div className="metric-bottom"><strong className="metric-value">{value}</strong></div><p className="metric-detail">{detail}</p></article>;
}

function stateForScope<T>(state: RequestState<T>, scopeKey: string): RequestState<T> {
  return state.scopeKey === scopeKey ? state : { scopeKey, status: 'loading' };
}

const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function TraceExplorer({
  projectId,
  environment,
  range,
  onSelectTrace,
}: {
  projectId: string;
  environment: OverviewEnvironment;
  range: OverviewRange;
  onSelectTrace: (selection: TraceSelection) => void;
}) {
  const [traceIdInput, setTraceIdInput] = useState('');
  const [serviceInput, setServiceInput] = useState('');
  const [statusInput, setStatusInput] = useState<'all' | TraceStatus>('all');
  const [filterError, setFilterError] = useState('');
  const [filters, setFilters] = useState<{ traceId?: string; service?: string; status?: TraceStatus }>({});
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const pageSize = 20;
  const window = useMemo(() => createTimeWindow(range), [environment, range]);
  const scopeKey = JSON.stringify([projectId, environment, range, window.from, window.to, filters.traceId ?? '', filters.service ?? '', filters.status ?? '', page, pageSize]);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const [state, setState] = useState<RequestState<TraceListResponse>>({ scopeKey: '', status: 'loading' });

  useEffect(() => {
    if (!projectId) return undefined;
    const controller = new AbortController();
    const requestScope = scopeKey;
    setState({ scopeKey: requestScope, status: 'loading' });
    fetchTraceList({
      projectId,
      environment,
      range,
      window,
      page,
      pageSize,
      ...(filters.traceId ? { traceId: filters.traceId } : {}),
      ...(filters.service ? { service: filters.service } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    }, controller.signal).then((data) => {
      if (!controller.signal.aborted && scopeRef.current === requestScope) {
        setState({ scopeKey: requestScope, status: 'ready', data });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && scopeRef.current === requestScope) {
        setState({ scopeKey: requestScope, status: 'error', message: chainErrorMessage(error) });
      }
    });
    return () => controller.abort();
  }, [projectId, environment, range, window.from, window.to, filters, page, pageSize, retry, scopeKey]);

  const visible = stateForScope(state, scopeKey);
  const data = visible.status === 'ready' ? visible.data : undefined;
  const actualPageCount = data ? Math.ceil(data.total / data.pageSize) : 1;
  const pageLimit = data ? Math.min(1000, Math.floor(10_000 / data.pageSize) + 1) : 1;
  const canGoNext = page < actualPageCount && page < pageLimit;
  const offsetLimitReached = Boolean(data && data.total > pageLimit * data.pageSize && page >= pageLimit);

  const submitFilters = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const traceId = traceIdInput.trim();
    const service = serviceInput.trim();
    if (traceId && !TRACE_ID_PATTERN.test(traceId)) {
      setFilterError('请输入完整且格式有效的 Trace ID；查询按精确 ID 匹配。');
      return;
    }
    if (service.length > 120) {
      setFilterError('服务名最多 120 个字符。');
      return;
    }
    setFilterError('');
    setPage(1);
    setFilters({
      ...(traceId ? { traceId } : {}),
      ...(service ? { service } : {}),
      ...(statusInput !== 'all' ? { status: statusInput } : {}),
    });
  };

  const clearFilters = () => {
    setTraceIdInput('');
    setServiceInput('');
    setStatusInput('all');
    setFilterError('');
    setFilters({});
    setPage(1);
  };

  return <section className="module-page">
    <PageIntro eyebrow="TRACE EXPLORER / 全链路检索" title="从一次请求看完整链路。" description="Trace ID 进行精确匹配；服务与状态由查询接口过滤，并支持分页查看。" />
    <section className="panel trace-explorer-panel">
      <form className="filter-toolbar trace-filter-toolbar" onSubmit={submitFilters}>
        <label className="search-input"><Icon name="search" size={16} /><input value={traceIdInput} onChange={(event) => setTraceIdInput(event.target.value)} placeholder="输入完整 Trace ID（精确匹配）" aria-label="精确 Trace ID" autoComplete="off" /></label>
        <label className="compact-filter trace-service-filter"><span>服务</span><input value={serviceInput} onChange={(event) => setServiceInput(event.target.value)} placeholder="服务名精确匹配" aria-label="按服务筛选" maxLength={120} /></label>
        <label className="compact-filter"><span>状态</span><select value={statusInput} onChange={(event) => setStatusInput(event.target.value as typeof statusInput)} aria-label="按状态筛选"><option value="all">全部状态</option><option value="ok">成功</option><option value="error">错误</option></select></label>
        <button className="button secondary compact" type="submit" aria-label="查询 Trace">查询 Trace</button>
      </form>
      {filterError && <div className="chain-inline-error" role="alert">{filterError}</div>}
      {visible.status === 'loading' && <div className="chain-state" role="status" aria-label="Trace 列表加载中">正在读取当前项目的 Trace…</div>}
      {visible.status === 'error' && <div className="chain-state error" role="alert"><span>{visible.message}</span><button className="text-action" type="button" aria-label="重试" onClick={() => setRetry((count) => count + 1)}>重试<Icon name="arrow" size={14} /></button></div>}
      {visible.status === 'ready' && data && <>
        <div className="trace-result-summary"><span>{data.total.toLocaleString('zh-CN')} 条结果</span><span>查询窗口：{formatTime(data.range.from)} – {formatTime(data.range.to)}</span></div>
        <div className="table-scroll data-table-scroll"><table className="data-table trace-results-table"><thead><tr><th>TRACE ID</th><th>入口操作</th><th>服务</th><th>状态</th><th>耗时</th><th>SPANS</th><th>TOKENS</th><th>环境</th><th>开始时间</th><th>详情</th></tr></thead><tbody>
          {data.items.map((trace) => <tr key={`${trace.environment}:${trace.traceId}`}>
            <td><code className="trace-full-id">{trace.traceId}</code></td><td>{trace.rootOperation}</td><td title={trace.services.join(', ')}>{trace.services.join(', ') || '—'}</td>
            <td><StatusPill status={trace.status === 'error' ? 'error' : 'ok'}>{trace.status === 'error' ? '错误' : '成功'}</StatusPill></td>
            <td className="numeric-cell">{formatLatency(trace.durationMs)}</td><td>{formatCount(trace.spanCount)}</td><td>{formatTokens(trace.totalTokens)}</td><td><span className="env-tag">{trace.environment}</span></td><td>{formatTime(trace.startedAt)}</td>
            <td><button className="text-action" type="button" aria-label={`查看 Trace ${trace.traceId}（${trace.environment}）`} onClick={() => onSelectTrace({ traceId: trace.traceId, environment: trace.environment, window: data.range })}>查看<Icon name="arrow" size={13} /></button></td>
          </tr>)}
        </tbody></table>
          {data.items.length === 0 && <div className="empty-state"><span>当前项目、环境、时间范围和筛选条件内没有 Trace。</span><button type="button" className="text-action" onClick={clearFilters}>清除筛选</button></div>}
        </div>
        <div className="table-footer"><span>{offsetLimitReached ? '已达到查询偏移上限，请缩小时间范围或增加筛选条件。' : '服务筛选匹配整条 Trace；Trace ID 为精确匹配'}</span><span className="pagination-controls"><span>第 {data.page} 页 · 共 {data.total} 条</span><button type="button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>‹</button><button type="button" aria-label="下一页" disabled={!canGoNext} onClick={() => setPage((current) => Math.min(pageLimit, current + 1))}>›</button></span></div>
      </>}
    </section>
    <div className="privacy-note"><span className="note-mark">i</span><span>详情只展示接口投影出的安全 Span 字段、模型 Token 与 RAG 哈希；Prompt、回答和文档正文不会显示。</span></div>
  </section>;
}

function attributeLabel(key: string): string {
  const labels: Record<string, string> = {
    model: '模型', requested_model: '请求模型', 'llm.model': 'LLM 模型', 'llm.response_model': '响应模型',
    'llm.streaming': '流式调用', 'llm.usage_available': 'Usage 可用', 'rag.empty': '空召回',
    'llm.total_latency_ms': '模型总耗时', 'llm.ttft_ms': '首 Token 耗时', 'rag.recall_ms': '召回耗时', 'rag.rerank_ms': '重排耗时',
    topK: 'Top K', 'rag.recalled_count': '召回数量', sources: '来源 SHA-256', 'rag.rerank_before': '重排前排名',
    'rag.rerank_after': '重排后排名', 'http.method': 'HTTP 方法', 'http.status_code': 'HTTP 状态码',
    'llm.finish_reason': '结束原因', 'ai.error_category': '异常分类',
  };
  return labels[key] ?? key;
}

function formatAttribute(key: string, value: string | number | boolean | string[] | { items: Array<{ idHash: string; rank: number; score: number }>; total_count: number; truncated: boolean }): string {
  if (Array.isArray(value)) return `${value.length} 个 SHA-256 标识`;
  if (typeof value === 'object') return `${value.items.length}/${value.total_count} 项${value.truncated ? '（已截断）' : ''}`;
  if (typeof value === 'number' && key.endsWith('_ms')) return formatLatency(value);
  return String(value);
}

function RankSnapshotView({ title, value }: { title: string; value: { items: Array<{ idHash: string; rank: number; score: number }>; total_count: number; truncated: boolean } }) {
  return <section className="hash-snapshot"><div className="hash-snapshot-heading"><strong>{title}</strong><span>{value.items.length}/{value.total_count}{value.truncated ? ' · 截断' : ''}</span></div>
    {value.items.length > 0 ? <ul>{value.items.map((item) => <li key={`${item.rank}:${item.idHash}`}><span>#{item.rank} · {item.score}</span><code title={item.idHash}>{item.idHash}</code></li>)}</ul> : <p>此快照没有可展示项目。</p>}
  </section>;
}

export function TraceDetail({
  projectId,
  selection,
  onBack,
}: {
  projectId: string;
  selection: TraceSelection;
  onBack: () => void;
}) {
  const [retry, setRetry] = useState(0);
  const [selectedSpanId, setSelectedSpanId] = useState('');
  const scopeKey = JSON.stringify([projectId, selection.traceId, selection.environment, selection.window.from, selection.window.to]);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const [state, setState] = useState<RequestState<TraceDetailResponse>>({ scopeKey: '', status: 'loading' });

  useEffect(() => {
    if (!projectId) return undefined;
    const controller = new AbortController();
    const requestScope = scopeKey;
    setState({ scopeKey: requestScope, status: 'loading' });
    fetchTraceDetail({
      projectId,
      traceId: selection.traceId,
      environment: selection.environment,
      window: selection.window,
    }, controller.signal).then((data) => {
      if (!controller.signal.aborted && scopeRef.current === requestScope) {
        setState({ scopeKey: requestScope, status: 'ready', data });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && scopeRef.current === requestScope) {
        setState({ scopeKey: requestScope, status: 'error', message: chainErrorMessage(error) });
      }
    });
    return () => controller.abort();
  }, [projectId, selection.traceId, selection.environment, selection.window.from, selection.window.to, retry, scopeKey]);

  const visible = stateForScope(state, scopeKey);
  const detail = visible.status === 'ready' ? visible.data : undefined;
  const flattened = useMemo(() => detail ? flattenTraceTree(detail) : [], [detail]);
  const spanById = useMemo(() => new Map(detail?.spans.map((span) => [span.spanId, span]) ?? []), [detail]);
  const errorBySpanId = useMemo(() => new Map(detail?.errors.map((error) => [error.spanId, error.category]) ?? []), [detail]);
  const selectedSpan = detail
    ? spanById.get(selectedSpanId) ?? detail.rootSpan ?? detail.spans[0]
    : undefined;
  const usageFlag = selectedSpan?.attributes['llm.usage_available'];
  const usageKnown = selectedSpan?.operation === 'llm.generate'
    && (usageFlag === true || (usageFlag !== false && selectedSpan.totalTokens > 0));
  const rerankBefore = selectedSpan?.attributes['rag.rerank_before'];
  const rerankAfter = selectedSpan?.attributes['rag.rerank_after'];
  const totalDuration = detail?.summary.durationMs ?? 0;
  const traceStartMs = detail?.spans.length ? Math.min(...detail.spans.map((span) => Date.parse(span.startTime))) : 0;
  const slowSpanCount = flattened.reduce((count, item) => count + Number(item.span.durationMs >= 1000
    || (totalDuration > 0 && item.span.durationMs >= totalDuration * 0.2)), 0);

  return <section className="module-page trace-detail-page">
    <button className="back-link" type="button" aria-label="返回 Trace 列表" onClick={onBack}>← <span>返回 Trace 列表</span></button>
    <div className="trace-window-note"><strong>查询窗口</strong><span>{formatTime(selection.window.from)} – {formatTime(selection.window.to)}</span><p>仅展示窗口内已入库 Span；迟到或跨窗 Span 会影响链路完整性，即使未触发返回数量截断。</p></div>
    {visible.status === 'loading' && <div className="chain-state" role="status" aria-label="Trace 详情加载中">正在读取 {selection.traceId} 的详情…</div>}
    {visible.status === 'error' && <div className="chain-state error" role="alert"><span>{visible.message}</span><button className="text-action" type="button" aria-label="重试" onClick={() => setRetry((count) => count + 1)}>重试<Icon name="arrow" size={14} /></button></div>}
    {visible.status === 'ready' && detail && <>
      <div className="detail-title-row"><div><div className="eyebrow">TRACE DETAIL / {detail.environment.toUpperCase()}</div><h2>一次请求的完整路径</h2><span className="trace-copy-link"><code>{detail.traceId}</code></span></div><div className="detail-summary"><div><small>状态</small><StatusPill status={detail.summary.status === 'error' ? 'error' : 'ok'}>{detail.summary.status === 'error' ? 'ERROR' : 'OK'}</StatusPill></div><div><small>总耗时</small><strong>{formatLatency(detail.summary.durationMs)}</strong></div><div><small>Span 数</small><strong>{formatCount(detail.summary.spanCount)}</strong></div><div><small>Token</small><strong>{formatTokens(detail.summary.totalTokens)}</strong></div></div></div>
      {detail.summary.truncated && <div className="chain-warning" role="alert"><strong>Span 详情已截断</strong><span>该 Trace 超过后端详情上限；当前仅返回前 2000 个 Span，执行树可能不完整。</span></div>}
      {(detail.tree.orphanSpanIds.length > 0 || detail.tree.cycleSpanIds.length > 0 || detail.tree.multipleRoots) && <div className="tree-integrity-note" role="status"><strong>执行树结构提示</strong><span>{detail.tree.orphanSpanIds.length} 个孤儿 Span · {detail.tree.cycleSpanIds.length} 个环内 Span · {detail.tree.multipleRoots ? `${detail.tree.roots.length} 个根节点` : '单根结构'}</span></div>}
      <div className="detail-grid">
        <section className="panel tree-panel"><div className="panel-heading"><div><h2>Span 执行树</h2><small>{detail.summary.spanCount} 个 Span · 按开始时间定位 · {slowSpanCount} 个慢 Span</small></div><span className="trace-start-time"><Icon name="clock" size={13} />{detail.spans.length > 0 ? formatTime(new Date(traceStartMs).toISOString()) : '—'}</span></div>
          <div className="slow-span-note">慢 Span 标记规则：单个跨度 ≥ 1 秒，或占整条链路耗时 ≥ 20%。</div>
          <div className="trace-tree live-trace-tree" role="tree" aria-label="Span 执行树">
            {flattened.map(({ span, depth, orphan, cycle }) => {
              const selected = selectedSpan?.spanId === span.spanId;
              const errorCategory = errorBySpanId.get(span.spanId);
              const slow = span.durationMs >= 1000 || (totalDuration > 0 && span.durationMs >= totalDuration * 0.2);
              const left = totalDuration > 0 ? Math.max(0, Math.min(99, (Date.parse(span.startTime) - traceStartMs) / totalDuration * 100)) : 0;
              const width = totalDuration > 0 ? Math.max(0.7, Math.min(100 - left, span.durationMs / totalDuration * 100)) : 0.7;
              const operationTone = span.operation.startsWith('rag.') ? 'rag' : span.operation.startsWith('llm.') ? 'llm' : 'root';
              const badges = [errorCategory ? `异常 ${errorCategory}` : '', slow ? '慢 Span' : '', orphan ? '孤儿' : '', cycle ? '环节点' : ''].filter(Boolean);
              return <button key={span.spanId} className={`tree-row live-tree-row ${selected ? 'selected' : ''} ${span.status === 'error' ? 'span-error-row' : ''}`} type="button" role="treeitem" aria-level={depth + 1} aria-selected={selected} aria-label={`Span ${span.operation}，${span.spanId}，${span.status === 'error' ? '异常' : '正常'}，耗时 ${formatLatency(span.durationMs)}，深度 ${depth}${badges.length ? `，${badges.join('，')}` : ''}`} onClick={() => setSelectedSpanId(span.spanId)}>
                <span className="tree-label" data-depth={Math.min(depth, 8)} style={{ paddingInlineStart: `${Math.min(depth, 8) * 10}px` }}><strong>{span.operation}</strong><small>{span.service} · {span.spanId}</small>{badges.length > 0 && <span className="span-row-badges">{badges.map((badge) => <i key={badge} className={badge.includes('异常') ? 'error' : badge.includes('慢') ? 'slow' : 'integrity'}>{badge}</i>)}</span>}</span>
                <span className="tree-track live-tree-track"><i className={`live-tree-bar ${operationTone} ${span.status === 'error' ? 'error' : ''} ${slow ? 'slow' : ''}`} style={{ left: `${left}%`, width: `${width}%` }} /><span className="tree-duration">{formatLatency(span.durationMs)}</span></span>
              </button>;
            })}
            {flattened.length === 0 && <div className="empty-state">接口未返回 Span 明细。</div>}
          </div>
          <div className="tree-legend"><span><i className="legend-dot rag-dot" />RAG</span><span><i className="legend-dot llm-dot" />模型</span><span><i className="legend-dot error-dot" />异常分支</span></div>
        </section>
        <aside className="panel span-panel"><div className="span-panel-head"><div><span className="eyebrow">SPAN DETAILS</span><h2>{selectedSpan?.operation ?? '选择 Span'}</h2><small>{selectedSpan?.spanId ?? '—'}</small></div>{selectedSpan && <StatusPill status={selectedSpan.status === 'error' ? 'error' : 'ok'}>{selectedSpan.status === 'error' ? 'ERROR' : 'OK'}</StatusPill>}</div>
          {selectedSpan && <>
            <div className="span-meta">
              {[
                ['服务', selectedSpan.service], ['父 Span', selectedSpan.parentSpanId ?? '根节点'], ['开始时间', formatTime(selectedSpan.startTime)],
                ['结束时间', formatTime(selectedSpan.endTime)], ['耗时', formatLatency(selectedSpan.durationMs)],
                ...(selectedSpan.model ? [['模型', selectedSpan.model] as [string, string]] : []),
              ].map(([label, value]) => <div className="property-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}
              {errorBySpanId.has(selectedSpan.spanId) && <div className="error-context"><span>异常分类 · {errorBySpanId.get(selectedSpan.spanId)}</span><p>此 Span 为异常分支；Span 树继续展示它的子节点。</p></div>}
            </div>
            <section className="usage-panel live-usage-panel"><div><span>输入 Token</span><strong>{usageKnown ? formatCount(selectedSpan.inputTokens) : '—'}</strong></div><div><span>输出 Token</span><strong>{usageKnown ? formatCount(selectedSpan.outputTokens) : '—'}</strong></div><div><span>总 Token</span><strong>{usageKnown ? formatCount(selectedSpan.totalTokens) : '—'}</strong></div><div><span>TTFT</span><strong>{typeof selectedSpan.attributes['llm.ttft_ms'] === 'number' ? formatLatency(selectedSpan.attributes['llm.ttft_ms']) : '—'}</strong></div></section>
            <div className="live-attribute-list"><h3>安全属性</h3>{Object.keys(selectedSpan.attributes).length > 0 ? Object.entries(selectedSpan.attributes).map(([key, value]) => <div className="property-row" key={key}><span>{attributeLabel(key)}</span><strong>{formatAttribute(key, value)}</strong></div>) : <p>没有可展示的安全属性。</p>}</div>
            {(selectedSpan.attributes.sources || rerankBefore || rerankAfter) && <div className="rag-safe-details"><h3>RAG 安全摘要</h3>{Array.isArray(selectedSpan.attributes.sources) && <section className="hash-snapshot"><div className="hash-snapshot-heading"><strong>来源 SHA-256</strong><span>{selectedSpan.attributes.sources.length} 个</span></div><ul>{selectedSpan.attributes.sources.map((hash, index) => <li key={`${index}:${hash}`}><span>来源 {index + 1}</span><code title={hash}>{hash}</code></li>)}</ul></section>}{isRankSnapshot(rerankBefore) && <RankSnapshotView title="重排前" value={rerankBefore} />}{isRankSnapshot(rerankAfter) && <RankSnapshotView title="重排后" value={rerankAfter} />}</div>}
          </>}
          <div className="privacy-footnote">原始异常、Prompt、回答、文档正文与 URL 均不会从此页面读取。</div>
        </aside>
      </div>
    </>}
  </section>;
}

function AiMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="ai-data-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

export function AiChainPage({ projectId, environment, range }: { projectId: string; environment: OverviewEnvironment; range: OverviewRange }) {
  const [retry, setRetry] = useState(0);
  const scopeKey = JSON.stringify([projectId, environment, range]);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const [state, setState] = useState<RequestState<AiMetricsResponse>>({ scopeKey: '', status: 'loading' });

  useEffect(() => {
    if (!projectId) return undefined;
    const controller = new AbortController();
    const requestScope = scopeKey;
    setState({ scopeKey: requestScope, status: 'loading' });
    fetchAiMetrics(projectId, environment, range, controller.signal).then((data) => {
      if (!controller.signal.aborted && scopeRef.current === requestScope) setState({ scopeKey: requestScope, status: 'ready', data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && scopeRef.current === requestScope) setState({ scopeKey: requestScope, status: 'error', message: chainErrorMessage(error) });
    });
    return () => controller.abort();
  }, [projectId, environment, range, retry, scopeKey]);

  const visible = stateForScope(state, scopeKey);
  const data = visible.status === 'ready' ? visible.data : undefined;
  const llm = data?.llm;
  const rag = data?.rag;
  const hasLlm = Boolean(llm && llm.callCount > 0);
  const hasRag = Boolean(rag && rag.callCount > 0);

  return <section className="module-page ai-page">
    <PageIntro eyebrow="MODEL · RAG · USAGE" title="只呈现已经观测到的 AI 指标。" description="模型调用、Token、TTFT 与 RAG 召回/重排数据来自当前项目、环境和时间窗口的聚合 API；未知样本保持为 —。" />
    {visible.status === 'loading' && <div className="chain-state" role="status" aria-label="AI 指标加载中">正在读取模型与 RAG 指标…</div>}
    {visible.status === 'error' && <div className="chain-state error" role="alert"><span>{visible.message}</span><button className="text-action" type="button" aria-label="重试" onClick={() => setRetry((count) => count + 1)}>重试<Icon name="arrow" size={14} /></button></div>}
    {visible.status === 'ready' && data && <>
      <div className="ai-scope-caption">数据更新于 {formatTime(data.generatedAt)} · 窗口 {formatTime(data.range.from)} – {formatTime(data.range.to)}</div>
      <div className="ai-summary-grid"><MetricCard label="模型调用" value={formatCount(data.llm.callCount)} detail={`${formatCount(data.llm.errorCount)} 次失败 · 当前窗口`} /><MetricCard label="模型 Token" value={formatTokens(data.llm.totalTokens)} detail={`${formatCount(data.llm.inputTokens)} 输入 · ${formatCount(data.llm.outputTokens)} 输出`} /><MetricCard label="TTFT P95" value={data.llm.ttftSampleCount > 0 ? formatLatency(data.llm.p95TtftMs) : '—'} detail={`${formatCount(data.llm.ttftSampleCount)} 个有效样本`} tone="green" /><MetricCard label="RAG 空召回" value={data.rag.emptyRecallRate === null ? '—' : formatPercent(data.rag.emptyRecallRate)} detail={`${formatCount(data.rag.emptyRecallCount)} / ${formatCount(data.rag.observedRecallCount)} 个可观测成功调用`} tone="orange" /></div>
      {!hasLlm && !hasRag && <div className="overview-status empty" role="status">当前项目、环境与时间范围内没有模型或 RAG 调用。</div>}
      <div className="ai-content-grid live-ai-grid">
        <section className="panel ai-table-panel"><div className="panel-heading"><div><h2>模型用量</h2><small>按模型返回调用、失败、Token、延迟与 TTFT 样本</small></div></div><div className="table-scroll data-table-scroll"><table className="data-table"><thead><tr><th>模型</th><th>调用</th><th>失败数</th><th>错误率</th><th>输入 Token</th><th>输出 Token</th><th>总 Token</th><th>P95 延迟</th><th>TTFT P95</th></tr></thead><tbody>{data.llm.models.map((model) => <tr key={model.model}><td><strong className="safe-model-name">{model.model}</strong></td><td>{formatCount(model.callCount)}</td><td>{formatCount(model.errorCount)}</td><td>{model.callCount > 0 ? formatPercent(model.errorRate) : '—'}</td><td>{formatCount(model.inputTokens)}</td><td>{formatCount(model.outputTokens)}</td><td>{formatCount(model.totalTokens)}</td><td>{model.callCount > 0 ? formatLatency(model.p95LatencyMs) : '—'}</td><td>{model.ttftSampleCount > 0 ? formatLatency(model.p95TtftMs) : '—'}<small className="sample-count">{formatCount(model.ttftSampleCount)} 个样本</small></td></tr>)}</tbody></table>{data.llm.models.length === 0 && <div className="empty-state">所选窗口没有模型分组数据。</div>}</div><div className="panel-bottom-note">未配置价格表，因此不显示成本；未接入评估数据，因此不显示质量评分。</div></section>
        <section className="panel ai-table-panel live-rag-panel"><div className="panel-heading"><div><h2>RAG 召回与重排</h2><small>仅汇总真实 rag.retrieve 观测和有效属性样本</small></div></div><div className="rag-metric-list">
          <AiMetric label="检索调用" value={formatCount(data.rag.callCount)} detail={`${formatCount(data.rag.successCount)} 成功 · ${formatCount(data.rag.errorCount)} 失败`} />
          <AiMetric label="成功率" value={hasRag ? formatPercent(data.rag.successRate) : '—'} detail="成功调用 / 全部调用" />
          <AiMetric label="空召回率" value={data.rag.emptyRecallRate === null ? '—' : formatPercent(data.rag.emptyRecallRate)} detail={`${formatCount(data.rag.observedRecallCount)} 个成功调用可观测召回数`} />
          <AiMetric label="检索 P95" value={hasRag ? formatLatency(data.rag.p95LatencyMs) : '—'} detail="rag.retrieve 调用耗时" />
          <AiMetric label="召回 P95" value={data.rag.recallSampleCount > 0 ? formatLatency(data.rag.p95RecallMs) : '—'} detail={`${formatCount(data.rag.recallSampleCount)} 个有效样本`} />
          <AiMetric label="重排 P95" value={data.rag.rerankSampleCount > 0 ? formatLatency(data.rag.p95RerankMs) : '—'} detail={`${formatCount(data.rag.rerankSampleCount)} 个有效样本`} />
        </div><div className="panel-bottom-note">召回/重排耗时缺失或非法时不计为零样本；该页不推断相关性或回答质量。</div></section>
      </div>
    </>}
  </section>;
}
