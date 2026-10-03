import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Icon } from '../components/ui';
import {
  createProjectKey,
  createProjectService,
  fetchProjectAudit,
  fetchProjectKeys,
  fetchProjectPrivacy,
  fetchProjectServices,
  isValidAdditionalRedactedField,
  isCurrentProjectRequest,
  PROJECT_ENVIRONMENTS,
  PROJECT_KEY_SCOPES,
  ProjectSettingsApiError,
  revokeProjectKey,
  rotateProjectKey,
  updateProjectPrivacy,
  type ProjectAuditRecord,
  type ProjectEnvironment,
  type ProjectKey,
  type ProjectKeyScope,
  type ProjectService,
} from '../project-settings-api';

type ResourceState<T> =
  | { projectId: string; status: 'loading' }
  | { projectId: string; status: 'ready'; data: T }
  | { projectId: string; status: 'error'; message: string };
type ProjectLoader<T> = (projectId: string, signal?: AbortSignal) => Promise<T>;

function useProjectResource<T>(projectId: string, loader: ProjectLoader<T>) {
  const activeProjectId = useRef(projectId);
  activeProjectId.current = projectId;
  const [revision, setRevision] = useState(0);
  const [storedState, setStoredState] = useState<ResourceState<T>>({ projectId, status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    const requestProjectId = projectId;
    setStoredState({ projectId: requestProjectId, status: 'loading' });
    loader(requestProjectId, controller.signal).then((data) => {
      if (isCurrentProjectRequest(requestProjectId, activeProjectId.current, controller.signal)) {
        setStoredState({ projectId: requestProjectId, status: 'ready', data });
      }
    }).catch((error: unknown) => {
      if (isCurrentProjectRequest(requestProjectId, activeProjectId.current, controller.signal)) {
        setStoredState({ projectId: requestProjectId, status: 'error', message: errorMessage(error) });
      }
    });
    return () => controller.abort();
  }, [loader, projectId, revision]);

  const state = storedState.projectId === projectId ? storedState : { projectId, status: 'loading' as const };
  return { state, refresh: () => setRevision((current) => current + 1) };
}

function useMutationController() {
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  return () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    return next;
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof ProjectSettingsApiError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return '';
  return '项目配置操作失败，请稍后重试。';
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function envLabel(environment: ProjectEnvironment): string {
  return environment === 'dev' ? '开发 · dev' : environment === 'staging' ? '预发 · staging' : '生产 · prod';
}

function InlineMessage({ kind, children }: { kind: 'error' | 'success' | 'info'; children: ReactNode }) {
  return <p className={`project-settings-message ${kind}`} role={kind === 'error' ? 'alert' : 'status'} aria-live="polite">{children}</p>;
}

function ResourceMessage<T>({ state, empty, onRetry }: { state: ResourceState<T>; empty: boolean; onRetry: () => void }) {
  if (state.status === 'loading') return <div className="project-settings-empty" role="status" aria-live="polite">正在读取项目数据…</div>;
  if (state.status === 'error') return <div className="project-settings-empty error" role="alert"><span>{state.message}</span><button className="button secondary" type="button" onClick={onRetry}>重试</button></div>;
  if (empty) return <div className="project-settings-empty" role="status">暂无记录</div>;
  return null;
}

export function ProjectServicesSettings({ projectId }: { projectId: string }) {
  const id = useId();
  const { state, refresh } = useProjectResource(projectId, fetchProjectServices);
  const beginMutation = useMutationController();
  const activeProjectId = useRef(projectId);
  activeProjectId.current = projectId;
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<ProjectEnvironment>('dev');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setActionError('请填写服务名称。');
      setSuccess('');
      return;
    }
    const requestProjectId = projectId;
    const controller = beginMutation();
    setBusy(true);
    setActionError('');
    setSuccess('');
    try {
      await createProjectService(requestProjectId, { name: trimmedName, environment }, controller.signal);
      if (!isCurrentProjectRequest(requestProjectId, activeProjectId.current, controller.signal)) return;
      setName('');
      setSuccess('服务已创建，正在刷新服务列表。');
      refresh();
    } catch (error) {
      if (isCurrentProjectRequest(requestProjectId, activeProjectId.current, controller.signal)) setActionError(errorMessage(error));
    } finally {
      if (isCurrentProjectRequest(requestProjectId, activeProjectId.current, controller.signal)) setBusy(false);
    }
  }

  return <div className="settings-content-grid project-config-grid">
    <section className="panel settings-card">
      <div className="panel-heading"><div><h2>已注册服务与环境</h2><small>数据来自当前项目的服务注册记录，不代表实时上报状态。</small></div></div>
      <div className="project-settings-table-wrap" aria-busy={state.status === 'loading'}>
        {state.status === 'ready' && state.data.length > 0 && <table className="data-table project-settings-table">
          <thead><tr><th scope="col">服务名称</th><th scope="col">环境</th><th scope="col">SDK 版本</th><th scope="col">注册时间</th></tr></thead>
          <tbody>{state.data.map((service: ProjectService) => <tr key={service.id}>
            <td className="service-name" data-label="服务名称">{service.name}</td><td data-label="环境"><span className="env-tag">{envLabel(service.environment)}</span></td>
            <td data-label="SDK 版本">{service.sdkVersion ?? '—'}</td><td data-label="注册时间">{formatTime(service.createdAt)}</td>
          </tr>)}</tbody>
        </table>}
        <ResourceMessage state={state} empty={state.status === 'ready' && state.data.length === 0} onRetry={refresh} />
      </div>
    </section>
    <section className="panel settings-card">
      <div className="panel-heading"><div><h2>添加服务</h2><small>先注册服务与环境，SDK 才能向该项目上报。</small></div></div>
      <form className="project-settings-form" onSubmit={submit}>
        <label className="form-field" htmlFor={`${id}-service-name`}>服务名称
          <input id={`${id}-service-name`} autoComplete="off" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：assistant-api" disabled={busy} required />
        </label>
        <label className="form-field" htmlFor={`${id}-service-environment`}>运行环境
          <select id={`${id}-service-environment`} value={environment} onChange={(event) => setEnvironment(event.target.value as ProjectEnvironment)} disabled={busy}>
            {PROJECT_ENVIRONMENTS.map((item) => <option key={item} value={item}>{envLabel(item)}</option>)}
          </select>
        </label>
        {actionError && <InlineMessage kind="error">{actionError}</InlineMessage>}
        {success && <InlineMessage kind="success">{success}</InlineMessage>}
        <div className="project-settings-form-actions"><button className="button primary" type="submit" disabled={busy}>{busy ? '正在创建…' : <><Icon name="plus" size={14} />添加服务</>}</button></div>
      </form>
    </section>
  </div>;
}

const BUILT_IN_REDACTION_RULES = [
  '字段名包含 Prompt、Response、用户输入、文档正文、completion text 或 raw messages',
  '字段名包含 authorization、password 或 credential',
  '字段名包含 API / Project / Private / Secret / Signing Key',
  '字段名包含 API / Project / Access / Refresh / Auth / Bearer / Client Token',
];

export function ProjectPrivacySettings({ projectId }: { projectId: string }) {
  const id = useId();
  const { state, refresh } = useProjectResource(projectId, fetchProjectPrivacy);
  const beginMutation = useMutationController();
  const activeProjectId = useRef(projectId);
  activeProjectId.current = projectId;
  const [draft, setDraft] = useState<string[]>([]);
  const [newField, setNewField] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    if (state.status === 'ready') {
      setDraft([...state.data.additionalRedactedFields]);
      setNewField('');
      setActionError('');
    }
  }, [state]);

  function addField(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const inputField = newField.trim();
    if (!isValidAdditionalRedactedField(inputField)) {
      setActionError('字段名须以英文字母开头，只能包含英文字母、数字、下划线或连字符，长度为 1–64。');
      setSuccess('');
      return;
    }
    const field = inputField.toLowerCase();
    if (draft.some((current) => current.toLowerCase() === field)) {
      setActionError('该字段已在脱敏列表中。');
      setSuccess('');
      return;
    }
    if (draft.length >= 64) {
      setActionError('最多可添加 64 个额外脱敏字段，请先删除不需要的字段。');
      setSuccess('');
      return;
    }
    setDraft((current) => [...current, field]);
    setNewField('');
    setActionError('');
    setSuccess('');
  }

  async function save() {
    if (state.status !== 'ready') return;
    const requestProjectId = projectId;
    const controller = beginMutation();
    setBusy(true);
    setActionError('');
    setSuccess('');
    try {
      const policy = await updateProjectPrivacy(requestProjectId, draft, controller.signal);
      if (!isCurrentProjectRequest(requestProjectId, activeProjectId.current, controller.signal)) return;
      setDraft([...policy.additionalRedactedFields]);
      setSuccess('脱敏字段策略已保存。');
      refresh();
    } catch (error) {
      if (isCurrentProjectRequest(requestProjectId, activeProjectId.current, controller.signal)) setActionError(errorMessage(error));
    } finally {
      if (isCurrentProjectRequest(requestProjectId, activeProjectId.current, controller.signal)) setBusy(false);
    }
  }

  const dirty = state.status === 'ready' && JSON.stringify(draft) !== JSON.stringify(state.data.additionalRedactedFields);
  return <div className="settings-content-grid project-config-grid">
    <section className="panel settings-card">
      <div className="panel-heading"><div><h2>项目采集边界</h2><small>服务端固定关闭原文采集；此页面不提供开启入口。</small></div></div>
      {state.status === 'ready' && <div className="setting-list">
        <div className="setting-item"><div><strong>Prompt / Response 原文</strong><p>当前策略：{state.data.capturePromptResponse ? '已启用' : '关闭'}。本版本不支持采集或展示原文。</p></div><span className="policy-chip disabled">禁用</span></div>
        <div className="setting-item"><div><strong>Span 属性</strong><p>只展示经过服务端投影的安全字段；脱敏字段名在嵌套对象中递归过滤。</p></div><span className="policy-chip">安全投影</span></div>
        <div className="setting-item"><div><strong>原始错误文本</strong><p>自由文本异常不进入上报链路，保留状态和安全错误分类。</p></div><span className="policy-chip">不采集</span></div>
      </div>}
      <div className="project-redaction-rules"><strong>内建字段名脱敏规则</strong><ul>{BUILT_IN_REDACTION_RULES.map((rule) => <li key={rule}>{rule}</li>)}</ul><p>递归深度超过 8 层会截断；字符串超过 4,000 字符会截断。此规则匹配字段名，不承诺对普通文本中的邮箱或手机号进行内容级替换。</p></div>
      {state.status === 'loading' && <div className="project-settings-empty" role="status">正在读取隐私策略…</div>}
      {state.status === 'error' && <div className="project-settings-empty error" role="alert"><span>{state.message}</span><button className="button secondary" type="button" onClick={refresh}>重试</button></div>}
    </section>
    <section className="panel settings-card">
      <div className="panel-heading"><div><h2>额外脱敏字段</h2><small>仅追加需要过滤的属性字段名；保存后由服务端策略生效。</small></div></div>
      {state.status === 'ready' && <>
        <form className="project-settings-form compact" onSubmit={addField}>
          <label className="form-field" htmlFor={`${id}-redaction-field`}>字段名
            <input id={`${id}-redaction-field`} autoComplete="off" maxLength={64} value={newField} onChange={(event) => setNewField(event.target.value)} placeholder="例如：customer_email" disabled={busy} />
            <small>以字母开头，仅允许字母、数字、下划线和连字符；最多 64 个字段（{draft.length}/64）。</small>
          </label>
          <button className="button secondary" type="submit" disabled={busy || draft.length >= 64 || !newField.trim()}><Icon name="plus" size={14} />追加</button>
        </form>
        {draft.length > 0 ? <ul className="project-redaction-fields" aria-label="额外脱敏字段">{draft.map((field) => <li key={field}>
          <code>{field}</code><button type="button" className="text-action remove-field" disabled={busy} aria-label={`删除脱敏字段 ${field}`} onClick={() => { setDraft((current) => current.filter((item) => item !== field)); setSuccess(''); setActionError(''); }}>删除</button>
        </li>)}</ul> : <div className="project-settings-empty" role="status">当前没有额外脱敏字段。</div>}
        {actionError && <InlineMessage kind="error">{actionError}</InlineMessage>}
        {success && <InlineMessage kind="success">{success}</InlineMessage>}
        <div className="project-settings-form-actions"><button className="button primary" type="button" onClick={save} disabled={!dirty || busy}>{busy ? '正在保存…' : '保存脱敏策略'}</button></div>
      </>}
      {state.status === 'loading' && <div className="project-settings-empty" role="status">正在读取可编辑策略…</div>}
      {state.status === 'error' && <div className="project-settings-empty error" role="alert"><span>{state.message}</span><button className="button secondary" type="button" onClick={refresh}>重试</button></div>}
    </section>
  </div>;
}

const SCOPE_LABELS: Record<ProjectKeyScope, string> = {
  'spans:write': 'spans:write · 写入 Span',
  'trace:read': 'trace:read · 读取 Trace',
};

const AUDIT_ACTION_LABELS: Record<string, string> = {
  'project_key.created': '创建项目凭证',
  'project_key.rotated': '轮换项目凭证',
  'project_key.revoked': '撤销项目凭证',
  'project_privacy_policy.updated': '更新脱敏策略',
  'service.created': '注册服务',
  other: '其他配置变更',
};

function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? '其他配置变更';
}

function resourceLabel(resource: ProjectAuditRecord['resource']): string {
  if (resource === 'project_key') return '项目凭证';
  if (resource === 'project_privacy_policy') return '隐私策略';
  if (resource === 'service') return '服务';
  return '其他资源';
}

function SecretReveal({ name, secret, onDismiss }: { name: string; secret: string; onDismiss: () => void }) {
  const [copyError, setCopyError] = useState('');
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setCopyError('');
    } catch {
      setCopyError('复制失败，请检查浏览器剪贴板权限；密钥仍只在当前页面内存中。');
    }
  }
  return <section className="project-secret-reveal" aria-labelledby="project-secret-heading">
    <div><h3 id="project-secret-heading">{name} · 新凭证仅显示一次</h3><p>请立即复制并保存到受控的服务端密钥管理器。离开页面或隐藏后无法再次读取。</p></div>
    <code className="project-secret-value">{secret}</code>
    {copyError && <InlineMessage kind="error">{copyError}</InlineMessage>}
    {copied && <InlineMessage kind="success">已复制。应用不会将明文写入 localStorage 或 sessionStorage。</InlineMessage>}
    <div className="project-settings-form-actions"><button className="button secondary" type="button" onClick={copy}><Icon name="copy" size={14} />复制凭证</button><button className="button primary" type="button" onClick={onDismiss}>已保存，隐藏明文</button></div>
  </section>;
}

function KeyConfirmation({ action, keyItem, busy, onConfirm, onCancel }: {
  action: 'rotate' | 'revoke'; keyItem: ProjectKey; busy: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const rotate = action === 'rotate';
  return <div className="project-key-confirm" role="group" aria-label={`${rotate ? '轮换' : '撤销'}凭证确认`}>
    <p>{rotate ? '轮换会立即停用当前凭证并生成新明文；' : '撤销后此凭证将立即失效且无法恢复；'}请确认操作 <code>{keyItem.keyPrefix}</code>。</p>
    <div><button className={`button ${rotate ? 'primary' : 'danger'}`} type="button" disabled={busy} onClick={onConfirm}>{busy ? '正在处理…' : rotate ? '确认轮换' : '确认撤销'}</button><button className="button secondary" type="button" disabled={busy} onClick={onCancel}>取消</button></div>
  </div>;
}

export function ProjectCredentialsSettings({ projectId }: { projectId: string }) {
  const id = useId();
  const keys = useProjectResource(projectId, fetchProjectKeys);
  const audits = useProjectResource(projectId, fetchProjectAudit);
  const beginMutation = useMutationController();
  const activeProjectId = useRef(projectId);
  activeProjectId.current = projectId;
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ProjectKeyScope[]>(['spans:write']);
  const [busyAction, setBusyAction] = useState('');
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const [oneTimeCredential, setOneTimeCredential] = useState<{ projectId: string; name: string; secret: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{ action: 'rotate' | 'revoke'; key: ProjectKey } | null>(null);

  function showCreatedCredential(requestProjectId: string, key: { name: string; key: string }) {
    if (requestProjectId !== activeProjectId.current) return;
    setOneTimeCredential({ projectId: requestProjectId, name: key.name, secret: key.key });
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || scopes.length === 0) {
      setActionError(scopes.length === 0 ? '至少选择一个权限范围。' : '请填写凭证名称。');
      setSuccess('');
      return;
    }
    const requestProjectId = projectId;
    const controller = beginMutation();
    setBusyAction('create');
    setActionError('');
    setSuccess('');
    setOneTimeCredential(null);
    setConfirmation(null);
    try {
      const created = await createProjectKey(requestProjectId, trimmedName, scopes, controller.signal);
      if (!isCurrentProjectRequest(requestProjectId, activeProjectId.current, controller.signal)) return;
      showCreatedCredential(requestProjectId, created);
      setName('');
      setSuccess('凭证已创建。列表正在从 API 刷新；明文不会再次从列表读取。');
      keys.refresh();
      audits.refresh();
    } catch (error) {
      if (isCurrentProjectRequest(requestProjectId, activeProjectId.current, controller.signal)) setActionError(errorMessage(error));
    } finally {
      if (isCurrentProjectRequest(requestProjectId, activeProjectId.current, controller.signal)) setBusyAction('');
    }
  }

  async function confirmKeyAction() {
    if (!confirmation) return;
    const requestProjectId = projectId;
    const { action, key } = confirmation;
    const controller = beginMutation();
    setBusyAction(key.id);
    setActionError('');
    setSuccess('');
    setOneTimeCredential(null);
    try {
      if (action === 'rotate') {
        const rotated = await rotateProjectKey(requestProjectId, key.id, controller.signal);
        if (!isCurrentProjectRequest(requestProjectId, activeProjectId.current, controller.signal)) return;
        showCreatedCredential(requestProjectId, rotated);
        setSuccess('凭证已轮换，旧凭证已由服务端停用。列表正在刷新。');
      } else {
        await revokeProjectKey(requestProjectId, key.id, controller.signal);
        if (!isCurrentProjectRequest(requestProjectId, activeProjectId.current, controller.signal)) return;
        setSuccess('凭证已撤销。');
      }
      setConfirmation(null);
      keys.refresh();
      audits.refresh();
    } catch (error) {
      if (isCurrentProjectRequest(requestProjectId, activeProjectId.current, controller.signal)) setActionError(errorMessage(error));
    } finally {
      if (isCurrentProjectRequest(requestProjectId, activeProjectId.current, controller.signal)) setBusyAction('');
    }
  }

  const visibleSecret = oneTimeCredential?.projectId === projectId ? oneTimeCredential : null;
  return <div className="project-access-layout">
    <div className="settings-content-grid project-config-grid">
      <section className="panel settings-card">
        <div className="panel-heading"><div><h2>项目接入凭证</h2><small>凭证仅展示安全前缀与权限；完整明文只在创建或轮换响应中出现一次。</small></div></div>
        <form className="project-settings-form" onSubmit={submitCreate}>
          <label className="form-field" htmlFor={`${id}-key-name`}>凭证名称
            <input id={`${id}-key-name`} autoComplete="off" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：assistant-api-prod" disabled={Boolean(busyAction)} required />
          </label>
          <fieldset className="project-scope-options" disabled={Boolean(busyAction)}><legend>选择一个最小权限范围</legend>{PROJECT_KEY_SCOPES.map((scope) => <label key={scope}>
            <input type="radio" name={`${id}-scope`} checked={scopes[0] === scope} onChange={() => setScopes([scope])} />
            <span><strong>{scope}</strong><small>{scope === 'spans:write' ? '允许向所属项目写入 Span' : '允许读取所属项目 Trace'}</small></span>
          </label>)}</fieldset>
          <p className="project-key-scope-note">每把凭证只授予一个 scope。需要读写能力时，建议分别创建两把 key，避免单个凭证泄露后同时暴露读写权限。</p>
          {actionError && <InlineMessage kind="error">{actionError}</InlineMessage>}
          {success && <InlineMessage kind="success">{success}</InlineMessage>}
          <div className="project-settings-form-actions"><button className="button primary" type="submit" disabled={Boolean(busyAction) || scopes.length === 0}>{busyAction === 'create' ? '正在创建…' : <><Icon name="plus" size={14} />创建凭证</>}</button></div>
        </form>
        {visibleSecret && <SecretReveal name={visibleSecret.name} secret={visibleSecret.secret} onDismiss={() => setOneTimeCredential(null)} />}
      </section>
      <section className="panel settings-card">
        <div className="panel-heading"><div><h2>已签发凭证</h2><small>撤销和轮换会写入项目配置审计。</small></div><button className="text-action" type="button" onClick={keys.refresh} disabled={keys.state.status === 'loading'}>刷新<Icon name="arrow" size={13} /></button></div>
        <div className="project-key-list" aria-busy={keys.state.status === 'loading'}>
          {keys.state.status === 'ready' && keys.state.data.map((keyItem) => {
            const isRevoked = keyItem.revokedAt !== null;
            const actionBusy = busyAction === keyItem.id;
            return <article className="project-key-card" key={keyItem.id}>
              <div className="project-key-heading"><div><strong>{keyItem.name}</strong><span className={`project-key-status ${isRevoked ? 'revoked' : 'active'}`}>{isRevoked ? '已撤销' : '有效'}</span></div>
                {!isRevoked && <div className="project-key-actions"><button className="text-action" type="button" disabled={Boolean(busyAction)} onClick={() => { setConfirmation({ action: 'rotate', key: keyItem }); setActionError(''); setSuccess(''); }}>轮换</button><button className="text-action danger-text" type="button" disabled={Boolean(busyAction)} onClick={() => { setConfirmation({ action: 'revoke', key: keyItem }); setActionError(''); setSuccess(''); }}>撤销</button></div>}
              </div>
              <div className="project-key-details"><span>前缀 <code>{keyItem.keyPrefix}…</code></span><span>创建于 {formatTime(keyItem.createdAt)}</span><span>最近使用 {keyItem.lastUsedAt ? formatTime(keyItem.lastUsedAt) : '尚未使用'}</span></div>
              <ul className="project-key-scopes" aria-label={`${keyItem.name}的权限范围`}>{keyItem.scopes.map((scope) => <li key={scope}>{SCOPE_LABELS[scope]}</li>)}</ul>
              {isRevoked && keyItem.revokedAt && <small className="project-key-revoked-time">撤销于 {formatTime(keyItem.revokedAt)}</small>}
              {confirmation?.key.id === keyItem.id && <KeyConfirmation action={confirmation.action} keyItem={keyItem} busy={actionBusy} onConfirm={confirmKeyAction} onCancel={() => setConfirmation(null)} />}
            </article>;
          })}
          {keys.state.status === 'ready' && keys.state.data.length === 0 && <div className="project-settings-empty" role="status">当前项目还没有接入凭证。</div>}
          {keys.state.status === 'loading' && <div className="project-settings-empty" role="status">正在读取凭证…</div>}
          {keys.state.status === 'error' && <div className="project-settings-empty error" role="alert"><span>{keys.state.message}</span><button className="button secondary" type="button" onClick={keys.refresh}>重试</button></div>}
        </div>
      </section>
    </div>
    <section className="panel settings-card project-audit-card">
      <div className="panel-heading"><div><h2>配置审计</h2><small>最近 20 条关键配置事件；仅显示操作类型、资源类别和时间，不展示密钥或策略内容。</small></div><button className="text-action" type="button" onClick={audits.refresh} disabled={audits.state.status === 'loading'}>刷新<Icon name="arrow" size={13} /></button></div>
      <AuditList state={audits.state} onRetry={audits.refresh} />
    </section>
  </div>;
}

function AuditList({ state, onRetry }: { state: ResourceState<ProjectAuditRecord[]>; onRetry: () => void }) {
  if (state.status === 'loading') return <div className="project-settings-empty" role="status">正在读取审计记录…</div>;
  if (state.status === 'error') return <div className="project-settings-empty error" role="alert"><span>{state.message}</span><button className="button secondary" type="button" onClick={onRetry}>重试</button></div>;
  if (state.data.length === 0) return <div className="project-settings-empty" role="status">暂无配置审计记录。</div>;
  return <div className="project-audit-list">{state.data.map((item) => <article className="project-audit-row" key={item.id}>
    <time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time><strong>{auditActionLabel(item.action)}</strong><span>{resourceLabel(item.resource)}</span>
  </article>)}</div>;
}
