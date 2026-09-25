import { useEffect, useState } from 'react';
import { mockTraces } from './mock/data';
import { Icon, type IconName } from './components/ui';
import { toProtocolEnvironment } from './api';
import { AiChainPage, AlertsPage, DocsPage, OverviewPage, SettingsPage, TraceDetail, TraceExplorer } from './pages/Pages';

type PageName = 'overview' | 'traces' | 'ai' | 'alerts' | 'settings' | 'docs';

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

export default function App() {
  const [page, setPage] = useState<PageName>('overview');
  const [environment, setEnvironment] = useState<'dev' | 'staging' | 'prod' | 'all'>('prod');
  const [timeRange, setTimeRange] = useState('24h');
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const selectedTrace = mockTraces.find((trace) => trace.id === selectedTraceId);
  const mockEnvironment = environment === 'prod' ? 'production' : environment === 'dev' ? 'development' : environment;

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const notify = (message: string) => setToast(message);
  const openTrace = (id: string) => {
    setSelectedTraceId(id);
    setPage('traces');
  };
  const navigate = (nextPage: PageName) => {
    setPage(nextPage);
    if (nextPage !== 'traces') setSelectedTraceId(null);
    else setSelectedTraceId(null);
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" type="button" onClick={() => navigate('overview')} aria-label="Trace Ops 首页">TRACE <span>OPS</span></button>
      <div className="project-switcher"><span><strong>客服智能体</strong><small>项目 · customer-assistant</small></span><Icon name="chevron" size={15} /></div>
      <nav className="main-nav" aria-label="主导航">
        {navigation.slice(0, 4).map((item) => <button key={item.id} type="button" className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)} aria-label={item.label} title={item.label} aria-current={page === item.id ? 'page' : undefined}><Icon name={item.icon} /><span>{item.label}</span>{item.count && <small>{item.count}</small>}</button>)}
        <div className="nav-divider" />
        {navigation.slice(4).map((item) => <button key={item.id} type="button" className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)} aria-label={item.label} title={item.label} aria-current={page === item.id ? 'page' : undefined}><Icon name={item.icon} /><span>{item.label}</span></button>)}
      </nav>
      <div className="sidebar-foot"><span><i className="connection-dot" />本地演示</span><span className="version">v0.1.0</span></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div className="breadcrumb"><span>客服智能体</span><i>/</i><strong>{pageTitles[page]}</strong></div><div className="top-actions"><span className="demo-label"><i />演示数据</span><button type="button" onClick={() => notify('Trace Ops · AI 全链路监控演示')}>关于</button><button type="button" onClick={() => navigate('docs')}>文档 <Icon name="external" size={13} /></button><span className="avatar" aria-label="用户 Z">Z</span></div></header>
      <div className="global-context-bar"><div className="project-context"><span className="context-caption">项目</span><strong>客服智能体</strong><span className="context-separator">/</span><span className="context-caption">数据范围</span></div><div className="global-filters"><label className="context-select"><span>环境</span><select value={environment} onChange={(event) => setEnvironment(event.target.value === 'all' ? 'all' : toProtocolEnvironment(event.target.value))} aria-label="选择环境"><option value="prod">production</option><option value="staging">staging</option><option value="dev">development</option><option value="all">全部环境</option></select><Icon name="chevron" size={13} /></label><label className="context-select"><span>时间范围</span><select value={timeRange} onChange={(event) => setTimeRange(event.target.value)} aria-label="选择时间范围"><option value="1h">最近 1 小时</option><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option></select><Icon name="chevron" size={13} /></label></div></div>
      <div className="page-root">
        {page === 'overview' && <><section className="page-heading"><div><span className="page-eyebrow">OBSERVABILITY / OVERVIEW</span><h1>运行概况</h1><p>实时掌握 AI 应用的运行状态、性能表现与潜在问题。</p></div><span className="last-updated"><Icon name="clock" size={14} />数据更新于刚刚</span></section><OverviewPage onNavigate={navigate} onSelectTrace={openTrace} environment={environment === 'all' ? '全部环境' : mockEnvironment} /></>}
        {page === 'traces' && (selectedTrace ? <TraceDetail key={selectedTrace.id} trace={selectedTrace} onBack={() => setSelectedTraceId(null)} onNotify={notify} /> : <TraceExplorer environment={environment === 'all' ? 'all' : mockEnvironment} onSelectTrace={openTrace} onNotify={notify} />)}
        {page === 'ai' && <AiChainPage onSelectTrace={openTrace} onNotify={notify} />}
        {page === 'alerts' && <AlertsPage environment={environment === 'all' ? 'all' : mockEnvironment} onSelectTrace={openTrace} onNotify={notify} />}
        {page === 'settings' && <SettingsPage onNotify={notify} />}
        {page === 'docs' && <DocsPage onNotify={notify} />}
        <footer className="page-footer"><span>TRACE OPS <i>·</i> AI 全链路监控</span><span>{timeRange === '1h' ? '最近 1 小时' : timeRange === '7d' ? '最近 7 天' : '最近 24 小时'} <i>·</i> 演示数据</span></footer>
      </div>
    </main>
    {toast && <div className="toast-message" role="status"><span className="toast-check"><Icon name="check" size={14} /></span>{toast}</div>}
  </div>;
}
