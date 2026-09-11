import { useEffect, useRef, useState } from 'react';
import { loadSubagentHistoryPage, type TurnwireClient } from '@turnwire/sdk';
import type { SubagentHistoryPage } from '@turnwire/protocol';
import { t, useLocale } from './i18n';

/** A bounded snapshot window. Older pages replace this window; they never merge with live data. */
interface ChildExecutionProps { client?: TurnwireClient; sessionId: string; subagentId: string; running: boolean; connected: boolean }
export function ChildExecution(props: ChildExecutionProps) {
  const identity = useRef({ client: props.client, sessionId: props.sessionId, subagentId: props.subagentId, generation: 0 });
  if (identity.current.client !== props.client || identity.current.sessionId !== props.sessionId || identity.current.subagentId !== props.subagentId) identity.current = { client: props.client, sessionId: props.sessionId, subagentId: props.subagentId, generation: identity.current.generation + 1 };
  return <ExecutionWindow key={identity.current.generation} {...props} />;
}
function ExecutionWindow({ client, sessionId, subagentId, running, connected }: ChildExecutionProps) {
  useLocale();
  const [page, setPage] = useState<SubagentHistoryPage>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [window, setWindow] = useState<{ before?: number; cursor?: number; revision: number }>({ revision: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  const older = window.before !== undefined;
  useEffect(() => {
    let active = true;
    let firstRead = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!client || !connected) { setLoading(false); return; }
    const load = async () => {
      if (firstRead) setLoading(true);
      try {
        const result = await loadSubagentHistoryPage(client, { sessionId, subagentId, limit: 50, before: window.before, cursor: window.cursor });
        if (!active) return;
        setPage(result); setError('');
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally {
        if (active) {
          firstRead = false;
          setLoading(false);
          if (running && !older) timer = setTimeout(() => void load(), 2000);
        }
      }
    };
    void load();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [client, sessionId, subagentId, running, connected, window, older]);
  return <section className="child-execution" aria-label={t('execution.aria')}>
    <div className="child-execution-heading"><strong>{t('execution.title')}</strong><span>{t(older ? 'execution.olderStatus' : running ? 'execution.liveStatus' : 'execution.inactiveStatus')}</span></div>
    {!connected && <p role="status">{t('execution.offline')}</p>}
    {error && <p role="alert">{t(page ? 'execution.stale' : 'execution.loadError', { error })} <button type="button" disabled={!connected || loading} onClick={() => setWindow(value => ({ ...value, revision: value.revision + 1 }))}>{t('execution.retry')}</button></p>}
    {loading && <p role="status">{t('execution.loading')}</p>}
    {page && !page.records.length && <p>{t('execution.empty')}</p>}
    <div className="child-records" ref={viewport}>{page?.records.map(record => <article key={record.id} className={`child-record child-${record.role}`} data-record-id={record.id}>
      {record.role === 'tool' ? <details><summary>{record.tool ?? t('tool.tool')} · {t(record.isError ? 'tool.failed' : record.complete ? 'execution.complete' : 'tool.running')}</summary>
        <h5>{t('execution.input')}</h5><pre>{record.input ?? ''}</pre><h5>{t('tool.output')}</h5><pre>{record.output ?? (record.complete ? record.text : t('execution.pendingResult'))}</pre>
      </details> : <><small>{t(`execution.role.${record.role}`)} · {record.time}{!record.complete && ` · ${t('execution.inProgress')}`}</small><div className="child-record-text">{record.text}</div></>}
    </article>)}</div>
    <div className="child-execution-actions">
      {page?.hasMore && page.nextBefore !== null && <button type="button" disabled={!connected || loading} onClick={() => { if (viewport.current) viewport.current.scrollTop = 0; setWindow(value => ({ before: page.nextBefore!, cursor: page.cursor, revision: value.revision + 1 })); }}>{t('execution.older')}</button>}
      <button type="button" disabled={!connected || loading} onClick={() => { if (viewport.current) viewport.current.scrollTop = 0; setWindow(value => ({ revision: value.revision + 1 })); }}>{t(older ? 'execution.latestReset' : 'execution.refresh')}</button>
    </div>
    <small>{t('execution.pagingHint')}</small>
  </section>;
}
