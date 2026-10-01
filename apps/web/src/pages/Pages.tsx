import { useMemo, useState } from 'react';
import { agentRuns, mockAlerts, mockServices, mockTraces, modelUsage, ragRequests, traceSpans, type AlertLevel, type AlertState, type SpanRecord, type TraceRecord } from '../mock/data';
import { Icon, PageIntro, PanelHeading, StatusPill } from '../components/ui';
import type { OverviewEnvironment, OverviewRange, OverviewResponse, OverviewService, OverviewSeriesPoint } from '../overview-api';

function MetricCard({ label, value, detail, tone = 'blue', trend }: { label: string; value: string; detail: string; tone?: 'blue' | 'orange' | 'green'; trend?: string }) {
  return <article className="metric-card"><div className="metric-topline"><span className="metric-label">{label}</span><span className={`metric-swatch ${tone}`} /></div><div className="metric-bottom"><strong className="metric-value">{value}</strong>{trend && <span className={`metric-change ${tone === 'orange' ? 'down' : 'up'}`}>{trend}</span>}</div><p className="metric-detail">{detail}</p></article>;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}M`;
  if (value >= 10_000) return `${(value / 1_000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}K`;
  return formatCount(value);
}

function formatPercent(value: number): string {
  return `${(value * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`;
}

function formatLatency(value: number): string {
  return value >= 1000
    ? `${(value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}s`
    : `${Math.round(value)}ms`;
}

function formatTimestamp(value: string, range: OverviewRange): string {
  const options: Intl.DateTimeFormatOptions = range === '7d'
    ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat('zh-CN', options).format(new Date(value));
}

function getEnvironmentLabel(environment: OverviewEnvironment): string {
  switch (environment) {
    case 'dev': return 'development';
    case 'staging': return 'staging';
    case 'prod': return 'production';
    case 'all': return '全部环境';
  }
}

function getRangeLabel(range: OverviewRange): string {
  if (range === '1h') return '最近 1 小时';
  if (range === '7d') return '最近 7 天';
  return '最近 24 小时';
}

function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function formatBucket(value: string, range: OverviewRange): string {
  const options: Intl.DateTimeFormatOptions = range === '7d'
    ? { month: 'numeric', day: 'numeric', hour: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat('zh-CN', options).format(new Date(value));
}

function TrendChart({ series, range }: { series: OverviewSeriesPoint[]; range: OverviewRange }) {
  const left = 54;
  const right = 752;
  const top = 25;
  const bottom = 218;
  const width = right - left;
  const height = bottom - top;
  const points = [...series].sort((a, b) => Date.parse(a.bucketStart) - Date.parse(b.bucketStart));
  const requestMax = niceCeiling(Math.max(4, ...points.map((point) => point.requestCount)));
  const rateMax = Math.max(0.01, niceCeiling(Math.max(...points.map((point) => point.errorRate)) * 100) / 100);
  const x = (index: number) => points.length < 2 ? left + width / 2 : left + (index / (points.length - 1)) * width;
  const requestY = (value: number) => bottom - (value / requestMax) * height;
  const errorY = (value: number) => bottom - (value / rateMax) * height;
  const requestPath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${requestY(point.requestCount)}`).join(' ');
  const errorPath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${errorY(point.errorRate)}`).join(' ');
  const tickIndexes = [...new Set([0, Math.round((points.length - 1) / 4), Math.round((points.length - 1) / 2), Math.round((points.length - 1) * 3 / 4), points.length - 1])];

  return <svg className="trend-chart" viewBox="0 0 800 260" preserveAspectRatio="none" role="img" aria-label={`${range} 请求量与错误率趋势`}>
    {[0, 1, 2, 3, 4].map((tick) => {
      const y = top + (height * tick) / 4;
      const ratio = 1 - tick / 4;
      return <g key={tick}>
        <line className="grid-line" x1={left} y1={y} x2={right} y2={y} />
        <text className="axis-label left" x={left - 8} y={y + 3}>{formatCount(requestMax * ratio)}</text>
        <text className="axis-label right" x={right + 8} y={y + 3}>{formatPercent(rateMax * ratio)}</text>
      </g>;
    })}
    {tickIndexes.map((index) => <g key={index}>
      <line className="grid-line vertical" x1={x(index)} y1={top} x2={x(index)} y2={bottom} />
      <text className="axis-label time" x={x(index)} y="246">{formatBucket(points[index].bucketStart, range)}</text>
    </g>)}
    <path className="chart-line requests" d={requestPath} />
    <path className="chart-line errors" d={errorPath} />
  </svg>;
}

function OverviewMessage({ children, loading = false }: { children: string; loading?: boolean }) {
  return <div className={`overview-panel-message ${loading ? 'loading' : ''}`} role={loading ? 'status' : undefined}>{children}</div>;
}

function serviceState(service: OverviewService): { tone: 'ok' | 'warning' | 'muted'; label: string } {
  if (service.status === 'healthy') return { tone: 'ok', label: '正常' };
  if (service.status === 'degraded') return { tone: 'warning', label: '需关注' };
  return { tone: 'muted', label: '暂无数据' };
}

export function OverviewPage({
  status,
  errorMessage,
  data,
  environment,
  range,
  empty,
  onRetry,
  onSelectTrace,
}: {
  status: 'loading-projects' | 'project-error' | 'no-projects' | 'loading' | 'error' | 'ready';
  errorMessage?: string;
  data?: OverviewResponse;
  environment: OverviewEnvironment;
  range: OverviewRange;
  empty: boolean;
  onRetry: () => void;
  onSelectTrace: (id: string) => void;
}) {
  const metric = status === 'ready' ? data?.metrics : undefined;
  const demoEnvironment = environment === 'prod' ? 'production' : environment === 'dev' ? 'development' : environment;
  const demoTraces = mockTraces
    .filter((trace) => environment === 'all' || trace.environment === demoEnvironment)
    .slice(0, 5);
  const statusCopy: Record<typeof status, string> = {
    'loading-projects': '正在读取项目列表…',
    'project-error': errorMessage ?? '项目列表加载失败。',
    'no-projects': '当前没有可用项目，请先配置项目后再查看监控数据。',
    loading: '正在加载所选项目的 Overview 数据…',
    error: errorMessage ?? 'Overview 数据加载失败。',
    ready: empty ? '该项目、环境与时间范围内暂无观测数据。' : '',
  };
  const isError = status === 'error' || status === 'project-error';
  const canRetry = isError || status === 'no-projects';
  const panelMessage = status === 'ready'
    ? '暂无数据'
    : status === 'loading' || status === 'loading-projects' ? '正在读取…' : '数据暂不可用';

  return <>
    {statusCopy[status] && <div className={`overview-status ${isError ? 'error' : status === 'ready' ? 'empty' : 'info'}`} role={isError ? 'alert' : 'status'} aria-live="polite">
      <span>{statusCopy[status]}</span>
      {canRetry && <button className="text-action" type="button" onClick={onRetry}>{status === 'no-projects' ? '重新加载项目' : '重试'}<Icon name="arrow" size={14} /></button>}
    </div>}

    <section className="metric-grid" aria-label="关键指标" aria-busy={status === 'loading' || status === 'loading-projects'}>
      <MetricCard label="请求量" value={metric ? formatCount(metric.requestCount) : '—'} detail={metric ? `${formatCount(metric.errorCount)} 次错误 · ${getRangeLabel(range)}` : panelMessage} />
      <MetricCard label="错误率" value={metric ? formatPercent(metric.errorRate) : '—'} detail={metric ? '请求 Span 口径 · 不含前端诊断事件' : panelMessage} tone="orange" />
      <MetricCard label="P95 延迟" value={metric ? formatLatency(metric.p95LatencyMs) : '—'} detail={metric ? `环境：${getEnvironmentLabel(environment)}` : panelMessage} tone="green" />
      <MetricCard label="Token 消耗" value={metric ? formatTokens(metric.totalTokens) : '—'} detail={metric ? '输入与输出 Token 合计' : panelMessage} />
    </section>

    <section className="primary-grid">
      <article className="panel chart-panel"><div className="panel-heading chart-heading"><h2>请求与错误率</h2><div className="legend"><span><i className="legend-dot requests-dot" />请求量</span><span><i className="legend-dot errors-dot" />错误率</span></div></div><div className="chart-wrap">
        {status === 'ready' && data?.series.length ? <TrendChart series={data.series} range={range} /> : <OverviewMessage loading={status === 'loading' || status === 'loading-projects'}>{status === 'ready' ? '当前时间范围内暂无趋势数据' : panelMessage}</OverviewMessage>}
      </div></article>
      <article className="panel alerts-panel"><PanelHeading title="最近错误" aside={<span className="muted-caption">Overview 接口</span>} /><div className="recent-error-list">
        {status === 'ready' && data?.recentErrors.length ? data.recentErrors.slice(0, 5).map((error, index) => <article className="recent-error-row" key={`${error.traceId}-${error.startTime}-${error.service}-${error.operation}-${index}`}>
          <i className="severity-dot critical" />
          <span className="recent-error-copy"><strong>{error.service}</strong><small title={error.operation}>{error.operation}<i />{formatTimestamp(error.startTime, range)}</small><code title={error.traceId}>{error.traceId}</code></span>
          <span className="recent-error-duration">{formatLatency(error.durationMs)}</span>
        </article>) : <OverviewMessage loading={status === 'loading' || status === 'loading-projects'}>{status === 'ready' ? '此时间范围内暂无错误' : panelMessage}</OverviewMessage>}
      </div></article>
    </section>

    <section className="secondary-grid">
      <article className="panel table-panel"><PanelHeading title="服务状态" aside={status === 'ready' && data ? <span className="muted-caption">{data.services.length} 个服务 · API 数据</span> : undefined} /><div className="table-scroll"><table><thead><tr><th>服务</th><th>Span / 事件数</th><th>异常占比</th><th>P95</th><th>状态</th></tr></thead><tbody>
        {status === 'ready' && data?.services.length ? data.services.slice(0, 5).map((service) => {
          const state = serviceState(service);
          return <tr key={service.name}><td className="service-name">{service.name}<small className="service-last-seen">最近上报：{service.lastSeenAt ? formatTimestamp(service.lastSeenAt, range) : '—'}</small></td><td>{formatCount(service.requestCount)}</td><td>{formatPercent(service.errorRate)}</td><td>{formatLatency(service.p95LatencyMs)}</td><td><StatusPill status={state.tone}>{state.label}</StatusPill></td></tr>;
        }) : <tr><td colSpan={5} className="overview-table-empty">{status === 'ready' ? '暂无服务数据' : panelMessage}</td></tr>}
      </tbody></table></div><div className="table-caption">环境：{getEnvironmentLabel(environment)} <span>·</span> 数据来自当前筛选条件</div></article>
      <article className="panel table-panel traces-panel"><PanelHeading title="最新 Traces" aside={<span className="muted-caption">演示数据</span>} /><div className="table-scroll"><table><thead><tr><th>Trace ID</th><th>服务</th><th>耗时</th><th>状态</th><th>时间</th></tr></thead><tbody>
        {demoTraces.length > 0 ? demoTraces.map((trace) => <tr key={trace.id}><td><button className="trace-id" type="button" onClick={() => onSelectTrace(trace.id)}>{trace.id.slice(0, 8)}…</button></td><td>{trace.service}</td><td>{trace.duration}</td><td><StatusPill status={trace.status === 'error' ? 'error' : 'ok'}>{trace.status === 'error' ? '错误' : '成功'}</StatusPill></td><td>{trace.time.slice(0, 5)}</td></tr>) : <tr><td colSpan={5} className="overview-table-empty">该环境暂无演示 Trace</td></tr>}
      </tbody></table></div><div className="table-caption">Trace 检索接入后将替换为真实数据</div></article>
    </section>
  </>;
}

export function TraceExplorer({ environment, onSelectTrace, onNotify }: { environment: string; onSelectTrace: (id: string) => void; onNotify: (message: string) => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [service, setService] = useState('all');
  const filtered = useMemo(() => mockTraces.filter((trace) => {
    const searchText = `${trace.id} ${trace.operation} ${trace.service} ${trace.error ?? ''}`.toLowerCase();
    return (environment === 'all' || trace.environment === environment) && (!query || searchText.includes(query.toLowerCase())) && (status === 'all' || trace.status === status) && (service === 'all' || trace.service === service);
  }), [environment, query, service, status]);

  return <section className="module-page">
    <PageIntro eyebrow="TRACE EXPLORER / 全链路检索" title="从一次请求看完整链路。" description="按 Trace ID、服务或错误信息检索，点击记录查看 Span 执行树与上下文。" actions={<button className="button secondary" type="button" onClick={() => onNotify('已创建当前筛选结果的导出任务')}><Icon name="download" size={15} />导出结果</button>} />
    <section className="panel trace-explorer-panel">
      <div className="filter-toolbar"><label className="search-input"><Icon name="search" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Trace ID、错误信息、服务…" aria-label="搜索 Trace" /></label><label className="compact-filter"><span>状态</span><select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="按状态筛选"><option value="all">全部状态</option><option value="ok">成功</option><option value="error">错误</option></select></label><label className="compact-filter"><span>服务</span><select value={service} onChange={(event) => setService(event.target.value)} aria-label="按服务筛选"><option value="all">全部服务</option>{[...new Set(mockTraces.map((trace) => trace.service))].map((name) => <option key={name}>{name}</option>)}</select></label><span className="result-count">{filtered.length} 条结果</span></div>
      <div className="table-scroll data-table-scroll"><table className="data-table"><thead><tr><th>TRACE ID</th><th>OPERATION</th><th>SERVICE</th><th>STATUS</th><th>DURATION</th><th>SPANS</th><th>TOKENS</th><th>ENVIRONMENT</th><th>TIME</th></tr></thead><tbody>{filtered.map((trace) => <tr key={trace.id} className="clickable-row" onClick={() => onSelectTrace(trace.id)} onKeyDown={(event) => { if (event.key === 'Enter') onSelectTrace(trace.id); }} tabIndex={0}><td><button type="button" className="trace-id" onClick={(event) => { event.stopPropagation(); onSelectTrace(trace.id); }}>{trace.id}</button></td><td>{trace.operation}</td><td>{trace.service}</td><td><StatusPill status={trace.status === 'error' ? 'error' : 'ok'}>{trace.status === 'error' ? '错误' : '成功'}</StatusPill></td><td className="numeric-cell">{trace.duration}</td><td>{trace.spans}</td><td>{trace.tokens.toLocaleString()}</td><td><span className="env-tag">{trace.environment}</span></td><td>{trace.time}</td></tr>)}</tbody></table>{filtered.length === 0 && <div className="empty-state"><span>没有符合条件的 Trace</span><button type="button" className="text-action" onClick={() => { setQuery(''); setStatus('all'); setService('all'); }}>清除筛选</button></div>}</div>
      <div className="table-footer"><span>演示数据 · 最近采集记录</span><span>第 1 页，共 {filtered.length} 条 <button type="button" disabled aria-label="上一页">‹</button><button type="button" disabled aria-label="下一页">›</button></span></div>
    </section>
    <div className="privacy-note"><span className="note-mark">i</span><span>Trace ID 默认脱敏显示之外的敏感字段不会采集原文；Prompt / Response 内容采集默认关闭。</span></div>
  </section>;
}

function spanForTrace(trace: TraceRecord): SpanRecord[] {
  return traceSpans.map((span) => {
    if (span.operation === 'http.server') return { ...span, durationMs: trace.durationMs, status: trace.status };
    if (span.operation === 'llm.generate' && trace.status === 'ok') return { ...span, status: 'ok', error: undefined, summary: `gpt-4o · ${trace.tokens.toLocaleString()} tokens`, durationMs: Math.min(span.durationMs, Math.round(trace.durationMs * 0.43)) };
    return span;
  });
}

export function TraceDetail({ trace, onBack, onNotify }: { trace: TraceRecord; onBack: () => void; onNotify: (message: string) => void }) {
  const spans = spanForTrace(trace);
  const [selectedSpanId, setSelectedSpanId] = useState('sp-04');
  const [tab, setTab] = useState<'attributes' | 'usage' | 'events'>('attributes');
  const selected = spans.find((span) => span.id === selectedSpanId) ?? spans[0];
  const total = trace.durationMs;

  return <section className="module-page trace-detail-page">
    <button className="back-link" type="button" onClick={onBack}>← <span>返回 Trace 列表</span></button>
    <div className="detail-title-row"><div><div className="eyebrow">TRACE DETAIL / {trace.status === 'error' ? 'NEEDS INVESTIGATION' : 'COMPLETED'}</div><h2>一次请求的完整路径</h2><button className="trace-copy-link" type="button" onClick={() => onNotify('Trace ID 已复制')}>{trace.id}<Icon name="copy" size={13} /></button></div><div className="detail-summary"><div><small>状态</small><StatusPill status={trace.status === 'error' ? 'error' : 'ok'}>{trace.status === 'error' ? 'ERROR' : 'OK'}</StatusPill></div><div><small>总耗时</small><strong>{trace.duration}</strong></div><div><small>Span 数</small><strong>{trace.spans}</strong></div><div><small>Token</small><strong>{trace.tokens.toLocaleString()}</strong></div></div></div>
    <div className="detail-grid">
      <section className="panel tree-panel"><div className="panel-heading"><div><h2>Span 执行树</h2><small>按 parentSpanId 组织 · 点击任意 Span 查看属性</small></div><span className="trace-start-time"><Icon name="clock" size={14} />{trace.time}</span></div><div className="trace-tree"><div className="tree-axis"><span>0 ms</span><span><i>0%</i><i>25%</i><i>50%</i><i>75%</i><i>100%</i></span></div>{spans.map((span, index) => { const parent = span.parentId ? spans.find((candidate) => candidate.id === span.parentId) : undefined; const depth = parent ? parent.parentId ? 2 : 1 : 0; const left = index === 0 ? 0 : Math.min(92, (span.startMs / total) * 100); const width = index === 0 ? 100 : Math.max(5, Math.min(100 - left, (span.durationMs / total) * 100)); return <button className={`tree-row ${selectedSpanId === span.id ? 'selected' : ''}`} type="button" key={span.id} onClick={() => setSelectedSpanId(span.id)}><span className="tree-label" data-depth={depth} style={{ paddingLeft: depth * 15 }}><strong>{span.operation}</strong><small>{span.service}{depth === 0 ? ' · root' : ''}</small></span><span className="tree-track"><i className={`tree-bar ${span.operation.includes('rag') ? 'rag' : span.operation.includes('llm') ? 'llm' : span.operation === 'rerank' ? 'db' : 'root'} ${span.status === 'error' ? 'error' : ''}`} style={{ left: `${left}%`, width: `${width}%` }}><span>{span.summary}</span></i><span className="tree-duration">{span.durationMs}ms</span></span></button>; })}</div><div className="tree-legend"><span><i className="legend-dot requests-dot" />服务调用</span><span><i className="legend-dot rag-dot" />RAG</span><span><i className="legend-dot llm-dot" />LLM</span><span><i className="legend-dot error-dot" />错误</span></div></section>
      <aside className="panel span-panel"><div className="span-panel-head"><div><span className="eyebrow">SELECTED SPAN</span><h2>{selected.operation}</h2><small>{selected.service} · {selected.durationMs}ms</small></div><StatusPill status={selected.status === 'error' ? 'error' : 'ok'}>{selected.status === 'error' ? 'ERROR' : 'OK'}</StatusPill></div><div className="span-tabs" role="tablist" aria-label="Span 信息分类">{(['attributes', 'usage', 'events'] as const).map((name) => <button key={name} className={`span-tab ${tab === name ? 'active' : ''}`} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name === 'attributes' ? '属性' : name === 'usage' ? 'Token 用量' : '事件'}</button>)}</div>{tab === 'attributes' && <div className="span-meta">{Object.entries(selected.attributes).map(([key, value]) => <div className="property-row" key={key}><span>{key}</span><strong>{Array.isArray(value) ? value.join(', ') : String(value)}</strong></div>)}{selected.error && <div className="error-context"><span>错误上下文</span><p>{selected.error}</p></div>}</div>}{tab === 'usage' && <div className="usage-panel"><div><span>输入 Token</span><strong>{(selected.inputTokens ?? 0).toLocaleString()}</strong></div><div><span>输出 Token</span><strong>{(selected.outputTokens ?? 0).toLocaleString()}</strong></div><div><span>合计</span><strong>{((selected.inputTokens ?? 0) + (selected.outputTokens ?? 0)).toLocaleString()}</strong></div><p>Token 数据来自模型响应 usage 字段。</p></div>}{tab === 'events' && <div className="event-list"><div><i className="event-dot" /><span><strong>Span started</strong><small>{selected.startMs}ms · {selected.service}</small></span></div><div><i className={`event-dot ${selected.status === 'error' ? 'error' : ''}`} /><span><strong>{selected.status === 'error' ? 'exception raised' : 'Span completed'}</strong><small>{selected.durationMs}ms · {selected.error ?? 'status: ok'}</small></span></div></div>}<div className="privacy-footnote">敏感内容未在该演示视图中展示。</div></aside>
    </div>
  </section>;
}

type AiTab = 'models' | 'rag' | 'agents';
export function AiChainPage({ onSelectTrace, onNotify }: { onSelectTrace: (id: string) => void; onNotify: (message: string) => void }) {
  const [tab, setTab] = useState<AiTab>('models');
  return <section className="module-page ai-page">
    <PageIntro eyebrow="MODEL · RAG · AGENT" title="看见 AI 请求的质量与成本。" description="从模型调用、检索质量到 Agent 工具执行，沿 Trace 关联每一个环节。" actions={<button className="button secondary" type="button" onClick={() => onNotify('AI 链路报告已加入导出队列')}><Icon name="download" size={15} />导出报告</button>} />
    <div className="ai-summary-grid"><MetricCard label="平均首 Token（TTFT）" value="420ms" detail="较上一周期下降 12%" tone="green" /><MetricCard label="RAG 命中率" value="78.4%" detail="回答引用了检索上下文" /><MetricCard label="单次请求成本" value="$0.0038" detail="按模型价格估算 · 今日" tone="orange" /><MetricCard label="模型调用错误" value="0.91%" detail="过去 24 小时" /></div>
    <div className="segmented-tabs" role="tablist" aria-label="AI 链路类型">{([{ id: 'models', label: '模型调用' }, { id: 'rag', label: 'RAG 检索' }, { id: 'agents', label: 'Agent 执行' }] as const).map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
    {tab === 'models' && <div className="ai-content-grid"><section className="panel ai-table-panel"><div className="panel-heading"><div><h2>模型调用与成本</h2><small>按 Token 消耗排序 · 价格为估算值</small></div><button type="button" className="text-action" onClick={() => onNotify('价格表配置将在后续迭代开放')}>价格说明</button></div><div className="table-scroll data-table-scroll"><table className="data-table"><thead><tr><th>模型</th><th>调用次数</th><th>Token 消耗</th><th>延迟均值</th><th>错误率</th><th>估算成本</th></tr></thead><tbody>{modelUsage.map((model) => <tr key={model.model}><td><div className="model-cell"><span className="model-mark">{model.model.includes('mini') ? 'm' : model.model.startsWith('text') ? 'e' : '4o'}</span><span><strong>{model.model}</strong><small>{model.provider}</small></span></div></td><td>{model.calls}</td><td><div className="usage-cell"><span>{model.tokens}</span><i><b style={{ width: `${model.share}%` }} /></i></div></td><td>{model.latency}</td><td>{model.errorRate}</td><td>{model.cost}</td></tr>)}</tbody></table></div><div className="panel-bottom-note">支持从 Trace 详情查看单次模型请求的 Prompt 版本与 usage 元数据。</div></section><section className="panel quality-card"><div className="panel-heading"><div><h2>RAG 质量信号</h2><small>过去 24 小时 · 7,240 次检索</small></div><StatusPill status="ok">稳定</StatusPill></div><div className="quality-stack">{[{ name: '检索成功率', value: 96.8 }, { name: '有效召回率', value: 78.4 }, { name: '引用覆盖率', value: 72.1 }].map((item) => <div className="quality-item" key={item.name}><header><span>{item.name}</span><strong>{item.value}%</strong></header><div className="quality-track"><i style={{ width: `${item.value}%` }} /></div></div>)}<div className="quality-note"><strong>需要留意</strong><span>过去 30 分钟有 18 条 Trace 出现“召回为空”。</span><button className="text-action" type="button" onClick={() => setTab('rag')}>查看检索记录<Icon name="arrow" size={13} /></button></div></div></section></div>}
    {tab === 'rag' && <section className="panel ai-table-panel"><div className="panel-heading"><div><h2>RAG 检索记录</h2><small>召回文档、检索耗时与关联 Trace</small></div><span className="muted-caption">召回为空 18 条 · 过去 30 分钟</span></div><div className="table-scroll data-table-scroll"><table className="data-table"><thead><tr><th>查询摘要</th><th>topK</th><th>召回文档</th><th>最佳相关度</th><th>检索耗时</th><th>结果</th><th>TRACE</th></tr></thead><tbody>{ragRequests.map((row) => <tr key={row.traceId}><td className="query-cell">{row.query}</td><td>{row.topK}</td><td>{row.sources}</td><td>{row.score}</td><td>{row.latency}</td><td><StatusPill status={row.hit === '命中' ? 'ok' : 'warning'}>{row.hit}</StatusPill></td><td><button className="trace-id" type="button" onClick={() => onSelectTrace(row.traceId)}>{row.traceId.slice(0, 8)}…</button></td></tr>)}</tbody></table></div><div className="panel-bottom-note">检索文本只展示摘要；文档正文及用户输入默认不采集。</div></section>}
    {tab === 'agents' && <section className="panel ai-table-panel"><div className="panel-heading"><div><h2>Agent 执行记录</h2><small>通过 Span 父子关系还原 Agent、Chain 与 Tool 调用</small></div><span className="muted-caption">执行树数据来自演示 Trace</span></div><div className="agent-run-list">{agentRuns.map((run) => <article className="agent-run" key={run.traceId}><div className="agent-run-main"><div className="agent-run-top"><span className="agent-name">{run.agent}</span><StatusPill status={run.status === '成功' ? 'ok' : 'error'}>{run.status}</StatusPill></div><strong>{run.task}</strong><small>{run.steps} 个 Span · {run.duration}</small></div><div className="agent-run-tools"><span>TOOLS</span><strong>{run.tools}</strong></div><button className="button secondary compact" type="button" onClick={() => onSelectTrace(run.traceId)}>查看执行树<Icon name="arrow" size={13} /></button></article>)}</div></section>}
  </section>;
}

const severityLabel: Record<AlertLevel, string> = { critical: '严重', warning: '警告', info: '提示' };
const stateLabel: Record<AlertState, string> = { active: '待处理', acknowledged: '已确认', resolved: '已关闭' };
export function AlertsPage({ onSelectTrace, onNotify, environment }: { onSelectTrace: (id: string) => void; onNotify: (message: string) => void; environment: string }) {
  const [items, setItems] = useState(mockAlerts);
  const [filter, setFilter] = useState<'all' | 'active' | 'resolved'>('all');
  const [level, setLevel] = useState('all');
  const [muted, setMuted] = useState(false);
  const scopedItems = items.filter((item) => environment === 'all' || item.environment === environment);
  const filtered = scopedItems.filter((item) => (filter === 'all' || (filter === 'active' ? item.state !== 'resolved' : item.state === 'resolved')) && (level === 'all' || item.level === level));
  const changeState = (id: string, state: AlertState) => setItems((current) => current.map((item) => item.id === id ? { ...item, state } : item));
  return <section className="module-page alerts-page">
    <PageIntro eyebrow="ALERTS / INCIDENTS" title="把异常跟进到有结论。" description="按严重程度查看异常，确认处理状态，或直接进入关联 Trace 定位问题。" actions={<><button className={`button secondary ${muted ? 'button-muted' : ''}`} type="button" onClick={() => { setMuted((value) => !value); onNotify(muted ? '告警通知已恢复' : '演示规则已静默 1 小时'); }}><span className="bell-mark">{muted ? '◌' : '⌁'}</span>{muted ? '恢复通知' : '静默 1 小时'}</button><button className="button primary" type="button" onClick={() => onNotify('规则配置表单将在告警规则迭代中开放')}><Icon name="plus" size={15} />新建规则</button></>} />
    <div className="alert-summary-grid"><article><span>待处理告警</span><strong>{scopedItems.filter((item) => item.state !== 'resolved').length}<small> 条</small></strong><em>当前环境</em></article><article><span>严重告警</span><strong>{scopedItems.filter((item) => item.level === 'critical' && item.state !== 'resolved').length}<small> 条</small></strong><em>优先跟进</em></article><article><span>已确认</span><strong>{scopedItems.filter((item) => item.state === 'acknowledged').length}<small> 条</small></strong><em>处理中</em></article><article><span>已关闭</span><strong>{scopedItems.filter((item) => item.state === 'resolved').length}<small> 条</small></strong><em>最近 24 小时</em></article></div>
    <section className="panel alert-table-panel"><div className="alert-toolbar"><div className="segmented-tabs small-tabs" role="tablist" aria-label="告警状态筛选">{([{ id: 'all', label: '全部' }, { id: 'active', label: '待处理' }, { id: 'resolved', label: '已关闭' }] as const).map((item) => <button type="button" key={item.id} className={filter === item.id ? 'active' : ''} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div><label className="compact-filter"><span>级别</span><select value={level} onChange={(event) => setLevel(event.target.value)} aria-label="按告警级别筛选"><option value="all">全部级别</option><option value="critical">严重</option><option value="warning">警告</option><option value="info">提示</option></select></label></div>
      <div className="table-scroll data-table-scroll"><table className="data-table"><thead><tr><th>级别</th><th>告警</th><th>服务</th><th>规则</th><th>关联 Trace</th><th>状态</th><th>发生时间</th><th>操作</th></tr></thead><tbody>{filtered.map((alert) => <tr key={alert.id}><td><StatusPill status={alert.level === 'critical' ? 'error' : alert.level === 'warning' ? 'warning' : 'info'}>{severityLabel[alert.level]}</StatusPill></td><td className="alert-description-cell"><strong>{alert.title}</strong><small>{alert.description}</small></td><td>{alert.service}</td><td><code>{alert.rule}</code></td><td>{alert.traceId ? <button className="trace-id" type="button" onClick={() => onSelectTrace(alert.traceId!)}>{alert.traceId.slice(0, 8)}…</button> : '—'}</td><td><span className={`alert-state ${alert.state}`}>{stateLabel[alert.state]}</span></td><td>{alert.time}</td><td><div className="row-actions">{alert.state === 'active' && <button type="button" onClick={() => changeState(alert.id, 'acknowledged')}>确认</button>}{alert.state !== 'resolved' && <button type="button" onClick={() => changeState(alert.id, 'resolved')}>关闭</button>}{alert.state === 'resolved' && <button type="button" onClick={() => changeState(alert.id, 'active')}>重新打开</button>}</div></td></tr>)}</tbody></table>{filtered.length === 0 && <div className="empty-state">没有符合条件的告警。</div>}</div>
      <div className="table-footer"><span>演示告警 · 状态修改仅在当前页面生效</span><span>{filtered.length} 条记录</span></div>
    </section>
  </section>;
}

type SettingsTab = 'project' | 'services' | 'privacy' | 'retention' | 'access';
export function SettingsPage({ onNotify }: { onNotify: (message: string) => void }) {
  const [tab, setTab] = useState<SettingsTab>('project');
  const [captureContent, setCaptureContent] = useState(false);
  const [webVitals, setWebVitals] = useState(true);
  const [errorAlerts, setErrorAlerts] = useState(true);
  const [projectName, setProjectName] = useState('客服智能体');
  const tabs: { id: SettingsTab; label: string }[] = [{ id: 'project', label: '项目概况' }, { id: 'services', label: '服务与环境' }, { id: 'privacy', label: '采集与脱敏' }, { id: 'retention', label: '数据保留' }, { id: 'access', label: '接入凭证' }];
  return <section className="module-page settings-page">
    <PageIntro eyebrow="PROJECT / CONFIGURATION" title="项目边界与数据策略。" description="管理服务接入、环境、采集开关和数据保留周期。敏感数据默认不采集原文。" actions={<button className="button primary" type="button" onClick={() => onNotify('设置已保存（演示数据不会写入后端）')}><Icon name="check" size={15} />保存修改</button>} />
    <div className="settings-tabs" role="tablist" aria-label="项目设置分类">{tabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} type="button" onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
    {tab === 'project' && <div className="settings-content-grid"><section className="panel settings-card"><div className="panel-heading"><div><h2>项目基本信息</h2><small>项目标识用于隔离各应用的 Trace 数据</small></div><span className="settings-status">ACTIVE</span></div><div className="form-grid"><label className="form-field">项目名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><label className="form-field">项目标识<input value="customer-assistant" readOnly /></label><label className="form-field">默认环境<select defaultValue="production"><option>production</option><option>staging</option><option>development</option></select></label><label className="form-field">项目时区<select defaultValue="Asia/Shanghai"><option>Asia/Shanghai</option><option>UTC</option></select></label></div><div className="panel-bottom-note">项目创建于 2026-09-12 · 所有指标均为演示数据</div></section><section className="panel settings-card"><div className="panel-heading"><div><h2>采集策略摘要</h2><small>服务级策略可在“服务与环境”中单独配置</small></div></div><div className="setting-list"><SettingToggle title="采集 Prompt / Response 原文" description="默认关闭，仅记录长度、Hash 与 Token 用量。" value={captureContent} onChange={setCaptureContent} /><SettingToggle title="采集前端性能指标" description="记录 LCP、INP、CLS、FCP 与 TTFB。" value={webVitals} onChange={setWebVitals} /><SettingToggle title="错误 Span 实时告警" description="当 Span 状态为 error 时触发严重级别告警。" value={errorAlerts} onChange={setErrorAlerts} /></div></section></div>}
    {tab === 'services' && <section className="panel settings-card"><div className="panel-heading"><div><h2>已接入服务</h2><small>共 {mockServices.length} 个服务 · 最近上报版本 SDK 0.1.0</small></div><button className="button secondary" type="button" onClick={() => onNotify('服务接入指引已准备好，请查看“接入文档”')}><Icon name="plus" size={15} />添加服务</button></div><div className="table-scroll data-table-scroll"><table className="data-table"><thead><tr><th>服务名称</th><th>环境</th><th>SDK 版本</th><th>最近上报</th><th>错误率</th><th>状态</th></tr></thead><tbody>{mockServices.map((service, index) => <tr key={service.name}><td className="service-name">{service.name}</td><td><span className="env-tag">{index === 3 ? 'staging' : 'production'}</span></td><td>0.1.0</td><td>{index === 2 ? '刚刚' : `${index + 1} 分钟前`}</td><td>{service.errors}</td><td><StatusPill status="ok">运行中</StatusPill></td></tr>)}</tbody></table></div></section>}
    {tab === 'privacy' && <div className="settings-content-grid"><section className="panel settings-card"><div className="panel-heading"><div><h2>内容采集与脱敏</h2><small>可在项目范围控制敏感字段采集</small></div><StatusPill status="ok">默认安全</StatusPill></div><div className="setting-list"><SettingToggle title="采集 Prompt / Response 原文" description="开启后可在 Trace 详情查看模型输入和输出；请确认符合数据合规要求。" value={captureContent} onChange={setCaptureContent} /><div className="setting-item"><div><strong>自动脱敏规则</strong><p>对邮箱、手机号和疑似密钥字段自动替换为掩码。</p></div><span className="policy-chip">已启用</span></div><div className="setting-item"><div><strong>用户标识采集</strong><p>仅采集不可逆 Hash，不保存原始用户 ID。</p></div><span className="policy-chip">Hash</span></div></div></section><section className="panel settings-card"><div className="panel-heading"><div><h2>默认过滤字段</h2><small>以下内容不会进入 Span attributes</small></div></div><div className="redaction-list"><code>authorization</code><code>cookie</code><code>password</code><code>email</code><code>phone</code><code>document.content</code></div><p className="settings-callout">Prompt / Response 原文默认不采集。启用前请确认项目数据边界和成员访问权限。</p></section></div>}
    {tab === 'retention' && <div className="settings-content-grid"><section className="panel settings-card"><div className="panel-heading"><div><h2>Trace 数据保留</h2><small>超过保留周期的数据由存储层自动清理</small></div></div><label className="form-field retention-select">保留天数<select defaultValue="30"><option value="7">7 天</option><option value="14">14 天</option><option value="30">30 天</option><option value="90">90 天</option></select></label><div className="retention-meter"><div><span>当前存储用量</span><strong>18.4 GB <small>/ 50 GB</small></strong></div><i><b style={{ width: '37%' }} /></i><small>演示估算 · ClickHouse 按日期分区与 TTL 清理</small></div></section><section className="panel settings-card"><div className="panel-heading"><div><h2>存储说明</h2><small>按数据类型采用不同保留策略</small></div></div><div className="retention-row"><span>Trace / Span 明细</span><strong>30 天</strong></div><div className="retention-row"><span>聚合指标</span><strong>90 天</strong></div><div className="retention-row"><span>告警事件</span><strong>180 天</strong></div></section></div>}
    {tab === 'access' && <div className="settings-content-grid"><section className="panel settings-card credentials-card"><div className="panel-heading"><div><h2>项目接入凭证</h2><small>使用项目密钥鉴权上报请求；密钥不会在页面完整展示</small></div><button className="button secondary" type="button" onClick={() => onNotify('新密钥已生成，旧密钥将在 24 小时后失效（演示）')}>轮换密钥</button></div><div className="credential-label">PROJECT KEY <span>仅创建时展示一次</span></div><div className="credential-value"><code>trc_live_•••••••••••••••••••••9f2a</code><button type="button" className="text-action" onClick={() => onNotify('项目密钥已复制')}>复制</button></div><div className="credential-label">Trace Header</div><pre className="code-sample">x-trace-id: trace_web_8f2a9c13d7e1<br />x-project-key: trc_live_••••••••</pre><p className="settings-callout">服务端密钥请使用环境变量注入，不要提交到源代码仓库或前端 Bundle。</p></section><section className="panel settings-card"><div className="panel-heading"><div><h2>数据接入端点</h2><small>本地开发环境</small></div></div><div className="endpoint-row"><span>Span ingest</span><code>http://localhost:3000/v1/spans</code><StatusPill status="muted">待启动</StatusPill></div><div className="endpoint-row"><span>Trace query</span><code>http://localhost:3000/v1/traces</code><StatusPill status="muted">待启动</StatusPill></div></section></div>}
  </section>;
}

function SettingToggle({ title, description, value, onChange }: { title: string; description: string; value: boolean; onChange: (value: boolean) => void }) {
  return <div className="setting-item"><div><strong>{title}</strong><p>{description}</p></div><button type="button" role="switch" aria-checked={value} className={`toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)}><i /></button></div>;
}

export function DocsPage({ onNotify }: { onNotify: (message: string) => void }) {
  const [language, setLanguage] = useState<'node' | 'browser'>('node');
  const code = language === 'node'
    ? `import { TraceRecorder } from '@trace-ops/sdk';\n\nconst recorder = new TraceRecorder({\n  endpoint: process.env.TRACE_OPS_ENDPOINT,\n  projectKey: process.env.TRACE_OPS_PROJECT_KEY,\n  service: 'customer-api',\n});\n\n// 接收前端 x-trace-id，没有则由服务端生成\nconst traceId = req.headers['x-trace-id'] ?? recorder.createTraceId();\nconst root = recorder.start('http.server', traceId);\n\nconst rag = recorder.start('rag.retrieve', traceId, root.id);\nrag.set('topK', 5).set('sources', sourceIds);\nawait rag.end();\n\nconst llm = recorder.start('llm.generate', traceId, root.id);\nllm.set('model', 'gpt-4o').setUsage(inputTokens, outputTokens);\nawait llm.end();\nawait root.end();`
    : `import { createTraceId } from '@trace-ops/web-sdk';\n\nconst traceId = createTraceId();\n\nawait fetch('/api/chat', {\n  method: 'POST',\n  headers: {\n    'content-type': 'application/json',\n    'x-trace-id': traceId,\n  },\n  body: JSON.stringify({ question }),\n});\n\n// 页面异常与 Web Vitals 可按项目策略启用\n// Prompt / Response 原文默认不会采集`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); } catch { /* Clipboard is unavailable on non-secure local origins. */ }
    onNotify('接入示例已复制（演示）');
  };
  return <section className="module-page docs-page">
    <PageIntro eyebrow="QUICKSTART / 4 MIN READ" title="先接入第一条 Trace。" description="统一传递 x-trace-id，平台即可把 Web、服务端、RAG 与模型调用串成完整执行树。" actions={<button className="button primary" type="button" onClick={() => void copy()}><Icon name="copy" size={15} />复制示例</button>} />
    <div className="docs-steps"><div className="docs-step"><span>01</span><div><strong>创建项目与服务</strong><small>在项目设置中查看项目密钥并配置环境变量。</small></div></div><div className="docs-step"><span>02</span><div><strong>传递 Trace ID</strong><small>浏览器生成 ID，通过 x-trace-id 请求头传入 API。</small></div></div><div className="docs-step"><span>03</span><div><strong>为关键步骤添加 Span</strong><small>给 RAG、LLM、Tool 调用分别记录父子 Span 与属性。</small></div></div></div>
    <section className="panel docs-code-panel"><div className="panel-heading"><div><h2>快速接入 · TypeScript</h2><small>Node.js / NestJS / 浏览器</small></div><span className="sdk-badge">SDK 示例</span></div><div className="code-toolbar"><div className="span-tabs">{([{ id: 'node', label: '服务端' }, { id: 'browser', label: '浏览器' }] as const).map((item) => <button key={item.id} type="button" className={`span-tab ${language === item.id ? 'active' : ''}`} onClick={() => setLanguage(item.id)}>{item.label}</button>)}</div><button className="text-action" type="button" onClick={() => void copy()}><Icon name="copy" size={14} />复制代码</button></div><pre className="docs-code"><code>{code}</code></pre><div className="docs-security-note"><span className="note-mark">i</span><span>接入密钥只放在服务端环境变量。不要在前端暴露项目密钥；Prompt / Response 原文采集默认关闭。</span></div></section>
    <section className="docs-next"><div><span className="eyebrow">DATA FLOW</span><strong>TraceRecorder → Kafka → Collector → ClickHouse</strong><small>异步投递与存储服务启动后，可在 Trace 检索页查询上报数据。</small></div><button className="button secondary" type="button" onClick={() => onNotify('后端数据链路尚未启动，当前展示 mock 数据')}>查看数据流 <Icon name="arrow" size={14} /></button></section>
  </section>;
}
