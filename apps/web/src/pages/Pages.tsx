import { useEffect, useRef, useState } from 'react';
import { mockServices } from '../mock/data';
import { Icon, PageIntro, PanelHeading, StatusPill } from '../components/ui';
import type { OverviewEnvironment, OverviewRange, OverviewResponse, OverviewService, OverviewSeriesPoint } from '../overview-api';
import type { TraceListResponse, TraceEnvironment, TimeWindow } from '../chain-api';
import { getQuickstartSnippet } from '../quickstart';
import { AlertNotificationSettings } from './AlertNotificationSettings';
import {
  AlertApiError,
  fetchAlerts,
  fetchAlertSummary,
  updateAlertState,
  type AlertItem,
  type AlertLevel,
  type AlertLevelFilter,
  type AlertListResponse,
  type AlertState,
  type AlertStateFilter,
  type AlertSummary,
} from '../alerts-api';

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
  latestTraces,
  environment,
  range,
  empty,
  onRetry,
  onSelectTrace,
}: {
  status: 'loading-projects' | 'project-error' | 'no-projects' | 'loading' | 'error' | 'ready';
  errorMessage?: string;
  data?: OverviewResponse;
  latestTraces?: TraceListResponse;
  environment: OverviewEnvironment;
  range: OverviewRange;
  empty: boolean;
  onRetry: () => void;
  onSelectTrace: (id: string, environment: TraceEnvironment, window: TimeWindow) => void;
}) {
  const metric = status === 'ready' ? data?.metrics : undefined;
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
      <MetricCard label="P95 延迟" value={metric && metric.requestCount > 0 ? formatLatency(metric.p95LatencyMs) : '—'} detail={metric ? `环境：${getEnvironmentLabel(environment)}` : panelMessage} tone="green" />
      <MetricCard label="Token 消耗" value={metric ? formatTokens(metric.totalTokens) : '—'} detail={metric ? '输入与输出 Token 合计' : panelMessage} />
    </section>

    <section className="primary-grid">
      <article className="panel chart-panel"><div className="panel-heading chart-heading"><h2>请求与错误率</h2><div className="legend"><span><i className="legend-dot requests-dot" />请求量</span><span><i className="legend-dot errors-dot" />错误率</span></div></div><div className="chart-wrap">
        {status === 'ready' && data?.series.length ? <TrendChart series={data.series} range={range} /> : <OverviewMessage loading={status === 'loading' || status === 'loading-projects'}>{status === 'ready' ? '当前时间范围内暂无趋势数据' : panelMessage}</OverviewMessage>}
      </div></article>
      <article className="panel alerts-panel"><PanelHeading title="最近错误" aside={<span className="muted-caption">Overview 接口</span>} /><div className="recent-error-list">
        {status === 'ready' && data?.recentErrors.length ? data.recentErrors.slice(0, 5).map((error, index) => <article className="recent-error-row" key={`${error.traceId}-${error.startTime}-${error.service}-${error.operation}-${index}`}>
          <i className="severity-dot critical" />
          <span className="recent-error-copy"><strong>{error.service}</strong><small title={error.operation}>{error.operation}<i />{formatTimestamp(error.startTime, range)} · {error.environment}</small><button className="trace-id" type="button" aria-label={`查看 Trace ${error.traceId}（${error.environment}）`} onClick={() => onSelectTrace(error.traceId, error.environment, data.range)}>{error.traceId}</button></span>
          <span className="recent-error-duration">{formatLatency(error.durationMs)}</span>
        </article>) : <OverviewMessage loading={status === 'loading' || status === 'loading-projects'}>{status === 'ready' ? '此时间范围内暂无错误' : panelMessage}</OverviewMessage>}
      </div></article>
    </section>

    <section className="secondary-grid">
      <article className="panel table-panel"><PanelHeading title="服务状态" aside={status === 'ready' && data ? <span className="muted-caption">{data.services.length} 个服务 · API 数据</span> : undefined} /><div className="table-scroll"><table><thead><tr><th>服务</th><th>Span / 事件数</th><th>异常占比</th><th>P95</th><th>状态</th></tr></thead><tbody>
        {status === 'ready' && data?.services.length ? data.services.slice(0, 5).map((service) => {
          const state = serviceState(service);
          return <tr key={service.name}><td className="service-name">{service.name}<small className="service-last-seen">最近上报：{service.lastSeenAt ? formatTimestamp(service.lastSeenAt, range) : '—'}</small></td><td>{formatCount(service.requestCount)}</td><td>{formatPercent(service.errorRate)}</td><td>{service.requestCount > 0 ? formatLatency(service.p95LatencyMs) : '—'}</td><td><StatusPill status={state.tone}>{state.label}</StatusPill></td></tr>;
        }) : <tr><td colSpan={5} className="overview-table-empty">{status === 'ready' ? '暂无服务数据' : panelMessage}</td></tr>}
      </tbody></table></div><div className="table-caption">环境：{getEnvironmentLabel(environment)} <span>·</span> 数据来自当前筛选条件</div></article>
      <article className="panel table-panel traces-panel"><PanelHeading title="最新 Traces" aside={<span className="muted-caption">GET /traces · API</span>} /><div className="table-scroll"><table><thead><tr><th>Trace ID</th><th>入口操作</th><th>服务</th><th>耗时</th><th>状态</th><th>环境</th><th>时间</th></tr></thead><tbody>
        {status !== 'ready' ? <tr><td colSpan={7} className="overview-table-empty">{panelMessage}</td></tr>
          : latestTraces?.items.length ? latestTraces.items.map((trace) => <tr key={`${trace.environment}:${trace.traceId}`}><td><button className="trace-id" type="button" aria-label={`查看 Trace ${trace.traceId}（${trace.environment}）`} onClick={() => onSelectTrace(trace.traceId, trace.environment, latestTraces.range)}>{trace.traceId}</button></td><td>{trace.rootOperation}</td><td>{trace.services.join(', ') || '—'}</td><td>{formatLatency(trace.durationMs)}</td><td><StatusPill status={trace.status === 'error' ? 'error' : 'ok'}>{trace.status === 'error' ? '错误' : '成功'}</StatusPill></td><td><span className="env-tag">{trace.environment}</span></td><td>{formatTimestamp(trace.startedAt, range)}</td></tr>)
            : <tr><td colSpan={7} className="overview-table-empty">当前项目、环境与时间范围内没有已入库 Trace。</td></tr>}
      </tbody></table></div><div className="table-caption">按当前项目、环境和时间窗口从 Trace 查询接口读取</div></article>
    </section>
  </>;
}

const severityLabel: Record<AlertLevel, string> = { critical: '严重', warning: '警告', info: '提示' };
const stateLabel: Record<AlertState, string> = { active: '待确认', acknowledged: '已确认', resolved: '已关闭' };

type AlertLoadState<T> =
  | { scopeKey: string; status: 'loading' }
  | { scopeKey: string; status: 'error'; message: string }
  | { scopeKey: string; status: 'ready'; data: T };

const builtInAlertRules = [
  { rule: 'span_latency', title: '慢 Span', threshold: 'Span 耗时 > 2,000 ms' },
  { rule: 'llm_token_threshold', title: 'LLM 单次 Token', threshold: '单次 llm.generate 总 Token > 5,000；Token 是用量代理，不代表货币成本。' },
  { rule: 'rag_empty_recall', title: 'RAG 空召回', threshold: '成功的 rag.retrieve，且明确报告 0 条召回（recalled_count / retrievedCount / 空 sources）' },
  { rule: 'span_error', title: 'Span 错误', threshold: 'Span status = error 时逐条触发' },
] as const;

function alertTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function alertErrorMessage(error: unknown): string {
  return error instanceof AlertApiError ? error.message : '读取告警数据失败，请稍后重试。';
}

function AlertSummaryCard({ label, value, note, tone }: { label: string; value: string; note: string; tone?: 'critical' }) {
  return <article className={tone ? `alert-summary-card ${tone}` : 'alert-summary-card'}><span>{label}</span><strong>{value}<small> 条</small></strong><em>{note}</em></article>;
}

function alertAction(alert: AlertItem): { state: AlertState; label: string }[] {
  if (alert.state === 'active') return [{ state: 'acknowledged', label: '确认' }, { state: 'resolved', label: '关闭' }];
  if (alert.state === 'acknowledged') return [{ state: 'resolved', label: '关闭' }];
  return [{ state: 'active', label: '重新打开' }];
}

export function AlertsPage({
  projectId,
  environment,
  onNotify,
  onSelectTrace,
}: {
  projectId: string;
  environment: OverviewEnvironment;
  onNotify: (message: string) => void;
  onSelectTrace: (traceId: string, environment: TraceEnvironment, lastSeenAt: string) => void;
}) {
  const [stateFilter, setStateFilter] = useState<AlertStateFilter>('all');
  const [levelFilter, setLevelFilter] = useState<AlertLevelFilter>('all');
  const [page, setPage] = useState(1);
  const [listRetry, setListRetry] = useState(0);
  const [summaryRetry, setSummaryRetry] = useState(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [pendingAlertId, setPendingAlertId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [listState, setListState] = useState<AlertLoadState<AlertListResponse>>({ scopeKey: '', status: 'loading' });
  const [summaryState, setSummaryState] = useState<AlertLoadState<AlertSummary>>({ scopeKey: '', status: 'loading' });

  const listScopeKey = JSON.stringify([projectId, environment, stateFilter, levelFilter, page, listRetry, refreshVersion]);
  const summaryScopeKey = JSON.stringify([projectId, environment, summaryRetry, refreshVersion]);
  const listScopeRef = useRef(listScopeKey);
  const summaryScopeRef = useRef(summaryScopeKey);
  listScopeRef.current = listScopeKey;
  summaryScopeRef.current = summaryScopeKey;

  useEffect(() => {
    const controller = new AbortController();
    const scopeKey = listScopeKey;
    setListState({ scopeKey, status: 'loading' });
    fetchAlerts({ projectId, environment, state: stateFilter, level: levelFilter, page, pageSize: 20 }, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted && listScopeRef.current === scopeKey) setListState({ scopeKey, status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && listScopeRef.current === scopeKey) {
          setListState({ scopeKey, status: 'error', message: alertErrorMessage(error) });
        }
      });
    return () => controller.abort();
  }, [projectId, environment, stateFilter, levelFilter, page, listRetry, refreshVersion, listScopeKey]);

  useEffect(() => {
    const controller = new AbortController();
    const scopeKey = summaryScopeKey;
    setSummaryState({ scopeKey, status: 'loading' });
    fetchAlertSummary(projectId, environment, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted && summaryScopeRef.current === scopeKey) setSummaryState({ scopeKey, status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && summaryScopeRef.current === scopeKey) {
          setSummaryState({ scopeKey, status: 'error', message: alertErrorMessage(error) });
        }
      });
    return () => controller.abort();
  }, [projectId, environment, summaryRetry, refreshVersion, summaryScopeKey]);

  const visibleList: AlertLoadState<AlertListResponse> = listState.scopeKey === listScopeKey
    ? listState
    : { scopeKey: listScopeKey, status: 'loading' };
  const visibleSummary: AlertLoadState<AlertSummary> = summaryState.scopeKey === summaryScopeKey
    ? summaryState
    : { scopeKey: summaryScopeKey, status: 'loading' };
  const data = visibleList.status === 'ready' ? visibleList.data : undefined;
  const alerts = data?.items ?? [];
  const summary = visibleSummary.status === 'ready' ? visibleSummary.data : undefined;
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  useEffect(() => {
    if (data && page > pageCount) setPage(pageCount);
  }, [data, page, pageCount]);

  const changeFilters = (nextState: AlertStateFilter, nextLevel: AlertLevelFilter) => {
    setPage(1);
    setStateFilter(nextState);
    setLevelFilter(nextLevel);
  };

  const changeState = async (alert: AlertItem, nextState: AlertState) => {
    if (pendingAlertId) return;
    setPendingAlertId(alert.id);
    setActionError('');
    try {
      await updateAlertState(alert.id, nextState);
      setRefreshVersion((version) => version + 1);
      const action = nextState === 'acknowledged' ? '已确认' : nextState === 'resolved' ? '已关闭' : '已重新打开';
      onNotify(`告警已${action}，列表已同步。`);
    } catch (error) {
      setActionError(alertErrorMessage(error));
    } finally {
      setPendingAlertId(null);
    }
  };

  const emptyMessage = summary && summary.total > 0
    ? '当前状态和级别筛选下没有告警。'
    : '当前项目与环境范围内暂无告警。';

  return <section className="module-page alerts-page">
    <PageIntro eyebrow="ALERTS / INCIDENTS" title="把异常跟进到有结论。" description="查看服务端内置规则产生的告警，并从告警直接定位关联 Trace。列表和统计随当前项目与环境更新。" />

    {visibleSummary.status === 'error' && <div className="alert-load-error summary-error" role="alert"><span>{visibleSummary.message}</span><button className="text-action" type="button" onClick={() => setSummaryRetry((count) => count + 1)}>重试<Icon name="arrow" size={14} /></button></div>}
    <div className="alert-summary-grid" aria-busy={visibleSummary.status === 'loading'}>
      <AlertSummaryCard label="告警总数" value={summary ? formatCount(summary.total) : visibleSummary.status === 'loading' ? '…' : '—'} note="当前项目 / 环境" />
      <AlertSummaryCard label="待确认" value={summary ? formatCount(summary.active) : visibleSummary.status === 'loading' ? '…' : '—'} note="等待处理" />
      <AlertSummaryCard label="处理中" value={summary ? formatCount(summary.acknowledged) : visibleSummary.status === 'loading' ? '…' : '—'} note="已确认" />
      <AlertSummaryCard label="严重待确认" value={summary ? formatCount(summary.criticalActive) : visibleSummary.status === 'loading' ? '…' : '—'} note="优先跟进" tone="critical" />
      <AlertSummaryCard label="已关闭" value={summary ? formatCount(summary.resolved) : visibleSummary.status === 'loading' ? '…' : '—'} note="已完成处理" />
    </div>

    <section className="panel alert-rules-panel" aria-labelledby="alert-rules-title">
      <div className="panel-heading"><div><h2 id="alert-rules-title">本期内置规则与固定阈值</h2><small>规则与阈值固定、不可编辑；每条告警的 rule、title 和触发说明以 API 返回为准。</small></div><span className="rules-static-label">固定规则</span></div>
      <div className="alert-rule-grid">{builtInAlertRules.map((rule) => <article key={rule.rule}><code>{rule.rule}</code><strong>{rule.title}</strong><p>{rule.threshold}</p></article>)}</div>
      <p className="alert-rules-footnote">LLM Token 只作为成本代理指标；未配置模型价格，不代表货币金额。</p>
    </section>

    <section className="panel alert-table-panel" aria-label="告警列表">
      <div className="alert-toolbar">
        <div className="alert-filter-group">
          <label className="compact-filter"><span>状态</span><select value={stateFilter} onChange={(event) => changeFilters(event.target.value as AlertStateFilter, levelFilter)} aria-label="按告警状态筛选">
            <option value="all">全部状态</option><option value="active">待确认</option><option value="acknowledged">已确认</option><option value="resolved">已关闭</option>
          </select></label>
          <label className="compact-filter"><span>级别</span><select value={levelFilter} onChange={(event) => changeFilters(stateFilter, event.target.value as AlertLevelFilter)} aria-label="按告警级别筛选">
            <option value="all">全部级别</option><option value="critical">严重</option><option value="warning">警告</option><option value="info">提示</option>
          </select></label>
        </div>
        <span className="alert-scope-label">{environment === 'all' ? '全部环境' : environment} · 每页 20 条</span>
      </div>

      {actionError && <div className="alert-load-error alert-action-error" role="alert"><span>{actionError}</span></div>}
      <div className="table-scroll data-table-scroll alert-data-scroll"><table className="data-table alert-data-table"><thead><tr><th>级别</th><th>告警 / 触发说明</th><th>服务</th><th>环境</th><th>规则</th><th>关联 Trace</th><th>状态</th><th>最近发生</th><th>触发次数</th><th>操作</th></tr></thead><tbody>
        {visibleList.status === 'loading' && <tr><td colSpan={10} className="alert-table-state" role="status">正在读取当前项目与环境的告警…</td></tr>}
        {visibleList.status === 'error' && <tr><td colSpan={10} className="alert-table-state error" role="alert"><span>{visibleList.message}</span><button className="text-action" type="button" onClick={() => setListRetry((count) => count + 1)}>重试<Icon name="arrow" size={14} /></button></td></tr>}
        {visibleList.status === 'ready' && alerts.length === 0 && <tr><td colSpan={10} className="alert-table-state empty" role="status">{emptyMessage}</td></tr>}
        {visibleList.status === 'ready' && alerts.map((alert) => <tr key={alert.id}>
          <td><StatusPill status={alert.level === 'critical' ? 'error' : alert.level === 'warning' ? 'warning' : 'info'}>{severityLabel[alert.level]}</StatusPill></td>
          <td className="alert-description-cell"><strong>{alert.title}</strong><small>{alert.message}</small></td>
          <td>{alert.service}</td>
          <td><span className="env-tag">{alert.environment}</span></td>
          <td><code>{alert.rule}</code></td>
          <td><button className="trace-id" type="button" aria-label={`查看 Trace ${alert.traceId}（${alert.environment}）`} onClick={() => onSelectTrace(alert.traceId, alert.environment, alert.lastSeenAt)}>{alert.traceId.slice(0, 12)}…</button></td>
          <td><span className={`alert-state ${alert.state}`}>{stateLabel[alert.state]}</span></td>
          <td className="alert-seen-cell"><time dateTime={alert.lastSeenAt}>{alertTime(alert.lastSeenAt)}</time><small>首次 {alertTime(alert.firstSeenAt)}</small></td>
          <td className="alert-count-cell">{formatCount(alert.triggerCount)}</td>
          <td><div className="row-actions">{alertAction(alert).map((action) => <button key={action.state} type="button" disabled={pendingAlertId !== null} onClick={() => void changeState(alert, action.state)}>{pendingAlertId === alert.id ? '保存中…' : action.label}</button>)}</div></td>
        </tr>)}
      </tbody></table></div>

      <div className="alert-pagination"><span>{data && data.total > 0 ? `显示 ${(page - 1) * 20 + 1}–${Math.min(page * 20, data.total)} 条，共 ${formatCount(data.total)} 条` : data ? '0 条告警' : '列表数据待加载'}</span><div><button type="button" disabled={!data || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</button><span>第 {page} / {pageCount} 页</span><button type="button" disabled={!data || page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>下一页</button></div></div>
    </section>
  </section>;
}

type SettingsTab = 'project' | 'services' | 'privacy' | 'retention' | 'access' | 'notifications';
export function SettingsPage({ projectId, projectName: currentProjectName, environment, onNotify, onDataSourceChange }: {
  projectId: string;
  projectName: string;
  environment: OverviewEnvironment;
  onNotify: (message: string) => void;
  onDataSourceChange: (usesApi: boolean) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>('project');
  const [captureContent, setCaptureContent] = useState(false);
  const [webVitals, setWebVitals] = useState(true);
  const [errorAlerts, setErrorAlerts] = useState(true);
  const [projectName, setProjectName] = useState('客服智能体');
  const tabs: { id: SettingsTab; label: string }[] = [{ id: 'project', label: '项目概况' }, { id: 'services', label: '服务与环境' }, { id: 'privacy', label: '采集与脱敏' }, { id: 'retention', label: '数据保留' }, { id: 'access', label: '接入凭证' }, { id: 'notifications', label: '告警通知' }];
  return <section className="module-page settings-page">
    {tab !== 'notifications' && <PageIntro eyebrow="PROJECT / CONFIGURATION" title="项目边界与数据策略。" description="管理服务接入、环境、采集开关和数据保留周期。敏感数据默认不采集原文。" actions={<button className="button primary" type="button" onClick={() => onNotify('设置仅在当前页面演示，未写入后端。')}><Icon name="check" size={15} />保存修改</button>} />}
    <div className="settings-tabs" role="tablist" aria-label="项目设置分类">{tabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} type="button" onClick={() => { setTab(item.id); onDataSourceChange(item.id === 'notifications'); }}>{item.label}</button>)}</div>
    {tab === 'project' && <div className="settings-content-grid"><section className="panel settings-card"><div className="panel-heading"><div><h2>项目基本信息</h2><small>项目标识用于隔离各应用的 Trace 数据</small></div><span className="settings-status">ACTIVE</span></div><div className="form-grid"><label className="form-field">项目名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><label className="form-field">项目标识<input value="customer-assistant" readOnly /></label><label className="form-field">默认环境<select defaultValue="production"><option>production</option><option>staging</option><option>development</option></select></label><label className="form-field">项目时区<select defaultValue="Asia/Shanghai"><option>Asia/Shanghai</option><option>UTC</option></select></label></div><div className="panel-bottom-note">项目创建于 2026-09-12 · 所有指标均为演示数据</div></section><section className="panel settings-card"><div className="panel-heading"><div><h2>采集策略摘要</h2><small>服务级策略可在“服务与环境”中单独配置</small></div></div><div className="setting-list"><SettingToggle title="采集 Prompt / Response 原文" description="默认关闭，仅记录长度、Hash 与 Token 用量。" value={captureContent} onChange={setCaptureContent} /><SettingToggle title="采集前端性能指标" description="记录 LCP、INP、CLS、FCP 与 TTFB。" value={webVitals} onChange={setWebVitals} /><SettingToggle title="错误 Span 实时告警" description="当 Span 状态为 error 时触发严重级别告警。" value={errorAlerts} onChange={setErrorAlerts} /></div></section></div>}
    {tab === 'services' && <section className="panel settings-card"><div className="panel-heading"><div><h2>已接入服务</h2><small>共 {mockServices.length} 个服务 · 最近上报版本 SDK 0.1.0</small></div><button className="button secondary" type="button" onClick={() => onNotify('服务接入指引已准备好，请查看“接入文档”')}><Icon name="plus" size={15} />添加服务</button></div><div className="table-scroll data-table-scroll"><table className="data-table"><thead><tr><th>服务名称</th><th>环境</th><th>SDK 版本</th><th>最近上报</th><th>错误率</th><th>状态</th></tr></thead><tbody>{mockServices.map((service, index) => <tr key={service.name}><td className="service-name">{service.name}</td><td><span className="env-tag">{index === 3 ? 'staging' : 'production'}</span></td><td>0.1.0</td><td>{index === 2 ? '刚刚' : `${index + 1} 分钟前`}</td><td>{service.errors}</td><td><StatusPill status="ok">运行中</StatusPill></td></tr>)}</tbody></table></div></section>}
    {tab === 'privacy' && <div className="settings-content-grid"><section className="panel settings-card"><div className="panel-heading"><div><h2>内容采集与脱敏</h2><small>可在项目范围控制敏感字段采集</small></div><StatusPill status="ok">默认安全</StatusPill></div><div className="setting-list"><SettingToggle title="采集 Prompt / Response 原文" description="开启后可在 Trace 详情查看模型输入和输出；请确认符合数据合规要求。" value={captureContent} onChange={setCaptureContent} /><div className="setting-item"><div><strong>自动脱敏规则</strong><p>对邮箱、手机号和疑似密钥字段自动替换为掩码。</p></div><span className="policy-chip">已启用</span></div><div className="setting-item"><div><strong>用户标识采集</strong><p>仅采集不可逆 Hash，不保存原始用户 ID。</p></div><span className="policy-chip">Hash</span></div></div></section><section className="panel settings-card"><div className="panel-heading"><div><h2>默认过滤字段</h2><small>以下内容不会进入 Span attributes</small></div></div><div className="redaction-list"><code>authorization</code><code>cookie</code><code>password</code><code>email</code><code>phone</code><code>document.content</code></div><p className="settings-callout">Prompt / Response 原文默认不采集。启用前请确认项目数据边界和成员访问权限。</p></section></div>}
    {tab === 'retention' && <div className="settings-content-grid"><section className="panel settings-card"><div className="panel-heading"><div><h2>Trace 数据保留</h2><small>超过保留周期的数据由存储层自动清理</small></div></div><label className="form-field retention-select">保留天数<select defaultValue="30"><option value="7">7 天</option><option value="14">14 天</option><option value="30">30 天</option><option value="90">90 天</option></select></label><div className="retention-meter"><div><span>当前存储用量</span><strong>18.4 GB <small>/ 50 GB</small></strong></div><i><b style={{ width: '37%' }} /></i><small>演示估算 · ClickHouse 按日期分区与 TTL 清理</small></div></section><section className="panel settings-card"><div className="panel-heading"><div><h2>存储说明</h2><small>按数据类型采用不同保留策略</small></div></div><div className="retention-row"><span>Trace / Span 明细</span><strong>30 天</strong></div><div className="retention-row"><span>聚合指标</span><strong>90 天</strong></div><div className="retention-row"><span>告警事件</span><strong>180 天</strong></div></section></div>}
    {tab === 'access' && <div className="settings-content-grid"><section className="panel settings-card credentials-card"><div className="panel-heading"><div><h2>项目接入凭证</h2><small>服务端 ingest 在 JSON body 的 projectKey 字段使用项目密钥</small></div><button className="button secondary" type="button" onClick={() => onNotify('此演示页不执行密钥写入；项目密钥管理接口见 apps/api/README.md。')}>管理 API</button></div><div className="credential-label">PROJECT KEY <span>脱敏占位符，不可用于请求</span></div><div className="credential-value"><code>tr_••••••••</code></div><div className="credential-label">Trace ID Header <span>用于关联，不用于鉴权</span></div><pre className="code-sample">x-trace-id: trace_v1_example-123</pre><p className="settings-callout">真实密钥由受管理员保护的项目管理 API 创建，仅服务端持有；不得放入浏览器或 VITE_* 配置。服务和环境须先在项目中注册。</p></section><section className="panel settings-card"><div className="panel-heading"><div><h2>数据接入端点</h2><small>本地开发环境 · API 默认端口 3001</small></div></div><div className="endpoint-row"><span>Span ingest</span><code>http://localhost:3001/api/v1/spans</code><StatusPill status="muted">待启动</StatusPill></div><div className="endpoint-row"><span>Trace query</span><code>http://localhost:3001/api/v1/traces</code><StatusPill status="muted">待启动</StatusPill></div><p className="settings-callout">Trace 查询使用管理 API；项目管理方法与鉴权要求见 apps/api/README.md。</p></section></div>}
    {tab === 'notifications' && <AlertNotificationSettings projectId={projectId} projectName={currentProjectName} environment={environment} onNotify={onNotify} />}
  </section>;
}

function SettingToggle({ title, description, value, onChange }: { title: string; description: string; value: boolean; onChange: (value: boolean) => void }) {
  return <div className="setting-item"><div><strong>{title}</strong><p>{description}</p></div><button type="button" role="switch" aria-checked={value} className={`toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)}><i /></button></div>;
}

export function DocsPage({ onNotify }: { onNotify: (message: string) => void }) {
  const [language, setLanguage] = useState<'node' | 'browser'>('node');
  const code = getQuickstartSnippet(language);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(code);
      onNotify('接入示例已复制');
    } catch {
      onNotify('复制失败，请检查浏览器剪贴板权限。');
    }
  };
  return <section className="module-page docs-page">
    <PageIntro eyebrow="QUICKSTART / 4 MIN READ" title="先接入第一条 Trace。" description="统一传递 x-trace-id，并将服务端步骤作为 Span 上报，平台才能关联执行树；浏览器 ID 透传本身不会上报事件。" actions={<button className="button primary" type="button" onClick={() => void copy()}><Icon name="copy" size={15} />复制示例</button>} />
    <div className="docs-steps"><div className="docs-step"><span>01</span><div><strong>创建项目与服务</strong><small>按 apps/api/README.md「管理 API」创建项目、注册服务/环境并签发 spans:write 密钥。</small></div></div><div className="docs-step"><span>02</span><div><strong>传递 Trace ID</strong><small>浏览器生成 ID，通过 x-trace-id 请求头传给自己的服务端 API；这一步只做关联。</small></div></div><div className="docs-step"><span>03</span><div><strong>上报服务端 Span</strong><small>用原生 fetch POST 到 /api/v1/spans；Span 的 service 与批次 environment 必须已注册。</small></div></div></div>
    <section className="panel docs-code-panel"><div className="panel-heading"><div><h2>快速接入 · HTTP</h2><small>Node.js 18+ 原生 fetch / 浏览器 ID 透传</small></div><span className="sdk-badge">HTTP 示例</span></div><div className="code-toolbar"><div className="span-tabs">{([{ id: 'node', label: '服务端' }, { id: 'browser', label: '浏览器' }] as const).map((item) => <button key={item.id} type="button" className={`span-tab ${language === item.id ? 'active' : ''}`} onClick={() => setLanguage(item.id)}>{item.label}</button>)}</div><button className="text-action" type="button" onClick={() => void copy()}><Icon name="copy" size={14} />复制代码</button></div><pre className="docs-code"><code>{code}</code></pre><div className="docs-security-note"><span className="note-mark">i</span><span>服务端示例保存为 quickstart.mjs 后执行 node quickstart.mjs。先配置 TRACE_OPS_PROJECT_KEY、TRACE_OPS_SERVICE、TRACE_OPS_ENVIRONMENT，并注册对应服务/环境；TRACE_OPS_ENDPOINT 可选。projectKey 仅服务端持有，放在 ingest JSON body；浏览器只传 x-trace-id。HTTP 202 仅表示进入 API 内存队列。</span></div></section>
    <section className="docs-next"><div><span className="eyebrow">DATA FLOW</span><strong>POST /api/v1/spans → API 队列 → Kafka → Collector → ClickHouse</strong><small>Trace ID 负责关联；只有上报服务端 Span 后才会形成可查询链路。浏览器事件采集不属于本阶段。</small></div><button className="button secondary" type="button" onClick={() => onNotify('POST /api/v1/spans 的管理与接入契约见 apps/api/README.md；HTTP 202 仅表示进入 API 内存队列。')}>查看数据流 <Icon name="arrow" size={14} /></button></section>
  </section>;
}
