import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, StatusPill } from '../components/ui';
import {
  AlertNotificationApiError,
  createAlertChannel,
  deleteAlertChannel,
  fetchAlertChannels,
  fetchAlertDeliveries,
  patchAlertChannel,
  retryAlertDelivery,
  testAlertChannel,
  type AlertChannel,
  type AlertChannelEnvironment,
  type AlertChannelLevel,
  type AlertChannelType,
  type AlertDelivery,
  type AlertDeliveryListResponse,
  type AlertDeliveryStatusFilter,
} from '../alert-notifications-api';
import type { OverviewEnvironment } from '../overview-api';

type LoadState<T> =
  | { scopeKey: string; status: 'loading' }
  | { scopeKey: string; status: 'ready'; data: T }
  | { scopeKey: string; status: 'error'; message: string };
type View = 'channels' | 'deliveries';
type EditorMode = 'create' | 'edit';
type ChannelDraft = {
  name: string;
  type: AlertChannelType;
  environment: AlertChannelEnvironment;
  minLevel: AlertChannelLevel;
  enabled: boolean;
  destination: string;
};

const PAGE_SIZE = 20;
const EMPTY_DRAFT: ChannelDraft = {
  name: '',
  type: 'webhook',
  environment: 'all',
  minLevel: 'warning',
  enabled: true,
  destination: '',
};

const environmentLabel: Record<AlertChannelEnvironment, string> = {
  all: '全部环境',
  dev: 'development',
  staging: 'staging',
  prod: 'production',
};
const levelLabel: Record<AlertChannelLevel, string> = {
  info: '提示及以上',
  warning: '警告及以上',
  critical: '仅严重',
};
const deliveryStatusLabel: Record<AlertDelivery['status'], string> = {
  queued: '排队中',
  sending: '发送中',
  retrying: '等待重试',
  sent: '已送达',
  failed: '失败',
  canceled: '已取消',
};
const deliveryStatusTone: Record<AlertDelivery['status'], 'ok' | 'error' | 'warning' | 'muted' | 'info'> = {
  queued: 'info',
  sending: 'info',
  retrying: 'warning',
  sent: 'ok',
  failed: 'error',
  canceled: 'muted',
};

function errorMessage(error: unknown): string {
  if (error instanceof AlertNotificationApiError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return '';
  return '告警通知操作失败，请稍后重试。';
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(timestamp);
}

function deliveryEventLabel(delivery: AlertDelivery): string {
  return delivery.eventType === 'test' ? '测试投递' : '告警通知';
}

function channelTypeLabel(type: AlertChannelType): string {
  return type === 'webhook' ? 'Webhook' : 'Email';
}

export function AlertNotificationSettings({
  projectId,
  projectName,
  environment,
  onNotify,
}: {
  projectId: string;
  projectName: string;
  environment: OverviewEnvironment;
  onNotify: (message: string) => void;
}) {
  const [view, setView] = useState<View>('channels');
  const [deliveryStatus, setDeliveryStatus] = useState<AlertDeliveryStatusFilter>('all');
  const [page, setPage] = useState(1);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [channelRetry, setChannelRetry] = useState(0);
  const [deliveryRetryVersion, setDeliveryRetryVersion] = useState(0);
  const [deliveryRefreshVersion, setDeliveryRefreshVersion] = useState(0);
  const [channelState, setChannelState] = useState<LoadState<AlertChannel[]>>({ scopeKey: '', status: 'loading' });
  const [deliveryState, setDeliveryState] = useState<LoadState<AlertDeliveryListResponse>>({ scopeKey: '', status: 'loading' });
  const [editor, setEditor] = useState<{ mode: EditorMode; channel: AlertChannel | null } | null>(null);
  const [draft, setDraft] = useState<ChannelDraft>(EMPTY_DRAFT);
  const [deleteCandidate, setDeleteCandidate] = useState<AlertChannel | null>(null);
  const [busyAction, setBusyAction] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const channelScopeKey = JSON.stringify([projectId, environment]);
  const deliveryScopeKey = JSON.stringify([projectId, environment, deliveryStatus, page]);
  const channelScopeRef = useRef(channelScopeKey);
  const deliveryScopeRef = useRef(deliveryScopeKey);
  const mutationControllerRef = useRef<AbortController | null>(null);
  channelScopeRef.current = channelScopeKey;
  deliveryScopeRef.current = deliveryScopeKey;

  useEffect(() => {
    const controller = new AbortController();
    const scopeKey = channelScopeKey;
    setChannelState({ scopeKey, status: 'loading' });
    fetchAlertChannels(projectId, controller.signal).then((data) => {
      if (!controller.signal.aborted && channelScopeRef.current === scopeKey) setChannelState({ scopeKey, status: 'ready', data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && channelScopeRef.current === scopeKey) {
        setChannelState({ scopeKey, status: 'error', message: errorMessage(error) || '读取渠道失败，请重试。' });
      }
    });
    return () => controller.abort();
  }, [projectId, channelScopeKey, channelRetry, refreshVersion]);

  useEffect(() => {
    const controller = new AbortController();
    const scopeKey = deliveryScopeKey;
    setDeliveryState((current) => current.scopeKey === scopeKey && current.status === 'ready'
      ? current : { scopeKey, status: 'loading' });
    fetchAlertDeliveries({ projectId, status: deliveryStatus, page, pageSize: PAGE_SIZE }, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted && deliveryScopeRef.current === scopeKey) setDeliveryState({ scopeKey, status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && deliveryScopeRef.current === scopeKey) {
          setDeliveryState({ scopeKey, status: 'error', message: errorMessage(error) || '读取投递历史失败，请重试。' });
        }
      });
    return () => controller.abort();
  }, [projectId, deliveryStatus, page, deliveryScopeKey, deliveryRetryVersion, deliveryRefreshVersion, refreshVersion]);

  useEffect(() => {
    if (view !== 'deliveries') return;
    const timer = window.setInterval(() => setDeliveryRefreshVersion((version) => version + 1), 3000);
    return () => window.clearInterval(timer);
  }, [view]);

  useEffect(() => () => mutationControllerRef.current?.abort(), [channelScopeKey]);

  const visibleChannelState = channelState.scopeKey === channelScopeKey
    ? channelState : { scopeKey: channelScopeKey, status: 'loading' as const };
  const visibleDeliveryState = deliveryState.scopeKey === deliveryScopeKey
    ? deliveryState : { scopeKey: deliveryScopeKey, status: 'loading' as const };
  const channels = visibleChannelState.status === 'ready' ? visibleChannelState.data : [];
  const deliveries = visibleDeliveryState.status === 'ready' ? visibleDeliveryState.data : undefined;
  const pageCount = deliveries ? Math.max(1, Math.ceil(deliveries.total / deliveries.pageSize)) : 1;
  const currentEnvironmentLabel = environmentLabel[environment];
  const enabledChannelCount = useMemo(() => channels.filter((channel) => channel.enabled).length, [channels]);

  useEffect(() => {
    if (deliveries && page > pageCount) setPage(pageCount);
  }, [deliveries, page, pageCount]);

  async function performMutation(
    key: string,
    operation: (signal: AbortSignal) => Promise<void>,
    successMessage: string,
  ): Promise<boolean> {
    if (busyAction) return false;
    const scopeAtStart = channelScopeKey;
    const controller = new AbortController();
    mutationControllerRef.current?.abort();
    mutationControllerRef.current = controller;
    setBusyAction(key);
    setActionError('');
    setNotice('');
    try {
      await operation(controller.signal);
      if (controller.signal.aborted || channelScopeRef.current !== scopeAtStart) return false;
      setNotice(successMessage);
      setRefreshVersion((version) => version + 1);
      onNotify(successMessage);
      return true;
    } catch (error) {
      if (!controller.signal.aborted && channelScopeRef.current === scopeAtStart) setActionError(errorMessage(error));
      return false;
    } finally {
      if (channelScopeRef.current === scopeAtStart) setBusyAction('');
      if (mutationControllerRef.current === controller) mutationControllerRef.current = null;
    }
  }

  function openCreateDialog() {
    setActionError('');
    setDraft({ ...EMPTY_DRAFT });
    setEditor({ mode: 'create', channel: null });
  }

  function openEditDialog(channel: AlertChannel) {
    setActionError('');
    setDraft({
      name: channel.name,
      type: channel.type,
      environment: channel.environment,
      minLevel: channel.minLevel,
      enabled: channel.enabled,
      destination: '',
    });
    setEditor({ mode: 'edit', channel });
  }

  function closeEditor() {
    if (busyAction) return;
    setEditor(null);
    setDraft({ ...EMPTY_DRAFT });
  }

  async function saveChannel(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || busyAction) return;
    const submittedDraft = { ...draft };
    const destination = submittedDraft.destination.trim();
    setDraft((current) => ({ ...current, destination: '' }));
    const succeeded = editor.mode === 'create'
      ? await performMutation('save', (signal) => createAlertChannel(submittedDraft.type === 'webhook'
        ? {
          projectId,
          name: submittedDraft.name.trim(),
          type: 'webhook',
          environment: submittedDraft.environment,
          minLevel: submittedDraft.minLevel,
          enabled: submittedDraft.enabled,
          webhookUrl: destination,
        }
        : {
          projectId,
          name: submittedDraft.name.trim(),
          type: 'email',
          environment: submittedDraft.environment,
          minLevel: submittedDraft.minLevel,
          enabled: submittedDraft.enabled,
          recipient: destination,
        }, signal), '通知渠道已创建。')
      : await performMutation('save', (signal) => {
        const input = {
          projectId,
          name: submittedDraft.name.trim(),
          environment: submittedDraft.environment,
          minLevel: submittedDraft.minLevel,
          enabled: submittedDraft.enabled,
          ...(destination ? submittedDraft.type === 'webhook' ? { webhookUrl: destination } : { recipient: destination } : {}),
        };
        return patchAlertChannel(editor.channel!.id, input, signal);
      }, '通知渠道已保存。');
    if (succeeded) {
      setEditor(null);
      setDraft({ ...EMPTY_DRAFT });
    }
  }

  async function toggleChannel(channel: AlertChannel) {
    await performMutation(`toggle:${channel.id}`,
      (signal) => patchAlertChannel(channel.id, { projectId, enabled: !channel.enabled }, signal),
      channel.enabled ? '通知渠道已停用。' : '通知渠道已启用。');
  }

  async function sendTest(channel: AlertChannel) {
    await performMutation(`test:${channel.id}`,
      (signal) => testAlertChannel(channel.id, projectId, signal), '测试投递已提交。');
  }

  async function removeChannel() {
    if (!deleteCandidate) return;
    const candidate = deleteCandidate;
    const succeeded = await performMutation(`delete:${candidate.id}`,
      (signal) => deleteAlertChannel(candidate.id, projectId, signal), '通知渠道已删除。');
    if (succeeded) setDeleteCandidate(null);
  }

  async function retryDelivery(delivery: AlertDelivery) {
    await performMutation(`retry:${delivery.id}`,
      (signal) => retryAlertDelivery(delivery.id, projectId, signal), '失败投递已加入重试队列。');
  }

  function setDeliveryFilter(nextStatus: AlertDeliveryStatusFilter) {
    setPage(1);
    setDeliveryStatus(nextStatus);
  }

  return <section className="alert-notification-settings">
    <header className="notification-context-header">
      <div>
        <span className="eyebrow">PROJECT / ALERT DELIVERY</span>
        <h2>告警通知</h2>
        <p>管理当前项目的投递渠道，并观察告警和测试事件的送达情况。</p>
      </div>
      <div className="notification-context-meta">
        <span><small>当前项目</small><strong>{projectName}</strong></span>
        <span><small>当前环境</small><strong>{currentEnvironmentLabel}</strong></span>
      </div>
    </header>

    <div className="notification-overview-strip" aria-live="polite">
      <span><i className="notification-led" />项目 API 数据</span>
      <span>{visibleChannelState.status === 'ready' ? `${enabledChannelCount} / ${channels.length} 个渠道启用` : '渠道状态读取中'}</span>
      <span>环境切换会刷新视图并取消旧请求</span>
    </div>

    <div className="notification-tabs" role="tablist" aria-label="告警通知区域">
      <button role="tab" type="button" aria-selected={view === 'channels'} className={view === 'channels' ? 'active' : ''} onClick={() => setView('channels')}>
        <Icon name="settings" size={14} />通知渠道
      </button>
      <button role="tab" type="button" aria-selected={view === 'deliveries'} className={view === 'deliveries' ? 'active' : ''} onClick={() => setView('deliveries')}>
        <Icon name="clock" size={14} />投递历史
      </button>
    </div>

    {actionError && <div className="notification-feedback error" role="alert">{actionError}</div>}
    {notice && <div className="notification-feedback success" role="status">{notice}</div>}

    {view === 'channels' && <section className="notification-view" role="tabpanel" aria-label="通知渠道">
      <div className="notification-section-heading">
        <div><h3>投递渠道</h3><p>本项目渠道按配置环境生效；接收地址和密钥不会从服务端读回。</p></div>
        <button className="button primary" type="button" onClick={openCreateDialog} disabled={Boolean(busyAction)}><Icon name="plus" size={15} />新建渠道</button>
      </div>

      {visibleChannelState.status === 'loading' && <div className="notification-state" role="status" aria-live="polite"><span className="notification-state-mark"><Icon name="clock" size={16} /></span><strong>正在读取项目渠道…</strong><small>切换项目或环境后会重新确认作用范围。</small></div>}
      {visibleChannelState.status === 'error' && <div className="notification-state error" role="alert"><span className="notification-state-mark"><Icon name="alerts" size={16} /></span><strong>暂时无法读取渠道</strong><small>{visibleChannelState.message}</small><button className="button secondary compact" type="button" onClick={() => setChannelRetry((count) => count + 1)}>重试</button></div>}
      {visibleChannelState.status === 'ready' && channels.length === 0 && <div className="notification-state empty" role="status"><span className="notification-state-mark"><Icon name="plus" size={16} /></span><strong>还没有通知渠道</strong><small>创建 Webhook 或 Email 渠道后，可发送测试投递并跟踪送达情况。</small><button className="button secondary compact" type="button" onClick={openCreateDialog}>创建第一个渠道</button></div>}
      {visibleChannelState.status === 'ready' && channels.length > 0 && <div className="notification-channel-grid">
        {channels.map((channel) => <article className={`notification-channel-card ${channel.enabled ? '' : 'disabled'}`} key={channel.id}>
          <div className="notification-channel-topline">
            <div><span className={`channel-type-mark ${channel.type}`}><Icon name={channel.type === 'webhook' ? 'external' : 'docs'} size={15} /></span><span><strong>{channel.name}</strong><small>{channelTypeLabel(channel.type)}</small></span></div>
            <button type="button" role="switch" aria-checked={channel.enabled} aria-label={`${channel.name}${channel.enabled ? '已启用' : '已停用'}`} className={`toggle ${channel.enabled ? 'on' : ''}`} disabled={Boolean(busyAction)} onClick={() => void toggleChannel(channel)}><i /></button>
          </div>
          <div className="notification-channel-destination"><small>接收目标 · 服务端安全摘要</small><strong title={channel.destinationHint}>{channel.destinationHint || '未返回目标摘要'}</strong></div>
          <div className="notification-channel-tags"><span>{environmentLabel[channel.environment]}</span><span>{levelLabel[channel.minLevel]}</span><span className={channel.hasSecret ? 'credential-set' : 'credential-missing'}>{channel.hasSecret ? '凭证已配置' : '未配置凭证'}</span></div>
          <div className="notification-channel-footer"><span>更新于 {formatTime(channel.updatedAt)}</span><div>
            <button type="button" disabled={Boolean(busyAction) || !channel.enabled} onClick={() => void sendTest(channel)}>{busyAction === `test:${channel.id}` ? '提交中…' : '测试投递'}</button>
            <button type="button" disabled={Boolean(busyAction)} onClick={() => openEditDialog(channel)}>编辑</button>
            <button type="button" className="danger-text" disabled={Boolean(busyAction)} onClick={() => setDeleteCandidate(channel)}>删除</button>
          </div></div>
        </article>)}
      </div>}
    </section>}

    {view === 'deliveries' && <section className="notification-view" role="tabpanel" aria-label="投递历史">
      <div className="notification-section-heading">
        <div><h3>投递历史</h3><p>按项目查询最近投递记录；本页打开时每 3 秒刷新状态。</p></div>
        <label className="compact-filter"><span>状态</span><select value={deliveryStatus} onChange={(event) => setDeliveryFilter(event.target.value as AlertDeliveryStatusFilter)} aria-label="按投递状态筛选">
          <option value="all">全部状态</option><option value="queued">排队中</option><option value="sending">发送中</option><option value="retrying">等待重试</option><option value="sent">已送达</option><option value="failed">失败</option><option value="canceled">已取消</option>
        </select></label>
      </div>
      <div className="notification-scope-note"><Icon name="docs" size={14} /><span>当前上下文：{projectName} · {currentEnvironmentLabel}。投递接口仅提供项目和状态筛选，下面展示该项目所有环境的记录。</span></div>

      {visibleDeliveryState.status === 'loading' && <div className="notification-state compact-state" role="status" aria-live="polite"><span className="notification-state-mark"><Icon name="clock" size={16} /></span><strong>正在读取投递记录…</strong></div>}
      {visibleDeliveryState.status === 'error' && <div className="notification-state error" role="alert"><span className="notification-state-mark"><Icon name="alerts" size={16} /></span><strong>暂时无法读取投递历史</strong><small>{visibleDeliveryState.message}</small><button className="button secondary compact" type="button" onClick={() => setDeliveryRetryVersion((count) => count + 1)}>重试</button></div>}
      {visibleDeliveryState.status === 'ready' && deliveries && deliveries.items.length === 0 && <div className="notification-state empty" role="status"><span className="notification-state-mark"><Icon name="clock" size={16} /></span><strong>{deliveries.total === 0 ? '还没有投递记录' : '当前页没有符合条件的记录'}</strong><small>{deliveries.total === 0 ? '新告警或测试投递提交后，会在这里显示处理进度。' : '可以调整状态筛选或切换分页查看。'}</small></div>}
      {visibleDeliveryState.status === 'ready' && deliveries && deliveries.items.length > 0 && <div className="notification-table-wrap">
        <div className="table-scroll"><table className="notification-delivery-table"><thead><tr><th>创建时间</th><th>事件 / 渠道</th><th>告警与服务</th><th>环境</th><th>状态 / 次数</th><th>发送时间</th><th>最近错误码</th><th>操作</th></tr></thead><tbody>
          {deliveries.items.map((delivery) => <tr key={delivery.id}>
            <td><time dateTime={delivery.createdAt}>{formatTime(delivery.createdAt)}</time><small>{delivery.eventType === 'test' ? '测试记录' : delivery.traceId ? `Trace ${delivery.traceId.slice(0, 10)}…` : '告警事件'}</small></td>
            <td><strong>{deliveryEventLabel(delivery)}</strong><small>{delivery.channelName} · {channelTypeLabel(delivery.channelType)}</small></td>
            <td><strong>{delivery.alertTitle || (delivery.eventType === 'test' ? '测试事件' : '告警标题不可用')}</strong><small>{delivery.service || '—'}{delivery.level ? ` · ${levelLabel[delivery.level]}` : ''}</small></td>
            <td><span className="env-tag">{delivery.environment ? environmentLabel[delivery.environment] : '—'}</span></td>
            <td><StatusPill status={deliveryStatusTone[delivery.status]}>{deliveryStatusLabel[delivery.status]}</StatusPill><small className="attempt-caption">{delivery.attemptCount} 次尝试</small></td>
            <td><strong>{formatTime(delivery.lastAttemptAt)}</strong><small>{delivery.nextAttemptAt ? `下次 ${formatTime(delivery.nextAttemptAt)}` : delivery.deliveredAt ? `送达 ${formatTime(delivery.deliveredAt)}` : '无计划重试时间'}</small></td>
            <td>{delivery.lastErrorCode ? <code className="safe-error-code">{delivery.lastErrorCode}</code> : <span className="muted-caption">—</span>}</td>
            <td>{delivery.status === 'failed' ? <button className="button secondary compact" type="button" disabled={Boolean(busyAction)} onClick={() => void retryDelivery(delivery)}>{busyAction === `retry:${delivery.id}` ? '提交中…' : '重试'}</button> : <span className="muted-caption">—</span>}</td>
          </tr>)}
        </tbody></table></div>
      </div>}
      {visibleDeliveryState.status === 'ready' && deliveries && <div className="notification-pagination"><span>{deliveries.total > 0 ? `显示 ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, deliveries.total)} 条，共 ${new Intl.NumberFormat('zh-CN').format(deliveries.total)} 条` : '0 条投递'}</span><div><button type="button" disabled={page <= 1 || Boolean(busyAction)} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</button><span>第 {page} / {pageCount} 页</span><button type="button" disabled={page >= pageCount || Boolean(busyAction)} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>下一页</button></div></div>}
    </section>}

    {editor && <div className="notification-dialog-backdrop" role="presentation">
      <section className="notification-dialog" role="dialog" aria-modal="true" aria-labelledby="notification-editor-title">
        <header><div><span className="eyebrow">CHANNEL CONFIGURATION</span><h3 id="notification-editor-title">{editor.mode === 'create' ? '新建通知渠道' : '编辑通知渠道'}</h3></div><button type="button" className="dialog-close" aria-label="关闭" disabled={Boolean(busyAction)} onClick={closeEditor}>×</button></header>
        <form onSubmit={(event) => void saveChannel(event)} autoComplete="off">
          <label className="notification-form-field">渠道名称<input autoComplete="off" maxLength={120} required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：生产告警 Webhook" /></label>
          <fieldset className="notification-type-field"><legend>投递方式</legend><div>{(['webhook', 'email'] as const).map((type) => <label key={type} className={draft.type === type ? 'selected' : ''}><input type="radio" name="channel-type" value={type} checked={draft.type === type} disabled={editor.mode === 'edit' || Boolean(busyAction)} onChange={() => setDraft({ ...draft, type })} /><span><strong>{channelTypeLabel(type)}</strong><small>{type === 'webhook' ? '默认 HTTPS；HTTP 仅用于本地验收' : '发送到邮箱收件人'}</small></span></label>)}</div>{editor.mode === 'edit' && <small className="notification-form-hint">渠道类型创建后保持不变。</small>}</fieldset>
          <div className="notification-form-row">
            <label className="notification-form-field">生效环境<select value={draft.environment} onChange={(event) => setDraft({ ...draft, environment: event.target.value as AlertChannelEnvironment })}><option value="all">全部环境</option><option value="dev">development</option><option value="staging">staging</option><option value="prod">production</option></select></label>
            <label className="notification-form-field">最低告警级别<select value={draft.minLevel} onChange={(event) => setDraft({ ...draft, minLevel: event.target.value as AlertChannelLevel })}><option value="info">提示及以上</option><option value="warning">警告及以上</option><option value="critical">仅严重</option></select></label>
          </div>
          <label className="notification-form-field">{draft.type === 'webhook' ? 'Webhook URL' : '收件邮箱'}
            <input
              key={`${editor.mode}:${draft.type}`}
              type={draft.type === 'webhook' ? 'url' : 'email'}
              autoComplete={draft.type === 'webhook' ? 'new-password' : 'off'}
              spellCheck={false}
              maxLength={draft.type === 'webhook' ? 2048 : 254}
              required={editor.mode === 'create'}
              value={draft.destination}
              onChange={(event) => setDraft({ ...draft, destination: event.target.value })}
              placeholder={editor.mode === 'edit' ? '留空时保留服务端已保存的目标' : draft.type === 'webhook' ? 'https://hooks.example.com/…' : 'on-call@example.com'}
            />
          </label>
          {editor.mode === 'edit' && <div className="notification-secret-note"><Icon name="docs" size={14} /><span>{editor.channel?.hasSecret ? '服务端已保存接收目标。不会回显原值；留空时 PATCH 会省略该字段并保留现有配置。' : '服务端没有已配置凭证；输入新的目标后保存即可。'}</span></div>}
          <label className="notification-enabled-field"><span><strong>启用此渠道</strong><small>停用后不会接收新告警，历史记录仍保留。</small></span><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /></label>
          {actionError && <div className="notification-feedback error dialog-error" role="alert">{actionError}</div>}
          <footer><button className="button secondary" type="button" disabled={Boolean(busyAction)} onClick={closeEditor}>取消</button><button className="button primary" type="submit" disabled={Boolean(busyAction)}>{busyAction === 'save' ? '保存中…' : editor.mode === 'create' ? '创建渠道' : '保存修改'}</button></footer>
        </form>
      </section>
    </div>}

    {deleteCandidate && <div className="notification-dialog-backdrop" role="presentation">
      <section className="notification-dialog confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="notification-delete-title" aria-describedby="notification-delete-description">
        <span className="confirm-mark"><Icon name="alerts" size={18} /></span><h3 id="notification-delete-title">删除通知渠道？</h3><p id="notification-delete-description">将删除“{deleteCandidate.name}”渠道。已有投递记录会保留，这项操作无法撤销。</p>
        {actionError && <div className="notification-feedback error" role="alert">{actionError}</div>}
        <footer><button className="button secondary" type="button" disabled={Boolean(busyAction)} onClick={() => setDeleteCandidate(null)}>取消</button><button className="button danger-button" type="button" disabled={Boolean(busyAction)} onClick={() => void removeChannel()}>{busyAction === `delete:${deleteCandidate.id}` ? '删除中…' : '确认删除'}</button></footer>
      </section>
    </div>}
  </section>;
}
