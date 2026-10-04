import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createProject } from '../project-create-api';
import type { ProjectOption } from '../overview-api';

function suggestedSlug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
}

export function ProjectCreateDialog({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (project: ProjectOption) => void;
}) {
  const id = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [retentionDays, setRetentionDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    nameInput.current?.focus();
    return () => pending.current?.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const created = await createProject({ name, slug, retentionDays: Number(retentionDays) }, controller.signal);
      if (!controller.signal.aborted) onCreated(created);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '创建项目失败，请稍后重试。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <div className="notification-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="notification-dialog project-create-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
      <header><div><span className="eyebrow">PROJECT / CREATE</span><h3 id={`${id}-title`}>创建项目</h3></div><button className="dialog-close" type="button" aria-label="关闭" onClick={onClose} disabled={busy}>×</button></header>
      <form onSubmit={(event) => void submit(event)}>
        <p className="project-create-help">创建后将进入接入引导，依次注册服务、创建写入凭证并发送首条 Trace。</p>
        <label className="notification-form-field">项目名称<input ref={nameInput} value={name} maxLength={120} required onChange={(event) => { const next = event.target.value; setName(next); if (!slugEdited) setSlug(suggestedSlug(next)); }} placeholder="例如：智能客服" /></label>
        <label className="notification-form-field">英文标识<input value={slug} maxLength={120} required pattern="[a-z0-9]+(-[a-z0-9]+)*" onChange={(event) => { setSlugEdited(true); setSlug(event.target.value); }} placeholder="例如：customer-assistant" /><small>只允许小写字母、数字和连字符，创建后用于区分项目。</small></label>
        <label className="notification-form-field">Trace 明细保留天数<input type="number" min={1} max={3650} step={1} required value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)} /></label>
        {error && <p className="notification-feedback error" role="alert">{error}</p>}
        <footer><button className="button secondary" type="button" onClick={onClose} disabled={busy}>取消</button><button className="button primary" type="submit" disabled={busy}>{busy ? '正在创建…' : '创建并开始接入'}</button></footer>
      </form>
    </section>
  </div>;
}
