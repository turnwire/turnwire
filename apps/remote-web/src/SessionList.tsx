import { useEffect, useId, useRef, useState } from 'react';
import { ChatCircle, DotsThree } from '@phosphor-icons/react';
import type { Session } from '@turnwire/protocol';
import { useLocale } from './i18n';
import './session-list.css';

export type SessionChange = { kind: 'rename'; title: string } | { kind: 'archive'; archived: boolean };
export type SessionManagementResult = { ok: true } | { ok: false; error: string } | { ok: false; cancelled: true };
type Manage = (id: string, change: SessionChange) => Promise<SessionManagementResult>;
type OperationError = { title: string; message: string };

/** The list owns menu identity and operation state, including results for rows that disappear. */
export function SessionList({ sessions, selected, disabled, active, empty, onSelect, onManage }: { sessions: Session[]; selected?: string; disabled: boolean; active: boolean; empty?: string; onSelect: (id: string) => void; onManage: Manage }) {
  const t = useLocale();
  const [openSessionId, setOpenSessionId] = useState<string>();
  const opening = useRef<{ id: string } | undefined>(undefined);
  const [drafts, setDrafts] = useState<Record<string, string | undefined>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const locks = useRef(new Set<string>());
  const [errors, setErrors] = useState<Record<string, OperationError | undefined>>({});
  const list = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const triggerFor = (id: string) => Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.session-more') ?? []).find(button => button.dataset.target === id);
  function close(focus = false) {
    const id = opening.current?.id;
    opening.current = undefined; setOpenSessionId(undefined);
    if (focus && id) (triggerFor(id) ?? list.current)?.focus();
  }
  function toggle(id: string) {
    if (opening.current?.id === id) { close(); return; }
    opening.current = { id }; setOpenSessionId(id);
  }
  useEffect(() => { if (!active) close(); }, [active]);
  useEffect(() => {
    if (openSessionId && !sessions.some(session => session.id === openSessionId)) {
      // A snapshot may remove a row before its management promise settles.
      if (document.activeElement === document.body) list.current?.focus();
      close();
    }
  }, [sessions, openSessionId]);
  useEffect(() => {
    if (!openSessionId) return;
    panel.current?.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus();
    const away = (event: PointerEvent) => { if (!panel.current?.parentElement?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(true); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape, true); };
  }, [openSessionId]);
  const editing = openSessionId !== undefined && drafts[openSessionId] !== undefined;
  useEffect(() => { if (editing) panel.current?.querySelector('input')?.focus(); }, [editing, openSessionId]);
  useEffect(() => { if (openSessionId && errors[openSessionId]) panel.current?.querySelector('[role="alert"]')?.scrollIntoView({ block: 'nearest' }); }, [errors, openSessionId]);
  async function manage(session: Session, change: SessionChange) {
    const id = session.id;
    if (disabled || locks.current.has(id) || (change.kind === 'archive' && ['running', 'waiting_approval'].includes(session.status)) || (change.kind === 'rename' && !change.title.trim())) return;
    const requestOpening = opening.current;
    locks.current.add(id); setPending(previous => ({ ...previous, [id]: true }));
    setErrors(previous => ({ ...previous, [id]: undefined }));
    try {
      const result = await onManage(id, change);
      if ('cancelled' in result) return;
      if (!result.ok) { setErrors(previous => ({ ...previous, [id]: { title: session.title, message: result.error } })); return; }
      if (change.kind === 'rename') setDrafts(previous => previous[id]?.trim() === change.title ? { ...previous, [id]: undefined } : previous);
      // A late response must not close B, or a newly reopened A, or steal their focus.
      if (opening.current === requestOpening && requestOpening) {
        const restore = !!panel.current?.contains(document.activeElement);
        close(restore && change.kind !== 'archive');
        if (restore && change.kind === 'archive') list.current?.focus();
        setDrafts(previous => ({ ...previous, [id]: undefined }));
      }
    } catch (error) {
      setErrors(previous => ({ ...previous, [id]: { title: session.title, message: error instanceof Error ? error.message : t('sessionList.failed') } }));
    } finally {
      locks.current.delete(id); setPending(previous => ({ ...previous, [id]: false }));
    }
  }
  const errorView = (id: string, error: OperationError) => <div key={id} className="session-management-error" role="alert" data-error-session-id={id}><strong>{t('sessionList.failedFor', { title: error.title })}</strong><span>{error.message}</span><button type="button" onClick={() => setErrors(previous => ({ ...previous, [id]: undefined }))}>{t('sessionList.dismissError')}</button></div>;
  return <nav ref={list} aria-label={t('sidebar.sessionList')} className="session-list" tabIndex={-1}>
    {Object.entries(errors).map(([id, error]) => error && (id !== openSessionId || !sessions.some(session => session.id === id)) ? errorView(id, error) : null)}
    {sessions.map(session => {
      const id = session.id; const open = openSessionId === id; const draft = drafts[id];
      const archiveDisabled = disabled || pending[id] || ['running', 'waiting_approval'].includes(session.status);
      return <div key={id} className={`session-list-item${selected === id ? ' selected' : ''}`} data-session-id={id}>
        <button type="button" className={`session-row${selected === id ? ' selected' : ''}`} onClick={() => { close(); onSelect(id); }} aria-current={selected === id ? 'page' : undefined}><ChatCircle size={17} /><span><strong>{session.title}</strong><small>{session.cwd.split('/').filter(Boolean).slice(-2).join('/')}</small></span><span className={`session-dot ${session.status}`} aria-label={t(`status.${session.status}`)} /></button>
        <button type="button" data-target={id} className="session-more icon-button" aria-label={t('sessionList.more', { title: session.title })} aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? menuId : undefined} onClick={() => toggle(id)}><DotsThree size={22} weight="bold" /></button>
        {open && <div ref={panel} id={menuId} className="session-row-menu" role="dialog" aria-label={t('sessionList.manage', { title: session.title })}>
          {errors[id] && errorView(id, errors[id])}
          {draft === undefined ? <><button type="button" disabled={disabled || pending[id]} onClick={() => setDrafts(previous => ({ ...previous, [id]: session.title }))}>{t('sessionList.rename')}</button><button type="button" disabled={archiveDisabled} onClick={() => void manage(session, { kind: 'archive', archived: !session.archived })}>{session.archived ? t('common.unarchive') : t('sessionList.archive')}</button></> : <form onSubmit={event => { event.preventDefault(); void manage(session, { kind: 'rename', title: draft.trim() }); }}>
            <label>{t('sessionList.newName')}<input aria-label={t('sessionList.newName')} value={draft} disabled={disabled || pending[id]} onChange={event => setDrafts(previous => ({ ...previous, [id]: event.target.value }))} /></label>
            <div className="session-rename-actions"><button type="button" onClick={() => { setDrafts(previous => ({ ...previous, [id]: undefined })); close(true); }}>{t('sessionList.cancel')}</button><button type="submit" disabled={disabled || pending[id] || !draft.trim()}>{t('sessionList.saveName')}</button></div>
          </form>}
        </div>}
      </div>;
    })}{empty && <p className="sidebar-empty">{empty}</p>}
  </nav>;
}
