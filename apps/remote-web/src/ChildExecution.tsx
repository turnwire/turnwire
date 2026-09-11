import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { MessageBody, ToolHeading } from './MessagePresentation';
import { loadSubagentHistoryPage, type TurnwireClient } from '@turnwire/sdk';
import type { SubagentHistoryPage } from '@turnwire/protocol';
import { t, useLocale } from './i18n';

/** A bounded latest snapshot, refreshed without moving the reader's scroll position. */
interface ChildExecutionProps { client?: TurnwireClient; sessionId: string; subagentId: string; running: boolean; connected: boolean }
export function ChildExecution(props: ChildExecutionProps) {
  const identity = useRef({ client: props.client, sessionId: props.sessionId, subagentId: props.subagentId, generation: 0 });
  if (identity.current.client !== props.client || identity.current.sessionId !== props.sessionId || identity.current.subagentId !== props.subagentId) identity.current = { client: props.client, sessionId: props.sessionId, subagentId: props.subagentId, generation: identity.current.generation + 1 };
  return <ExecutionWindow key={identity.current.generation} {...props} />;
}
function ExecutionWindow({ client, sessionId, subagentId, running, connected }: ChildExecutionProps) {
  useLocale();
  const instanceId = useId();
  const [page, setPage] = useState<SubagentHistoryPage>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef(true);
  // Delegated prompts remain in source history, but aren't a child conversation participant.
  const records = page?.records.filter(record => record.role !== 'user');
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!pendingScroll.current || !records?.length || !element) return;
    // AgentStrip has one shared scroll container; inline readers scroll their own records.
    // Never scroll the conversation or document, and never reset a reader during polling.
    const list = element.closest<HTMLElement>('.agent-list');
    if (list) list.scrollTop += element.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom;
    else element.scrollTop = element.scrollHeight;
    pendingScroll.current = false;
  }, [page]);
  useEffect(() => {
    let active = true;
    let firstRead = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!client || !connected) { setLoading(false); return; }
    const load = async () => {
      if (firstRead) setLoading(true);
      try {
        const result = await loadSubagentHistoryPage(client, { sessionId, subagentId, limit: 50 });
        if (!active) return;
        setPage(result); setError('');
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally {
        if (active) {
          firstRead = false;
          setLoading(false);
          if (running) timer = setTimeout(() => void load(), 2000);
        }
      }
    };
    void load();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [client, sessionId, subagentId, running, connected, revision]);
  return <section className="child-execution" aria-label={t('execution.aria')}>
    {page?.hasMore && <small>{t('execution.latestOutput')}</small>}
    {!connected && <p role="status">{t('execution.offline')}</p>}
    {error && <p role="alert">{t(page ? 'execution.stale' : 'execution.loadError', { error })} <button type="button" disabled={!connected || loading} onClick={() => setRevision(value => value + 1)}>{t('execution.retry')}</button></p>}
    {loading && <p role="status">{t('execution.loading')}</p>}
    {records && !records.length && <p>{t('execution.empty')}</p>}
    <div className="child-records" ref={viewport}>{records?.map(record => <div key={record.id} className={`child-record child-${record.role}`} data-record-id={record.id}>
      {record.role === 'tool' ? <>
        <div className="child-tool-summary"><ToolHeading message={{ ...record, output: undefined, text: '' }} /><span className="tool-status">{t(record.isError ? 'tool.failed' : record.complete ? 'tool.returned' : running ? 'tool.running' : 'tool.noResult')}</span></div>
        {record.isError && <p className="child-tool-error">{record.output ?? record.text}</p>}
      </> : <>
        <MessageBody message={{ ...record, id: `${instanceId}-${record.id}` }} lead={false} streaming={!record.complete && running} />
        {!record.complete && !running && <span className="message-status">{t('tool.noResult')}</span>}
      </>}
    </div>)}</div>
  </section>;
}
