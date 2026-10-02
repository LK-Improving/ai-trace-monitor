import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './components/ui';
import {
  fetchOverview,
  fetchProjects,
  hasOverviewData,
  overviewErrorMessage,
  type OverviewEnvironment,
  type OverviewRange,
  type OverviewResponse,
  type ProjectOption,
} from './overview-api';
import { createTimeWindow, fetchTraceList, type TraceListResponse } from './chain-api';
import { AiChainPage, TraceDetail, TraceExplorer, type TraceSelection } from './pages/LivePages';
import { AlertsPage, DocsPage, OverviewPage, SettingsPage } from './pages/Pages';

type PageName = 'overview' | 'traces' | 'ai' | 'alerts' | 'settings' | 'docs';
type ProjectState =
  | { status: 'loading' }
  | { status: 'ready'; projects: ProjectOption[] }
  | { status: 'error'; message: string };
type OverviewState =
  | { scopeKey: string; status: 'loading' }
  | { scopeKey: string; status: 'ready'; data: OverviewResponse; traces: TraceListResponse }
  | { scopeKey: string; status: 'error'; message: string };
type OverviewPageStatus = 'loading-projects' | 'project-error' | 'no-projects' | 'loading' | 'error' | 'ready';

const navigation: { id: PageName; label: string; icon: IconName }[] = [
  { id: 'overview', label: '总览', icon: 'overview' },
  { id: 'traces', label: 'Trace 检索', icon: 'traces' },
  { id: 'ai', label: 'AI 链路', icon: 'ai' },
  { id: 'alerts', label: '告警中心', icon: 'alerts' },
  { id: 'settings', label: '项目设置', icon: 'settings' },
  { id: 'docs', label: '接入文档', icon: 'docs' },
];

const pageTitles: Record<PageName, string> = {
  overview: '运行概况',
  traces: 'Trace 检索',
  ai: 'AI 链路',
  alerts: '告警中心',
  settings: '项目设置',
  docs: '接入文档',
};

function getRangeLabel(range: OverviewRange): string {
  if (range === '1h') return '最近 1 小时';
  if (range === '7d') return '最近 7 天';
  return '最近 24 小时';
}

function formatGeneratedAt(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(new Date(value));
}

function isApiPage(page: PageName): boolean {
  return page === 'overview' || page === 'traces' || page === 'ai';
}

function ProjectGate({ state, onRetry }: { state: ProjectState; onRetry: () => void }) {
  const message = state.status === 'loading'
    ? '正在加载项目列表…'
    : state.status === 'error'
      ? state.message
      : state.projects.length === 0
        ? '当前没有可用项目，请先配置项目后再查看监控数据。'
        : '正在确认当前项目…';
  const canRetry = state.status === 'error' || (state.status === 'ready' && state.projects.length === 0);
  const isError = state.status === 'error';
  return <section className="module-page"><div className={`overview-status ${isError ? 'error' : 'info'}`} role={isError ? 'alert' : 'status'} aria-live="polite">
    <span>{message}</span>{canRetry && <button className="text-action" type="button" onClick={onRetry}>重试<Icon name="arrow" size={14} /></button>}
  </div></section>;
}

export default function App() {
  const [page, setPage] = useState<PageName>('overview');
  const [environment, setEnvironment] = useState<OverviewEnvironment>('prod');
  const [timeRange, setTimeRange] = useState<OverviewRange>('24h');
  const [projectId, setProjectId] = useState('');
  const [projectRetry, setProjectRetry] = useState(0);
  const [overviewRetry, setOverviewRetry] = useState(0);
  const [projectState, setProjectState] = useState<ProjectState>({ status: 'loading' });
  const [overviewState, setOverviewState] = useState<OverviewState>({ scopeKey: '', status: 'loading' });
  const [selectedTrace, setSelectedTrace] = useState<TraceSelection | null>(null);
  const [toast, setToast] = useState('');
  const selectedProject = projectState.status === 'ready'
    ? projectState.projects.find((project) => project.id === projectId)
    : undefined;

  useEffect(() => {
    const controller = new AbortController();
    setProjectState({ status: 'loading' });
    fetchProjects(controller.signal).then((projects) => {
      if (controller.signal.aborted) return;
      setProjectState({ status: 'ready', projects });
      setProjectId((current) => projects.some((project) => project.id === current) ? current : projects[0]?.id ?? '');
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setProjectState({ status: 'error', message: overviewErrorMessage(error) });
    });
    return () => controller.abort();
  }, [projectRetry]);

  const overviewScopeKey = JSON.stringify([projectId, environment, timeRange]);
  const overviewScopeRef = useRef(overviewScopeKey);
  overviewScopeRef.current = overviewScopeKey;

  useEffect(() => {
    if (page !== 'overview') return undefined;
    if (projectState.status !== 'ready' || !projectState.projects.some((project) => project.id === projectId)) {
      setOverviewState({ scopeKey: overviewScopeKey, status: 'loading' });
      return undefined;
    }

    const controller = new AbortController();
    const requestScope = overviewScopeKey;
    const window = createTimeWindow(timeRange);
    setOverviewState({ scopeKey: requestScope, status: 'loading' });
    Promise.all([
      fetchOverview({ projectId, environment, range: timeRange }, controller.signal),
      fetchTraceList({ projectId, environment, range: timeRange, page: 1, pageSize: 5, window }, controller.signal),
    ]).then(([data, traces]) => {
      if (!controller.signal.aborted && overviewScopeRef.current === requestScope) {
        setOverviewState({ scopeKey: requestScope, status: 'ready', data, traces });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && overviewScopeRef.current === requestScope) {
        const message = error instanceof Error ? error.message : '读取总览数据失败，请稍后重试。';
        setOverviewState({ scopeKey: requestScope, status: 'error', message });
      }
    });
    return () => controller.abort();
  }, [page, projectState, projectId, environment, timeRange, overviewRetry, overviewScopeKey]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const currentOverview = overviewState.scopeKey === overviewScopeKey ? overviewState : { scopeKey: overviewScopeKey, status: 'loading' as const };
  const overviewPageStatus: OverviewPageStatus = projectState.status === 'loading'
    ? 'loading-projects'
    : projectState.status === 'error'
      ? 'project-error'
      : projectState.projects.length === 0
        ? 'no-projects'
        : currentOverview.status;
  const overviewData = currentOverview.status === 'ready' ? currentOverview.data : undefined;
  const latestTraces = currentOverview.status === 'ready' ? currentOverview.traces : undefined;
  const overviewError = projectState.status === 'error'
    ? projectState.message
    : currentOverview.status === 'error' ? currentOverview.message : undefined;
  const overviewHasNoSamples = overviewPageStatus === 'ready' && overviewData !== undefined && !hasOverviewData(overviewData);
  const updatedLabel = overviewPageStatus === 'ready' && overviewData
    ? `数据更新于 ${formatGeneratedAt(overviewData.generatedAt)}`
    : overviewPageStatus === 'error' || overviewPageStatus === 'project-error'
      ? '接口暂不可用'
      : overviewPageStatus === 'no-projects' ? '暂无可用项目' : '正在读取接口数据';

  const notify = (message: string) => setToast(message);
  const openTrace = (selection: TraceSelection) => {
    setSelectedTrace(selection);
    setPage('traces');
  };
  const navigate = (nextPage: PageName) => {
    setPage(nextPage);
    setSelectedTrace(null);
  };
  const changeProject = (nextProjectId: string) => {
    setSelectedTrace(null);
    setProjectId(nextProjectId);
  };
  const changeEnvironment = (nextEnvironment: OverviewEnvironment) => {
    setSelectedTrace(null);
    setEnvironment(nextEnvironment);
  };
  const changeRange = (nextRange: OverviewRange) => {
    setSelectedTrace(null);
    setTimeRange(nextRange);
  };
  const retryProjects = () => setProjectRetry((count) => count + 1);
  const retryOverview = () => {
    if (projectState.status === 'error' || (projectState.status === 'ready' && projectState.projects.length === 0)) retryProjects();
    else setOverviewRetry((count) => count + 1);
  };
  const projectPlaceholder = projectState.status === 'loading'
    ? '正在加载项目…'
    : projectState.status === 'error' ? '项目列表加载失败'
      : projectState.projects.length === 0 ? '暂无可用项目' : '选择项目';
  const sourceLabel = page === 'overview'
    ? projectState.status === 'error' || currentOverview.status === 'error' ? 'API 暂不可用'
      : projectState.status === 'ready' && projectState.projects.length === 0 ? '暂无可用项目'
        : currentOverview.status === 'ready' ? 'API 数据' : 'API 读取中'
    : isApiPage(page) ? 'API 查询' : '演示数据';
  const demoEnvironment = environment === 'prod' ? 'production' : environment === 'dev' ? 'development' : environment;
  const tracePageKey = JSON.stringify([projectId, environment, timeRange]);
  const selectedTraceKey = selectedTrace
    ? JSON.stringify([projectId, selectedTrace.traceId, selectedTrace.environment, selectedTrace.window.from, selectedTrace.window.to])
    : 'trace-list';

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" type="button" onClick={() => navigate('overview')} aria-label="Trace Ops 首页">TRACE <span>OPS</span></button>
      <div className="project-switcher" aria-label="当前项目">
        <span><strong>{selectedProject?.name ?? projectPlaceholder}</strong><small>{selectedProject?.slug ?? '项目 · API 管理'}</small></span>
        <Icon name="chevron" size={15} />
      </div>
      <nav className="main-nav" aria-label="主导航">
        {navigation.slice(0, 4).map((item) => <button key={item.id} type="button" className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)} aria-label={item.label} title={item.label} aria-current={page === item.id ? 'page' : undefined}><Icon name={item.icon} /><span>{item.label}</span></button>)}
        <div className="nav-divider" />
        {navigation.slice(4).map((item) => <button key={item.id} type="button" className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)} aria-label={item.label} title={item.label} aria-current={page === item.id ? 'page' : undefined}><Icon name={item.icon} /><span>{item.label}</span></button>)}
      </nav>
      <div className="sidebar-foot"><span><i className="connection-dot" />{isApiPage(page) ? '真实接口' : '演示页面'}</span><span className="version">v0.1.0</span></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div className="breadcrumb"><span>{selectedProject?.name ?? 'Trace Ops'}</span><i>/</i><strong>{pageTitles[page]}</strong></div><div className="top-actions"><span className={`demo-label ${page === 'overview' && sourceLabel === 'API 数据' ? 'api-data-label' : ''} ${page !== 'overview' && isApiPage(page) ? 'api-query-label' : ''} ${sourceLabel === 'API 暂不可用' ? 'source-error' : ''}`}><i />{sourceLabel}</span><button type="button" onClick={() => notify('Trace Ops · AI 全链路监控')}>关于</button><button type="button" onClick={() => navigate('docs')}>文档 <Icon name="external" size={13} /></button><span className="avatar" aria-label="用户 Z">Z</span></div></header>
      <div className="global-context-bar">
        <div className="project-context"><span className="context-caption">项目</span><strong>{selectedProject?.name ?? projectPlaceholder}</strong><span className="context-separator">/</span><span className="context-caption">全链路运行数据</span></div>
        <div className="global-filters">
          <div className="project-filter">
            <label className="context-select"><span>项目</span><select value={selectedProject?.id ?? ''} disabled={projectState.status !== 'ready' || projectState.projects.length === 0} onChange={(event) => changeProject(event.target.value)} aria-label="选择项目">
              {!selectedProject && <option value="">{projectPlaceholder}</option>}
              {projectState.status === 'ready' && projectState.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select><Icon name="chevron" size={13} /></label>
            {(projectState.status === 'error' || (projectState.status === 'ready' && projectState.projects.length === 0)) && <button className="context-retry" type="button" onClick={retryProjects}>重试</button>}
          </div>
          <label className="context-select"><span>环境</span><select value={environment} onChange={(event) => changeEnvironment(event.target.value as OverviewEnvironment)} aria-label="选择环境"><option value="prod">production</option><option value="staging">staging</option><option value="dev">development</option><option value="all">全部环境</option></select><Icon name="chevron" size={13} /></label>
          <label className="context-select"><span>时间范围</span><select value={timeRange} onChange={(event) => changeRange(event.target.value as OverviewRange)} aria-label="选择时间范围"><option value="1h">最近 1 小时</option><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option></select><Icon name="chevron" size={13} /></label>
        </div>
      </div>
      <div className="page-root">
        {page === 'overview' && <><section className="page-heading"><div><span className="page-eyebrow">OBSERVABILITY / OVERVIEW</span><h1>运行概况</h1><p>按项目、环境与时间范围查看 AI 应用的真实运行数据。</p></div><span className="last-updated"><Icon name="clock" size={14} />{updatedLabel}</span></section><OverviewPage
          status={overviewPageStatus}
          errorMessage={overviewError}
          data={overviewData}
          latestTraces={latestTraces}
          environment={environment}
          range={timeRange}
          empty={overviewHasNoSamples}
          onRetry={retryOverview}
          onSelectTrace={(traceId, traceEnvironment, window) => openTrace({ traceId, environment: traceEnvironment, window })}
        /></>}
        {page === 'traces' && (!selectedProject
          ? <ProjectGate state={projectState} onRetry={retryProjects} />
          : selectedTrace
            ? <TraceDetail key={selectedTraceKey} projectId={selectedProject.id} selection={selectedTrace} onBack={() => setSelectedTrace(null)} />
            : <TraceExplorer key={tracePageKey} projectId={selectedProject.id} environment={environment} range={timeRange} onSelectTrace={openTrace} />)}
        {page === 'ai' && (!selectedProject
          ? <ProjectGate state={projectState} onRetry={retryProjects} />
          : <AiChainPage key={`ai:${tracePageKey}`} projectId={selectedProject.id} environment={environment} range={timeRange} />)}
        {page === 'alerts' && <AlertsPage environment={environment === 'all' ? 'all' : demoEnvironment} onNotify={notify} />}
        {page === 'settings' && <SettingsPage onNotify={notify} />}
        {page === 'docs' && <DocsPage onNotify={notify} />}
        <footer className="page-footer"><span>TRACE OPS <i>·</i> AI 全链路监控</span><span>{getRangeLabel(timeRange)} <i>·</i> {isApiPage(page) ? '接口数据' : '演示数据'}</span></footer>
      </div>
    </main>
    {toast && <div className="toast-message" role="status"><span className="toast-check"><Icon name="check" size={14} /></span>{toast}</div>}
  </div>;
}
