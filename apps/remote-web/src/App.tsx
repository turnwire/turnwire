import { Inbox } from './Inbox';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowUp, ArrowRight, Check, CircleNotch, Desktop, FolderSimple, GearSix, Laptop, List, Plus, ShieldCheck, Stop, TerminalWindow, X, Plug, ChatCircle, CaretRight } from '@phosphor-icons/react';
import { LocalClient, RemoteClient, applyEvent, conversation, decodePairing, encodePairing, loadHistoryPage, HistoryBuffer } from '@turnwire/sdk';
import type { ConnectionState, ConnectionHealth, ConversationMessage, TurnwireClient } from '@turnwire/sdk';
import type { TurnwireEvent, Session, SessionStatus, Snapshot, ModelCatalog, QueueItemView, SubagentView } from '@turnwire/protocol';
import { MarkdownMessage } from './MarkdownMessage';
import { shouldLoadEarlier } from './historyScroll';
import { t, useLocale, errorText, getLocale, setLocale, type MessageKey } from './i18n';

type Connection = { kind: 'local'; url: string; token: string } | { kind: 'remote'; code: string };
/** The agent strip stays a glanceable few lines even when a fan-out runs a dozen children. */
const MAX_AGENT_ROWS = 4;
const statusKeys: Record<SessionStatus, MessageKey> = { idle: 'status.idle', running: 'status.running', waiting_approval: 'status.waiting_approval', interrupted: 'status.interrupted', error: 'status.error' };
function loadConnection(): Connection | undefined {
  try {
    if (location.hash.startsWith('#pair=')) {
      const code = location.hash.slice(6); decodePairing(code);
      const connection: Connection = { kind: 'remote', code };
      // Keep a scanned pairing for this tab after removing the secret fragment.
      sessionStorage.setItem('turnwire.connection', JSON.stringify(connection));
      history.replaceState(null, '', location.pathname + location.search);
      return connection;
    }
    const saved = sessionStorage.getItem('turnwire.connection') ?? localStorage.getItem('turnwire.connection'); return saved ? JSON.parse(saved) as Connection : undefined;
  } catch { return undefined; }
}
function shortPath(path: string) { return path.split('/').filter(Boolean).slice(-2).join('/'); }
/** The chip shows the runtime's own name for the current model; the client never invents one. */
function modelChipLabel(session: Session, catalog?: { runtimeId: string; value: ModelCatalog }) {
  if (!session.model) return t('model.defaultModel');
  const entry = catalog?.value.groups.find(group => group.id === session.model!.provider)?.models.find(model => model.id === session.model!.model);
  return entry?.name ?? session.model.model;
}
function Status({ status }: { status: SessionStatus }) { const t = useLocale(); return <span className={`status ${status}`}><span />{t(statusKeys[status])}</span>; }
/** How long an agent has been working, rounded the way a person reads a stopwatch. */
function agentDuration(ms: number) { const seconds = Math.round(ms / 1000); return seconds < 60 ? t('agents.seconds', { value: seconds }) : t('agents.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 }); }
/** The step an agent is on, or how far its plan got; the plan is the progress it reports. */
function agentStep(agent: SubagentView) {
  const current = agent.todos.find(todo => todo.status === 'in_progress');
  const done = agent.todos.filter(todo => todo.status === 'completed').length;
  return current ? t('agents.current', { done, total: agent.todos.length, content: current.content }) : t('agents.steps', { done, total: agent.todos.length });
}
/** A compact EN/ZH switch; the manual choice is persisted so it survives a reload. */
function LocaleSwitch() {
  const t = useLocale();
  return <span className="locale-switch" role="group" aria-label={t('locale.label')}><button type="button" className={getLocale() === 'en' ? 'active' : ''} aria-pressed={getLocale() === 'en'} onClick={() => setLocale('en')}>{t('locale.englishShort')}</button><button type="button" className={getLocale() === 'zh' ? 'active' : ''} aria-pressed={getLocale() === 'zh'} onClick={() => setLocale('zh')}>{t('locale.chineseShort')}</button></span>;
}

export function App() {
  const t = useLocale();
  const [connection, setConnection] = useState(loadConnection);
  const [showInbox, setShowInbox] = useState(new URLSearchParams(location.search).has('inbox'));
  const [snapshot, setSnapshot] = useState<Snapshot>(); const [selected, setSelected] = useState<string>();
  const historyRef = useRef<{ sessionId: string; buffer: HistoryBuffer } | undefined>(undefined);
  const [before, setBefore] = useState<number | null>(null);
  const autoPages = useRef(0); const historyBusy = useRef(false);
  const [historyError, setHistoryError] = useState(false);
  const scroller = useRef<HTMLElement>(null); const follow = useRef(true); const prepend = useRef<{ height: number; top: number } | undefined>(undefined);
  const [events, setEvents] = useState<TurnwireEvent[]>([]); const [state, setState] = useState<ConnectionState>('offline');
  const [health, setHealth] = useState<ConnectionHealth>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false);
  const [showConnection, setShowConnection] = useState(!connection); const [drawer, setDrawer] = useState(false); const [create, setCreate] = useState(false);
  const [prompt, setPrompt] = useState(''); const [sessionSearch, setSessionSearch] = useState(''); const [showArchived, setShowArchived] = useState(false); const [renameTitle, setRenameTitle] = useState<string>(); const clientRef = useRef<TurnwireClient | undefined>(undefined); const bottom = useRef<HTMLDivElement>(null);
  const session = snapshot?.sessions.find(s => s.id === selected);
  const messages = useMemo(() => selected ? conversation(events, selected) : [], [events, selected]);
  const approvals = snapshot?.approvals.filter(a => a.sessionId === selected) ?? [];
  const runtime = snapshot?.runtimes.find(r => r.id === session?.runtimeId);
  // Model choice belongs to the runtime that owns the session, so the catalog is fetched per
  // runtime and only from a runtime that advertises the capability.
  const [catalog, setCatalog] = useState<{ runtimeId: string; value: ModelCatalog }>();
  // The picker stays collapsed behind a chip in the composer: a phone needs that space for the
  // conversation and the keyboard, so the control appears only when it is wanted.
  const [showModel, setShowModel] = useState(false);
  // Queued prompts are shown as their own list above the composer instead of inside the running
  // turn's flow. The list is the runtime's own queue, not this tab's memory of what it saw arrive:
  // a page that has just loaded, or one that was asleep while another client queued something, must
  // still show what is waiting.
  const [queue, setQueue] = useState<QueueItemView[]>([]);
  const turnRunning = ['running', 'waiting_approval'].includes(session?.status ?? '');
  const pending = useMemo(() => queue.map(item => ({ id: item.messageId, text: item.text })), [queue]);
  const visible = useMemo(() => pending.length ? messages.filter(message => !pending.some(item => item.id === message.id)) : messages, [messages, pending]);
  /**
   * Background agents the session has delegated to. A delegation returns at once, so the transcript
   * goes quiet while children work; this is the only place their progress shows. Polled while the
   * session runs, and once more when it settles so the last state is not left half-read.
   */
  const [agents, setAgents] = useState<SubagentView[]>([]);
  // Only the ones still working: a session that has delegated all day must not grow a panel of
  // finished children over the conversation. What finished is already in the transcript.
  const runningAgents = useMemo(() => agents.filter(agent => agent.activity === 'running'), [agents]);
  // A child can outlive the turn that started it, so the poll continues while one is running.
  const hasRunningAgent = runningAgents.length > 0;
  useEffect(() => {
    if (!selected || !session || session.archived || !clientRef.current) { setAgents([]); return; }
    let active = true;
    const load = async () => {
      try { const result = await clientRef.current!.request<{ subagents: SubagentView[] }>('subagent.list', { sessionId: selected }); if (active) setAgents(result.subagents); }
      catch { if (active) setAgents([]); }
    };
    void load();
    if (!turnRunning && !hasRunningAgent) return () => { active = false; };
    const timer = setInterval(load, 4000);
    return () => { active = false; clearInterval(timer); };
  }, [selected, session?.archived, session?.status, turnRunning, hasRunningAgent, state]);
  // A queued prompt can be reconsidered before it runs: rewritten, taken back, or pulled into the
  // turn that is already going. The row owns those actions, so nothing else in the page repeats them.
  const [editingQueued, setEditingQueued] = useState<string>();
  const [queuedDraft, setQueuedDraft] = useState('');
  const refreshQueue = useCallback(async (sessionId: string) => {
    const client = clientRef.current; if (!client) return;
    try { const result = await client.request<{ items: QueueItemView[] }>('session.queue', { sessionId }); setQueue(result.items); }
    catch { setQueue([]); }
  }, []);
  useEffect(() => {
    if (!selected || !session || session.archived || !clientRef.current) { setQueue([]); return; }
    void refreshQueue(selected);
    // A queued prompt is short-lived and can change from another client, so it is polled while the
    // turn runs and once more when it settles rather than trusted to a local guess.
    if (!turnRunning) return;
    const timer = setInterval(() => void refreshQueue(selected), 4000);
    return () => clearInterval(timer);
  }, [selected, session?.archived, session?.status, turnRunning, state, refreshQueue]);
  async function changeQueued(messageId: string, action: { kind: 'remove' | 'steer' } | { kind: 'edit'; text: string }) {
    if (!session) return;
    await perform(async c => { await c.request('session.queueAction', { sessionId: session.id, messageId, action }); });
    setEditingQueued(undefined);
    await refreshQueue(session.id);
  }
  /** Adjacent tool calls become one row; everything else renders on its own. */
  const rows = useMemo(() => {
    const output: Array<{ key: string; tools?: ConversationMessage[]; message?: ConversationMessage }> = [];
    for (const message of visible) {
      const last = output[output.length - 1];
      if (message.role === 'tool') { if (last?.tools) last.tools.push(message); else output.push({ key: message.id, tools: [message] }); }
      else output.push({ key: message.id, message });
    }
    return output;
  }, [visible]);
  const modelSupport = runtime?.capabilities.modelSelection === true;
  const effortOptions = catalog?.value.groups.find(group => group.id === session?.model?.provider)?.models.find(model => model.id === session?.model?.model)?.reasoning?.efforts ?? [];
  useEffect(() => {
    if (!runtime?.capabilities.modelSelection || catalog?.runtimeId === runtime.id) return;
    let active = true;
    void clientRef.current?.request<ModelCatalog>('model.catalog', { runtimeId: runtime.id })
      .then(value => { if (active) setCatalog({ runtimeId: runtime.id, value }); })
      .catch(() => { /* A runtime whose providers are unreachable simply offers no choices. */ });
    return () => { active = false; };
  }, [runtime, catalog]);
  /** The daemon records the resolved selection, so the request omits what the runtime may fill in. */
  /** Sending is always queueing; steering is the separate action that jumps the queue. */
  function submit(text: string, asSteer: boolean) {
    if (!session) return;
    const sessionId = session.id;
    void perform(async c => {
      await c.request('session.message', { sessionId, text, ...(asSteer ? { steer: true } : {}) });
      setPrompt('');
      // The prompt may have been accepted into the queue rather than run, so read the queue back
      // instead of assuming which of the two happened.
      await refreshQueue(sessionId);
    });
  }
  /** Each state sends its own constant, so what the reader sees is what the host is told. */
  function setDelegated(sessionId: string, enabled: boolean) { void perform(async c => { await c.request('session.autoApprove', { sessionId, enabled }); }); }
  function chooseModel(provider: string, model: string, reasoningEffort?: string) { void perform(async c => { await c.request('session.setModel', { sessionId: session!.id, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }); }); }
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key.toLowerCase() === 'n' && (event.metaKey || event.ctrlKey) && snapshot) { event.preventDefault(); setCreate(true); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [snapshot]);

  useEffect(() => {
    if (!connection) return;
    let active = true; let unsubscribe: (() => void) | undefined; let c: TurnwireClient;
    setError(''); setLoading(true);
    try { c = connection.kind === 'local' ? new LocalClient(connection.url, connection.token) : new RemoteClient(decodePairing(connection.code), { persistPairing: pairing => { const value = JSON.stringify({ kind: 'remote', code: encodePairing(pairing) }); const storage = localStorage.getItem('turnwire.connection') ? localStorage : sessionStorage; storage.setItem('turnwire.connection', value); } }); }
    catch (error) { setError(errorText(error)); setLoading(false); setShowConnection(true); return; }
    clientRef.current = c; setHealth(undefined);
    let flush: ReturnType<typeof setTimeout> | undefined; let pending: TurnwireEvent[] = [];
    let bootstrapping = false;
    const stopHealth = c instanceof RemoteClient ? c.observeConnection(value => { if (active) { setHealth(value); setState(value.phase === 'connected' ? 'connected' : value.phase === 'connecting' || value.phase === 'verifying' ? 'connecting' : 'offline'); if (value.phase === 'connected' && !unsubscribe && !bootstrapping) bootstrap(); } }) : undefined;
    function bootstrap() { if (bootstrapping || unsubscribe || !active) return; bootstrapping = true; void c.request<Snapshot>('system.snapshot').then(next => {
      if (!active) return;
      setError(''); setSnapshot(next); setSelected(current => next.sessions.some(s => s.id === current) ? current : next.sessions[0]?.id); setShowConnection(false); setLoading(false);
      let wasConnected = false;
      unsubscribe = c.subscribe(event => {
        if (!active) return;
        pending.push(event);
        // Narrow before the closure: the checker does not keep it inside the updater.
        const history = historyRef.current; const d = event.data;
        if (history && ('sessionId' in d ? d.sessionId : 'approval' in d ? d.approval.sessionId : undefined) === history.sessionId) history.buffer.apply(event);
        if (!flush) flush = setTimeout(() => {
          flush = undefined; const batch = pending; pending = [];
          setSnapshot(previous => previous ? batch.reduce(applyEvent, previous) : previous);
          if (historyRef.current) setEvents(historyRef.current.buffer.events);
          const failure = batch.find(e => e.data.type === 'session.error'); if (failure?.data.type === 'session.error') setError(failure.data.message);
        }, 50);
      }, nextState => {
        if (!active) return; setState(nextState);
        if (nextState === 'connected' && wasConnected) void c.request<Snapshot>('system.snapshot').then(value => { if (active) setSnapshot(previous => previous && previous.cursor > value.cursor ? previous : value); }).catch(() => {});
        if (nextState === 'connected') wasConnected = true;
      }, next.cursor);
    }).catch(error => { if (active) { setError(errorText(error)); setLoading(false); if (connection?.kind === 'local') setShowConnection(true);  } }).finally(() => { bootstrapping = false; }); }
    bootstrap();
    const resume = () => { if (c instanceof RemoteClient) { if (document.visibilityState === 'visible') c.resume(); else c.suspend(); } };
    const offline = () => { if (c instanceof RemoteClient) c.suspend(); };
    const network = (navigator as Navigator & { connection?: EventTarget }).connection;
    const notification = (event: MessageEvent) => { if (event.data?.type === 'turnwire.inbox') { setShowInbox(true); setShowConnection(false); resume(); } };
    navigator.serviceWorker?.addEventListener('message', notification);
    network?.addEventListener('change', resume); document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume); window.addEventListener('offline', offline); window.addEventListener('pageshow', resume);
    return () => { active = false;  if (flush) clearTimeout(flush); stopHealth?.(); navigator.serviceWorker?.removeEventListener('message', notification); network?.removeEventListener('change', resume); window.removeEventListener('offline', offline); window.removeEventListener('pageshow', resume); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume); unsubscribe?.(); c.close(); if (clientRef.current === c) clientRef.current = undefined; };
  }, [connection]);

  useEffect(() => {
    if (!selected || !clientRef.current) { historyRef.current = undefined; setEvents([]); return; }
    let active = true; const buffer = new HistoryBuffer(); historyRef.current = { sessionId: selected, buffer };
    setEvents([]); setBefore(null); setLoading(true); setHistoryError(false); setRenameTitle(undefined); follow.current = true; buffer.begin();
    autoPages.current = 0; historyBusy.current = false;
    void loadHistoryPage(clientRef.current, selected).then(page => {
      if (!active) return; buffer.merge(page, true); setEvents(buffer.events); setBefore(page.nextBefore); setLoading(false);
    }).catch(error => { if (active) { buffer.cancel(); setHistoryError(true); setError(errorText(error)); setLoading(false); } });
    return () => { active = false; };
  }, [selected, connection]);
  /** `auto` marks a load the reader triggered by holding the conversation at its oldest record. */
  async function earlier(auto = false) {
    const c = clientRef.current, history = historyRef.current; if (!c || !history || loading || historyBusy.current) return;
    const replace = historyError; history.buffer.begin(); historyBusy.current = true; setLoading(true);
    try {
      const page = await loadHistoryPage(c, history.sessionId, replace ? undefined : before ?? undefined);
      if (historyRef.current !== history) return;
      if (!replace && scroller.current) { follow.current = false; prepend.current = { height: scroller.current.scrollHeight, top: scroller.current.scrollTop }; }
      history.buffer.merge(page, replace); setEvents(history.buffer.events); setBefore(page.nextBefore); setHistoryError(false); if (auto) autoPages.current++;
    } catch (error) { if (historyRef.current === history) { history.buffer.cancel(); setError(errorText(error)); } }
    finally { if (historyRef.current === history) setLoading(false); historyBusy.current = false; }
  }
  useLayoutEffect(() => {
    if (prepend.current && scroller.current) { const old = prepend.current; scroller.current.scrollTop = old.top + scroller.current.scrollHeight - old.height; prepend.current = undefined; }
    else if (follow.current) bottom.current?.scrollIntoView({ block: 'end', behavior: 'instant' });
  }, [events, approvals.length]);
  async function perform(action: (c: TurnwireClient) => Promise<void>) { if (!clientRef.current) return; setBusy(true); setError(''); try { await action(clientRef.current); } catch (error) { setError(errorText(error)); } finally { setBusy(false); } }
  function saveConnection(value: Connection, remember: boolean) { localStorage.removeItem('turnwire.connection'); sessionStorage.removeItem('turnwire.connection'); (remember ? localStorage : sessionStorage).setItem('turnwire.connection', JSON.stringify(value)); setSnapshot(undefined); setSelected(undefined); setEvents([]); setState('connecting'); setConnection(value); }
  function disconnect() { clientRef.current?.close(); localStorage.removeItem('turnwire.connection'); sessionStorage.removeItem('turnwire.connection'); setConnection(undefined); setSnapshot(undefined); setSelected(undefined); setEvents([]); setShowConnection(true); setState('offline'); }
  async function checkConnection() { const c = clientRef.current; if (!(c instanceof RemoteClient)) return; setChecking(true); try { await c.checkConnection(); setError(''); } catch (error) { setError(errorText(error)); } finally { setChecking(false); } }
  const connected = state === 'connected';
  function rememberDevice() { const c = clientRef.current; if (c instanceof RemoteClient) { localStorage.setItem('turnwire.connection', JSON.stringify({ kind: 'remote', code: encodePairing(c.currentPairing) })); sessionStorage.removeItem('turnwire.connection'); } }
  return <div className="app">
    {drawer && <button className="scrim" aria-label={t('sidebar.closeSessionList')} onClick={() => setDrawer(false)} />}
    <aside className={`sidebar ${drawer ? 'visible' : ''}`}>
      <div className="brand"><img src="/icon.svg" width="30" height="30" alt="" /><span>turnwire<span className="brand-suffix">remote</span></span><button className="icon-button mobile-only" aria-label={t('sidebar.closeList')} onClick={() => setDrawer(false)}><X size={20} /></button></div>
      <button className="new-session" disabled={!snapshot} onClick={() => { setCreate(true); setDrawer(false); }}><Plus size={18} />{t('common.newSession')}<span>⌘ N</span></button>
      <button className="new-session" disabled={!snapshot} onClick={() => { setShowInbox(true); setShowConnection(false); setDrawer(false); }}>{t('sidebar.inbox')} <span>{snapshot?.approvals.length ?? 0}</span></button>
      <div className="session-filter"><input aria-label={t('sidebar.searchSessions')} placeholder={t('sidebar.searchPlaceholder')} value={sessionSearch} onChange={e => setSessionSearch(e.target.value)} /><label><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />{t('sidebar.archived')}</label></div>
      <div className="sidebar-label">{showArchived ? t('sidebar.archived') : t('sidebar.workSessions')}</div>
      <nav aria-label={t('sidebar.sessionList')} className="session-list">
        {snapshot?.sessions.filter(s => !!s.archived === showArchived && (!sessionSearch || (s.title + ' ' + s.cwd).toLocaleLowerCase().includes(sessionSearch.toLocaleLowerCase()))).map(s => <button key={s.id} className={`session-row ${selected === s.id ? 'selected' : ''}`} onClick={() => { setSelected(s.id); setShowInbox(false); setShowConnection(false); setDrawer(false); }} aria-current={selected === s.id ? 'page' : undefined}><ChatCircle size={17} /><span><strong>{s.title}</strong><small>{shortPath(s.cwd)}</small></span><span className={`session-dot ${s.status}`} aria-label={t(statusKeys[s.status])} /></button>)}
        {!snapshot?.sessions.length && <p className="sidebar-empty">{snapshot ? t('sidebar.emptyNoSession') : t('sidebar.emptyNoHost')}</p>}
      </nav>
      <div className="sidebar-bottom"><button className="device-row" onClick={() => { setShowConnection(true); setDrawer(false); }}><Desktop size={20} /><span><strong>{snapshot?.device.name ?? t('sidebar.connectHost')}</strong><small><i className={connected ? 'online' : ''} />{connected ? t('sidebar.connected') : state === 'connecting' ? t('sidebar.connecting') : t('sidebar.offline')}</small></span><GearSix size={17} /></button><div className="local-note"><ShieldCheck size={14} />{t('sidebar.localNote')}</div></div>
    </aside>
    <main>
      <header className="topbar"><button className="icon-button mobile-only" aria-label={t('topbar.openSessionList')} onClick={() => setDrawer(true)}><List size={22} /></button><div className="breadcrumb"><Laptop size={17} /><span>{snapshot?.device.name ?? 'Turnwire Remote'}</span><CaretRight size={12} /><strong>{showConnection ? t('topbar.deviceConnection') : showInbox ? t('topbar.inbox') : session?.title ?? t('topbar.workspace')}</strong></div><div className="topbar-right">{session && !showConnection && !showInbox && <>{session.autoApprove && <span className="auto-approve-chip" title={t('session.autoApproveHint')}>{t('session.autoApproveOn')}</span>}<Status status={session.status} /><details className="session-actions"><summary>{t('topbar.sessionActions')}</summary><div>{/* One control, stable across the state it switches: its label and payload both follow the state. */
          <button data-auto-approve={session.autoApprove ? 'on' : 'off'} disabled={!connected || busy || session.archived} onClick={() => void setDelegated(session.id, !session.autoApprove)}>{session.autoApprove ? t('session.autoApproveOff') : t('session.autoApprove')}</button>}<button disabled={!connected || busy} onClick={() => { setRenameTitle(session.title); }}>{t('topbar.rename')}</button>{renameTitle !== undefined && <form onSubmit={event => { event.preventDefault(); void perform(async c => { await c.request('session.rename', { sessionId: session.id, title: renameTitle }); setRenameTitle(undefined); }); }}><input aria-label={t('topbar.newSessionName')} value={renameTitle} onChange={event => setRenameTitle(event.target.value)} /><button disabled={busy || !renameTitle.trim()}>{t('topbar.saveName')}</button></form>}<button disabled={!connected || busy || ['running', 'waiting_approval'].includes(session.status)} onClick={() => void perform(async c => { await c.request('session.archive', { sessionId: session.id, archived: !session.archived }); })}>{session.archived ? t('common.unarchive') : t('topbar.archiveSession')}</button></div></details></>}<button className="icon-button" aria-label={t('topbar.connectionSettings')} onClick={() => setShowConnection(true)}><Plug size={19} /></button></div></header>
      {connection?.kind === 'remote' && <div className="connection-health" data-phase={health?.phase ?? 'connecting'} role="status"><div><strong>{health?.phase === 'connected' ? t('health.connectedTo', { host: snapshot?.device.name ?? t('health.host') }) : health?.message ?? t('health.connecting')}</strong><small>{health?.phase === 'connected' ? `${t('health.details', { latency: health.latencyMs ?? 0, time: health.lastVerifiedAt ? new Date(health.lastVerifiedAt).toLocaleTimeString() : '—', route: health.route === 'direct' ? t('health.routeDirect') : 'Relay' })}${health.protocol === 1 ? t('health.oldPairing') : ''}` : health?.retryInMs ? t('health.retry', { seconds: Math.ceil(health.retryInMs / 1000) }) : t('health.unconfirmed')}</small></div><button disabled={checking} onClick={() => void checkConnection()}>{checking ? t('health.connectingAction') : t('health.reconnectNow')}</button></div>}
      {error && <div role="alert" className="error-banner"><span>{error}</span><button className="icon-button" aria-label={t('error.dismiss')} onClick={() => setError('')}><X size={17} /></button></div>}
      {showConnection ? <ConnectionView initial={connection?.kind === 'remote' && clientRef.current instanceof RemoteClient ? { kind: 'remote', code: encodePairing(clientRef.current.currentPairing) } : connection} connecting={loading} connected={!!snapshot} onConnect={saveConnection} onDisconnect={disconnect} onBack={() => setShowConnection(false)} />
        : showInbox && clientRef.current ? <Inbox client={clientRef.current} cursor={snapshot?.cursor ?? 0} connected={connected} remember={rememberDevice} onOpen={id => { setSelected(id); setShowInbox(false); }} />
        : !session ? <div className="empty-workspace"><div className="empty-symbol"><TerminalWindow size={38} weight="light" /></div><span className="eyebrow">{t('empty.eyebrow')}</span><h1>{t('empty.title')}</h1><p>{t('empty.bodyLine1')}<br />{t('empty.bodyLine2')}</p><button className="primary" onClick={() => setCreate(true)} disabled={!snapshot}><Plus size={17} />{t('common.newSession')}</button></div>
        : <>
          <section className="conversation" aria-label={t('conversation.aria')} ref={scroller} onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (shouldLoadEarlier({ scrollTop: el.scrollTop, before, loading, failed: historyError, pages: autoPages.current })) void earlier(true); }}><div className="conversation-inner"><div className="session-heading"><span><FolderSimple size={16} />{shortPath(session.cwd)}</span><h1>{session.title}</h1><p>{runtime?.name ?? session.runtimeId}{session.runtimeId === 'demo' && t('conversation.demoNote')}</p></div>
            {(before !== null || historyError) && <button className="history-more" disabled={loading} onClick={() => void earlier()}>{loading ? t('conversation.loadingEarlier') : historyError ? t('conversation.retryEarlier') : t('conversation.loadEarlier')}</button>}
            {loading && !messages.length && <div className="loading"><CircleNotch className="spin" size={18} />{t('conversation.loading')}</div>}
            {!loading && !messages.length && <div className="conversation-empty"><ChatCircle size={26} weight="light" /><p>{t('conversation.readyLine1')}<br />{t('conversation.readyLine2')}</p></div>}
            {rows.map(row => row.tools ? <ToolRun key={row.key} items={row.tools} running={turnRunning} /> : <article className={`message ${row.message!.role}`} key={row.key}><div className="message-author">{row.message!.role === 'user' ? <><span className="avatar">{t('conversation.you')}</span>{t('conversation.you')}</> : <><img src="/icon.svg" width="23" height="23" alt="" />Turnwire</>}<time>{new Date(row.message!.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{row.message!.queued && <span className="queued-chip">{t('message.queuedChip')}</span>}{row.message!.steer && <span className="queued-chip">{t('message.steerChip')}</span>}</div><div className="message-text">{row.message!.role === 'assistant' ? <MarkdownMessage text={row.message!.text} id={row.message!.id} /> : row.message!.text}{!row.message!.complete && <span className="cursor" />}</div></article>)}
            <div ref={bottom} /></div></section>
          <footer className="composer-area"><div className="composer-width">{session.archived && <div className="resume-row"><span>{t('session.archivedRow')}</span><button disabled={!connected || busy} onClick={() => void perform(async c => { await c.request('session.archive', { sessionId: session.id, archived: false }); })}>{t('common.unarchive')}</button></div>}
            {approvals.map(approval => <section key={approval.id} className="approval-panel" aria-label={t('approval.panelAria')}><div className="approval-title"><ShieldCheck size={20} /><strong>{t('approval.needed')}</strong><span>{session.autoApprove ? t('approval.autoOn') : t('approval.once')}</span></div><code>{approval.tool}</code><p>{approval.reason}</p><div className="approval-actions"><button disabled={busy || !connected} onClick={() => void perform(async c => { await c.request('approval.decide', { approvalId: approval.id, decision: 'rejected' }); })}><X size={16} />{t('common.reject')}</button><button className="primary" disabled={busy || !connected} onClick={() => void perform(async c => { await c.request('approval.decide', { approvalId: approval.id, decision: 'approved' }); })}><Check size={16} />{t('common.approveOnce')}</button></div></section>)}
            {!session.archived && (session.status === 'interrupted' || session.status === 'error') && <div className="resume-row"><span>{t('session.resumeHint')}</span><button disabled={busy || !connected} onClick={() => void perform(async c => { await c.request('session.resume', { sessionId: session.id }); })}>{t('session.resume')}<ArrowRight size={15} /></button></div>}
            
          {modelSupport && showModel && <div className="model-picker composer-model">{catalog?.runtimeId === runtime?.id ? <><label>{t('model.label')}<select aria-label={t('model.label')} value={session.model ? `${session.model.provider}/${session.model.model}` : ''} disabled={!connected || busy || session.archived} onChange={event => { const [provider, model] = event.target.value.split('/'); if (provider && model) chooseModel(provider, model, session.model?.reasoningEffort); }}>{!session.model && <option value="">{t('model.runtimeDefaultNamed', { provider: catalog.value.default.provider, model: catalog.value.default.model })}</option>}{catalog.value.groups.map(group => <optgroup key={group.id} label={group.name}>{group.models.map(model => <option key={model.id} value={`${group.id}/${model.id}`}>{model.name}{catalog.value.routableProviders.includes(group.id) ? '' : t('model.unavailableSuffix')}</option>)}</optgroup>)}</select></label>{session.model && effortOptions.length > 0 && <label>{t('model.reasoningEffort')}<select aria-label={t('model.reasoningEffort')} value={session.model.reasoningEffort ?? ''} disabled={!connected || busy || session.archived} onChange={event => chooseModel(session.model!.provider, session.model!.model, event.target.value || undefined)}>{!session.model.reasoningEffort && <option value="">{t('model.runtimeDefault')}</option>}{effortOptions.map(effort => <option key={effort.id} value={effort.id}>{effort.name}{effort.id === catalog.value.groups.find(group => group.id === session.model?.provider)?.models.find(model => model.id === session.model?.model)?.reasoning?.defaultEffort ? t('model.defaultSuffix') : ''}</option>)}</select></label>}</> : <span className="model-loading">{t('model.loadingCatalog')}</span>}{catalog?.runtimeId === runtime?.id && catalog.value.failures.length > 0 && <span className="model-loading">{catalog.value.failures.map(failure => t('model.unavailable', { name: failure.name })).join(t('common.listSeparator'))}</span>}</div>}
          {runningAgents.length > 0 && <div className="agent-strip" role="status" aria-label={t('agents.aria')}><div className="agent-heading">{t('agents.running', { count: runningAgents.length })}</div>{runningAgents.slice(0, MAX_AGENT_ROWS).map(agent => <div className="agent-item" key={agent.id}><span className="agent-dot" /><span className="agent-label">{agent.label}</span>{agent.elapsedMs !== undefined && <span className="agent-time">{agentDuration(agent.elapsedMs)}</span>}{agent.todos.length > 0 && <span className="agent-steps">{agentStep(agent)}</span>}</div>)}{runningAgents.length > MAX_AGENT_ROWS && <div className="agent-more">{t('agents.more', { count: runningAgents.length - MAX_AGENT_ROWS })}</div>}</div>}
          {pending.length > 0 && <div className="queued-strip" role="status" aria-label={t('queue.aria')}>{pending.map(item => <div className="queued-item" key={item.id}>{editingQueued === item.id ? <input className="queued-edit" aria-label={t('queue.editLabel')} value={queuedDraft} autoFocus onChange={event => setQueuedDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (queuedDraft.trim()) void changeQueued(item.id, { kind: 'edit', text: queuedDraft.trim() }); } if (event.key === 'Escape') setEditingQueued(undefined); }} /> : <span className="queued-text" title={item.text}>{item.text}</span>}<span className="queued-buttons">{editingQueued === item.id ? <button type="button" disabled={!connected || busy || !queuedDraft.trim()} onClick={() => void changeQueued(item.id, { kind: 'edit', text: queuedDraft.trim() })}>{t('queue.save')}</button> : <button type="button" disabled={!connected || busy} onClick={() => { setEditingQueued(item.id); setQueuedDraft(item.text); }}>{t('queue.edit')}</button>}<button type="button" disabled={!connected || busy} onClick={() => void changeQueued(item.id, { kind: 'remove' })}>{t('queue.remove')}</button><button type="button" disabled={!connected || busy} onClick={() => void changeQueued(item.id, { kind: 'steer' })}>{t('queue.steer')}</button></span></div>)}</div>}
          <form className="composer" onSubmit={event => { event.preventDefault(); if (!prompt.trim()) return; submit(prompt, false); }}>
              <textarea aria-label={t('composer.messageAria')} placeholder={t('composer.placeholder')} value={prompt} onChange={event => setPrompt(event.target.value)} rows={2} disabled={!connected || session.archived || ['interrupted', 'error'].includes(session.status)} onKeyDown={event => { if (event.key !== 'Enter') return; if (event.altKey) { event.preventDefault(); submit(prompt, true); } else if (event.metaKey || event.ctrlKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
              <div className="composer-bottom"><span><FolderSimple size={14} />{shortPath(session.cwd)}</span><div>{modelSupport && <button type="button" className="model-chip" aria-label={t('composer.chooseModel')} aria-expanded={showModel} disabled={!connected || session.archived} onClick={() => setShowModel(value => !value)}>{modelChipLabel(session, catalog)}</button>}{['running', 'waiting_approval'].includes(session.status) && <button className="stop-button" type="button" aria-label={t('composer.stopTask')} disabled={!connected} onClick={() => void perform(async c => { await c.request('session.cancel', { sessionId: session.id }); })}><Stop size={13} weight="fill" />{t('composer.stop')}</button>}<button className="send-button" type="submit" aria-label={t('composer.send')} disabled={busy || !connected || session.archived || !prompt.trim() || ['interrupted', 'error'].includes(session.status)}>{busy ? <CircleNotch className="spin" size={18} /> : <ArrowUp size={20} />}</button></div></div>
            </form><div className="composer-caption"><LocaleSwitch /><span><ShieldCheck size={12} />{connection?.kind === 'remote' ? t('composer.encrypted') : t('composer.local')}</span><span>{connected ? t('composer.shared') : t('composer.disconnected')}</span></div>
          </div></footer>
        </>}
    </main>
    {create && snapshot && <CreateSession snapshot={snapshot} busy={busy} close={() => setCreate(false)} onCreate={(cwd, title, runtimeId) => void perform(async c => { const s = await c.request<Session>('session.create', { cwd, title, runtimeId }); setSnapshot(previous => previous ? { ...previous, sessions: [s, ...previous.sessions.filter(p => p.id !== s.id)] } : previous); setSelected(s.id); setShowConnection(false); setCreate(false); })} />}
  </div>;
}

function ConnectionView({ initial, connecting, connected, onConnect, onDisconnect, onBack }: { initial?: Connection; connecting: boolean; connected: boolean; onConnect: (c: Connection, remember: boolean) => void; onDisconnect: () => void; onBack: () => void }) {
  const t = useLocale();
  const [kind, setKind] = useState<'local' | 'remote'>(initial?.kind ?? 'remote'); const [url, setUrl] = useState(initial?.kind === 'local' ? initial.url : 'http://127.0.0.1:9898');
  const [token, setToken] = useState(initial?.kind === 'local' ? initial.token : ''); const [code, setCode] = useState(initial?.kind === 'remote' ? initial.code : ''); const [remember, setRemember] = useState(false);
  return <section className="connection-view"><div className="connection-intro"><div className="connection-symbol"><Laptop size={38} weight="light" /><span /><ChatCircle size={28} weight="light" /></div><span className="eyebrow">{t('connection.eyebrow')}</span><h1>{t('connection.title')}</h1><p>{t('connection.bodyLine1')}<br />{t('connection.bodyLine2')}</p><div className="connection-facts"><div><ShieldCheck size={18} /><span>{t('connection.factPermissions')}</span></div><div><TerminalWindow size={18} /><span>{t('connection.factLocal')}</span></div></div></div><form className="connection-form" onSubmit={(event: FormEvent) => { event.preventDefault(); onConnect(kind === 'local' ? { kind, url, token } : { kind, code }, remember); }}><h2>{t('connection.connectDevice')}</h2><div className="segmented"><button type="button" className={kind === 'remote' ? 'active' : ''} onClick={() => setKind('remote')}>{t('connection.remotePairing')}</button><button type="button" className={kind === 'local' ? 'active' : ''} onClick={() => setKind('local')}>{t('connection.localPairing')}</button></div>{kind === 'remote' ? <><label>{t('connection.pairingCode')}<textarea required value={code} onChange={e => setCode(e.target.value)} placeholder={t('connection.pairingPlaceholder')} rows={4} /></label><p className="field-help">{t('connection.pairingHelpBefore')}<code>turnwire devices pair</code>{t('connection.pairingHelpAfter')}</p></> : <><label>{t('connection.hostUrl')}<input type="url" required value={url} onChange={e => setUrl(e.target.value)} /></label><label>{t('connection.token')}<input type="password" required value={token} onChange={e => setToken(e.target.value)} autoComplete="off" placeholder={t('connection.tokenPlaceholder')} /></label><p className="field-help">{t('connection.connectHelpBefore')}<code>turnwire connect</code>{t('connection.connectHelpAfter')}</p></>}<label className="remember"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />{t('connection.remember')}</label><button className="primary wide" disabled={connecting}>{connecting ? <CircleNotch size={18} className="spin" /> : <Plug size={18} />}{connecting ? t('connection.connecting') : t('connection.connect')}<ArrowRight size={17} /></button>{connected && <div className="connection-actions"><button type="button" onClick={onBack}>{t('connection.back')}</button><button type="button" onClick={onDisconnect}>{t('connection.disconnect')}</button></div>}</form></section>;
}

/** A subagent call carries a description; showing it beats printing the whole prompt as the title. */
function toolName(message: ConversationMessage) {
  if (message.tool !== 'subagent' || !message.input) return message.tool;
  try {
    const parsed = JSON.parse(message.input) as { description?: string };
    return parsed.description ? t('tool.subagent', { description: parsed.description }) : message.tool;
  } catch { return message.tool; }
}

/** One tool call: a quiet line until someone opens it. */
function ToolCall({ message }: { message: ConversationMessage }) {
  const t = useLocale();
  return <details className="tool-message"><summary><TerminalWindow size={13} /><span>{toolName(message)}</span><span className="tool-status">{message.isError ? t('tool.failed') : message.complete ? t('tool.returned') : t('tool.running')}</span><CaretRight size={11} className="tool-caret" /></summary>{message.input !== undefined && <><strong>{t('tool.input')}</strong><pre>{message.input}</pre></>}{message.output !== undefined && <><strong>{t('tool.output')}</strong><pre>{message.output}</pre></>}</details>;
}

/**
 * Consecutive tool calls read as one line and open into the calls themselves: a turn that runs ten
 * tools should not look like ten blocks of content.
 */
function ToolRun({ items, running }: { items: ConversationMessage[]; running: boolean }) {
  const t = useLocale();
  if (items.length === 1) return <ToolCall message={items[0]!} />;
  const tools = [...new Set(items.map(item => item.tool ?? t('tool.tool')))];
  const failures = items.filter(item => item.isError).length;
  const label = tools.length === 1 && tools[0] === 'subagent' ? t('tool.subagentCount', { count: items.length }) : tools.length === 1 ? t('tool.namedCount', { tool: tools[0] ?? '', count: items.length }) : t('tool.manyItems', { tool: tools[0] ?? '', count: items.length });
  const status = failures ? t('tool.failures', { count: failures }) : items.every(item => item.complete) ? t('tool.allReturned') : running ? t('tool.running') : t('tool.noResult');
  return <details className="tool-group"><summary><TerminalWindow size={13} /><span>{label}</span><span className="tool-status">{status}</span><CaretRight size={11} className="tool-caret" /></summary><div className="tool-group-items">{items.map(item => <ToolCall key={item.id} message={item} />)}</div></details>;
}

function CreateSession({ snapshot, busy, close, onCreate }: { snapshot: Snapshot; busy: boolean; close: () => void; onCreate: (cwd: string, title: string, runtimeId: string) => void }) {
  const t = useLocale();
  const ref = useRef<HTMLDialogElement>(null); const [cwd, setCwd] = useState(snapshot.sessions[0]?.cwd ?? ''); const [title, setTitle] = useState(''); const [runtimeId, setRuntime] = useState(snapshot.runtimes[0]?.id ?? 'dsh');
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} onCancel={close} aria-labelledby="new-title"><form onSubmit={e => { e.preventDefault(); onCreate(cwd, title, runtimeId); }}><div className="dialog-heading"><h2 id="new-title">{t('common.newSession')}</h2><button type="button" className="icon-button" onClick={close} aria-label={t('common.close')}><X size={20} /></button></div><p>{t('create.intro')}</p><label>{t('create.name')}<input autoFocus required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder={t('create.namePlaceholder')} /></label><label>{t('create.cwd')}<input required value={cwd} onChange={e => setCwd(e.target.value)} placeholder="/absolute/path/to/project" /></label><label>{t('create.runtime')}<select value={runtimeId} onChange={e => setRuntime(e.target.value)}>{snapshot.runtimes.map(runtime => <option key={runtime.id} value={runtime.id} disabled={!runtime.online}>{runtime.name}{!runtime.online ? t('create.runtimeOffline') : ''}</option>)}</select></label>{!snapshot.runtimes.some(r => r.online) && <p role="status">{t('create.noRuntime')}</p>}<div className="dialog-actions"><button type="button" onClick={close}>{t('common.cancel')}</button><button className="primary" disabled={busy || !snapshot.runtimes.some(r => r.id === runtimeId && r.online)}>{busy ? t('create.creating') : t('create.create')}<ArrowRight size={16} /></button></div></form></dialog>;
}
