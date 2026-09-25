import type { ReactNode } from 'react';

export type IconName = 'overview' | 'traces' | 'ai' | 'alerts' | 'settings' | 'docs' | 'external' | 'chevron' | 'arrow' | 'copy' | 'search' | 'download' | 'plus' | 'check' | 'close' | 'clock' | 'filter';

const iconPaths: Record<IconName, ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  traces: <><circle cx="5" cy="5" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="12" cy="19" r="2" /><path d="M7 5h7a5 5 0 0 1 5 5M12 17v-4a5 5 0 0 0-5-5H5" /></>,
  ai: <><path d="M4 7h6M14 7h6M7 4v6M17 4v6M7 14v6M17 14v6M4 17h6M14 17h6" /><circle cx="12" cy="12" r="2" /></>,
  alerts: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="m19 13 2 1-2 4-2-1a8 8 0 0 1-2 1l-.5 2h-4L10 18a8 8 0 0 1-2-1l-2 1-2-4 2-1v-2l-2-1 2-4 2 1a8 8 0 0 1 2-1l.5-2h4L15 6a8 8 0 0 1 2 1l2-1 2 4-2 1z" transform="translate(-1 -1)" /></>,
  docs: <><path d="M5 3.5h9l5 5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" /><path d="M14 4v5h5M8 13h8M8 17h8" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></>,
  chevron: <path d="m7 10 5 5 5-5" />,
  arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 20h16" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  filter: <><path d="M4 6h16M7 12h10m-7 6h4" /></>,
};

export function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconPaths[name]}</svg>;
}

export function PanelHeading({ title, action, onAction, aside }: { title: string; action?: string; onAction?: () => void; aside?: ReactNode }) {
  return <div className="panel-heading"><h2>{title}</h2>{aside}{action && <button className="text-action" type="button" onClick={onAction}>{action}<Icon name="arrow" size={14} /></button>}</div>;
}

export function PageIntro({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="module-intro page-intro"><div className="intro-copy"><span>{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</div>;
}

export function StatusPill({ status, children }: { status: 'ok' | 'error' | 'warning' | 'info' | 'muted'; children: ReactNode }) {
  return <span className={`status-pill ${status}`}><i />{children}</span>;
}

