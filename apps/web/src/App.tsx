import { useEffect, useState } from 'react';
import { mockTraces } from './mock/data';
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
import { AiChainPage, AlertsPage, DocsPage, OverviewPage, SettingsPage, TraceDetail, TraceExplorer } from './pages/Pages';

type PageName = 'overview' | 'traces' | 'ai' | 'alerts' | 'settings' | 'docs';
type ProjectState =
  | { status: 'loading' }
  | { status: 'ready'; projects: ProjectOption[] }
  | { status: 'error'; message: string };
type OverviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: OverviewResponse }
  | { status: 'error'; message: string };
type OverviewPageStatus = 'loading-projects' | 'project-error' | 'no-projects' | 'loading' | 'error' | 'ready';

const navigation: { id: PageName; label: string; icon: IconName; count?: number }[] = [
  { id: 'overview', label: '总览', icon: 'overview' },
  { id: 'traces', label: 'Traces', icon: 'traces' },
  { id: 'ai', label: 'AI 链路', icon: 'ai' },
  { id: 'alerts', label: '告警中心', icon: 'alerts', count: 5 },
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

export default function App() {
  const [page, setPage] = useState<PageName>('overview');
  const [environment, setEnvironment] = useState<OverviewEnvironment>('prod');
  const [timeRange, setTimeRange] = useState<OverviewRange>('24h');
  const [projectId, setProjectId] = useState('');
  const [projectRetry, setProjectRetry] = useState(0);
  const [overviewRetry, setOverviewRetry] = useState(0);
  const [projectState, setProjectState] = useState<ProjectState>({ status: 'loading' });
  const [overviewState, setOverviewState] = useState<OverviewState>({ status: 'idle' });
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const selectedTrace = mockTraces.find((trace) => trace.id === selectedTraceId);
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

  useEffect(() => {
    if (projectState.status !== 'ready' || !projectState.projects.some((project) => project.id === projectId)) {
      setOverviewState({ status: 'idle' });
      return undefined;
    }

    const controller = new AbortController();
    setOverviewState({ status: 'loading' });
    fetchOverview({ projectId, environment, range: timeRange }, controller.signal).then((data) => {
      if (!controller.signal.aborted) setOverviewState({ status: 'ready', data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setOverviewState({ status: 'error', message: overviewErrorMessage(error) });
    });
    return () => controller.abort();
  }, [projectState, projectId, environment, timeRange, overviewRetry]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const overviewPageStatus: OverviewPageStatus = projectState.status === 'loading'
    ? 'loading-projects'
    : projectState.status === 'error'
      ? 'project-error'
      : projectState.projects.length === 0
        ? 'no-projects'
        : !selectedProject || overviewState.status === 'idle'
          ? 'loading'
          : overviewState.status;
  const overviewData = overviewState.status === 'ready' ? overviewState.data : undefined;
  const overviewError = projectState.status === 'error'
    ? projectState.message
    : overviewState.status === 'error' ? overviewState.message : undefined;
  const overviewHasNoSamples = overviewPageStatus === 'ready' && overviewData !== undefined && !hasOverviewData(overviewData);
  const updatedLabel = overviewPageStatus === 'ready' && overviewData
    ? `数据更新于 ${formatGeneratedAt(overviewData.generatedAt)}`
    : overviewPageStatus === 'error' || overviewPageStatus === 'project-error'
      ? '接口暂不可用'
      : overviewPageStatus === 'no-projects' ? '暂无可用项目' : '正在读取接口数据';

  const notify = (message: string) => setToast(message);
  const openTrace = (id: string) => {
    setSelectedTraceId(id);
    setPage('traces');
  };
  const navigate = (nextPage: PageName) => {
    setPage(nextPage);
    setSelectedTraceId(null);
  };
  const retryProjects = () => setProjectRetry((count) => count + 1);
  const retryOverview = () => {
    if (overviewPageStatus === 'project-error' || overviewPageStatus === 'no-projects') retryProjects();
    else setOverviewRetry((count) => count + 1);
  };
  const projectPlaceholder = projectState.status === 'loading'
    ? '正在加载项目…'
    : projectState.status === 'error' ? '项目列表加载失败'
      : projectState.projects.length === 0 ? '暂无可用项目' : '选择项目';
  const sourceLabel = page !== 'overview'
    ? '演示数据'
    : overviewPageStatus === 'ready' ? 'API 数据'
      : overviewPageStatus === 'error' || overviewPageStatus === 'project-error' ? 'API 暂不可用'
        : 'API 读取中';
  const mockEnvironment = environment === 'prod' ? 'production' : environment === 'dev' ? 'development' : environment;

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" type="button" onClick={() => navigate('overview')} aria-label="Trace Ops 首页">TRACE <span>OPS</span></button>
      <div className="project-switcher" aria-label="当前项目">
        <span><strong>{selectedProject?.name ?? projectPlaceholder}</strong><small>{selectedProject?.slug ?? '项目 · API 管理'}</small></span>
        <Icon name="chevron" size={15} />
      </div>
      <nav className="main-nav" aria-label="主导航">
        {navigation.slice(0, 4).map((item) => <button key={item.id} type="button" className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)} aria-label={item.label} title={item.label} aria-current={page === item.id ? 'page' : undefined}><Icon name={item.icon} /><span>{item.label}</span>{item.count && <small>{item.count}</small>}</button>)}
        <div className="nav-divider" />
        {navigation.slice(4).map((item) => <button key={item.id} type="button" className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)} aria-label={item.label} title={item.label} aria-current={page === item.id ? 'page' : undefined}><Icon name={item.icon} /><span>{item.label}</span></button>)}
      </nav>
      <div className="sidebar-foot"><span><i className="connection-dot" />{page === 'overview' ? '接口监控' : '演示数据'}</span><span className="version">v0.1.0</span></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div className="breadcrumb"><span>{selectedProject?.name ?? 'Trace Ops'}</span><i>/</i><strong>{pageTitles[page]}</strong></div><div className="top-actions"><span className={`demo-label ${page === 'overview' ? 'api-data-label' : ''} ${overviewPageStatus === 'error' || overviewPageStatus === 'project-error' ? 'source-error' : ''}`}><i />{sourceLabel}</span><button type="button" onClick={() => notify('Trace Ops · AI 全链路监控')}>关于</button><button type="button" onClick={() => navigate('docs')}>文档 <Icon name="external" size={13} /></button><span className="avatar" aria-label="用户 Z">Z</span></div></header>
      <div className="global-context-bar">
        <div className="project-context"><span className="context-caption">项目</span><strong>{selectedProject?.name ?? projectPlaceholder}</strong><span className="context-separator">/</span><span className="context-caption">全链路运行数据</span></div>
        <div className="global-filters">
          <div className="project-filter">
            <label className="context-select"><span>项目</span><select value={selectedProject?.id ?? ''} disabled={projectState.status !== 'ready' || projectState.projects.length === 0} onChange={(event) => setProjectId(event.target.value)} aria-label="选择项目">
              {!selectedProject && <option value="">{projectPlaceholder}</option>}
              {projectState.status === 'ready' && projectState.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select><Icon name="chevron" size={13} /></label>
            {(projectState.status === 'error' || (projectState.status === 'ready' && projectState.projects.length === 0)) && <button className="context-retry" type="button" onClick={retryProjects}>重试</button>}
          </div>
          <label className="context-select"><span>环境</span><select value={environment} onChange={(event) => setEnvironment(event.target.value as OverviewEnvironment)} aria-label="选择环境"><option value="prod">production</option><option value="staging">staging</option><option value="dev">development</option><option value="all">全部环境</option></select><Icon name="chevron" size={13} /></label>
          <label className="context-select"><span>时间范围</span><select value={timeRange} onChange={(event) => setTimeRange(event.target.value as OverviewRange)} aria-label="选择时间范围"><option value="1h">最近 1 小时</option><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option></select><Icon name="chevron" size={13} /></label>
        </div>
      </div>
      <div className="page-root">
        {page === 'overview' && <><section className="page-heading"><div><span className="page-eyebrow">OBSERVABILITY / OVERVIEW</span><h1>运行概况</h1><p>按项目、环境与时间范围查看 AI 应用的真实运行数据。</p></div><span className="last-updated"><Icon name="clock" size={14} />{updatedLabel}</span></section><OverviewPage
          status={overviewPageStatus}
          errorMessage={overviewError}
          data={overviewData}
          environment={environment}
          range={timeRange}
          empty={overviewHasNoSamples}
          onRetry={retryOverview}
          onSelectTrace={openTrace}
        /></>}
        {page === 'traces' && (selectedTrace ? <TraceDetail key={selectedTrace.id} trace={selectedTrace} onBack={() => setSelectedTraceId(null)} onNotify={notify} /> : <TraceExplorer environment={environment === 'all' ? 'all' : mockEnvironment} onSelectTrace={openTrace} onNotify={notify} />)}
        {page === 'ai' && <AiChainPage onSelectTrace={openTrace} onNotify={notify} />}
        {page === 'alerts' && <AlertsPage environment={environment === 'all' ? 'all' : mockEnvironment} onSelectTrace={openTrace} onNotify={notify} />}
        {page === 'settings' && <SettingsPage onNotify={notify} />}
        {page === 'docs' && <DocsPage onNotify={notify} />}
        <footer className="page-footer"><span>TRACE OPS <i>·</i> AI 全链路监控</span><span>{getRangeLabel(timeRange)} <i>·</i> {page === 'overview' ? '接口数据' : '演示数据'}</span></footer>
      </div>
    </main>
    {toast && <div className="toast-message" role="status"><span className="toast-check"><Icon name="check" size={14} /></span>{toast}</div>}
  </div>;
}
