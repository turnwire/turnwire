import { Inbox } from './Inbox';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowUp, ArrowRight, Check, CircleNotch, Desktop, FolderSimple, GearSix, Laptop, List, Plus, ShieldCheck, Stop, TerminalWindow, X, Plug, ChatCircle, CaretRight } from '@phosphor-icons/react';
import { LocalClient, RemoteClient, applyEvent, conversation, decodePairing, encodePairing, loadHistoryPage, HistoryBuffer } from '@turnwire/sdk';
import type { ConnectionState, ConnectionHealth, TurnwireClient } from '@turnwire/sdk';
import type { TurnwireEvent, Session, SessionStatus, Snapshot, ModelCatalog } from '@turnwire/protocol';
import { MarkdownMessage } from './MarkdownMessage';
import { shouldLoadEarlier } from './historyScroll';

type Connection = { kind: 'local'; url: string; token: string } | { kind: 'remote'; code: string };
const labels: Record<SessionStatus, string> = { idle: '就绪', running: '进行中', waiting_approval: '等待审批', interrupted: '已中断', error: '需要处理' };
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
function Status({ status }: { status: SessionStatus }) { return <span className={`status ${status}`}><span />{labels[status]}</span>; }

export function App() {
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
  function chooseModel(provider: string, model: string, reasoningEffort?: string) { void perform(async c => { await c.request('session.setModel', { sessionId: session!.id, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }); }); }
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key.toLowerCase() === 'n' && (event.metaKey || event.ctrlKey) && snapshot) { event.preventDefault(); setCreate(true); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [snapshot]);

  useEffect(() => {
    if (!connection) return;
    let active = true; let unsubscribe: (() => void) | undefined; let c: TurnwireClient;
    setError(''); setLoading(true);
    try { c = connection.kind === 'local' ? new LocalClient(connection.url, connection.token) : new RemoteClient(decodePairing(connection.code), { persistPairing: pairing => { const value = JSON.stringify({ kind: 'remote', code: encodePairing(pairing) }); const storage = localStorage.getItem('turnwire.connection') ? localStorage : sessionStorage; storage.setItem('turnwire.connection', value); } }); }
    catch (error) { setError(String(error)); setLoading(false); setShowConnection(true); return; }
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
    }).catch(error => { if (active) { setError(error instanceof Error ? error.message : String(error)); setLoading(false); if (connection?.kind === 'local') setShowConnection(true);  } }).finally(() => { bootstrapping = false; }); }
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
    }).catch(error => { if (active) { buffer.cancel(); setHistoryError(true); setError(String(error)); setLoading(false); } });
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
    } catch (error) { if (historyRef.current === history) { history.buffer.cancel(); setError(String(error)); } }
    finally { if (historyRef.current === history) setLoading(false); historyBusy.current = false; }
  }
  useLayoutEffect(() => {
    if (prepend.current && scroller.current) { const old = prepend.current; scroller.current.scrollTop = old.top + scroller.current.scrollHeight - old.height; prepend.current = undefined; }
    else if (follow.current) bottom.current?.scrollIntoView({ block: 'end', behavior: 'instant' });
  }, [events, approvals.length]);
  async function perform(action: (c: TurnwireClient) => Promise<void>) { if (!clientRef.current) return; setBusy(true); setError(''); try { await action(clientRef.current); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }
  function saveConnection(value: Connection, remember: boolean) { localStorage.removeItem('turnwire.connection'); sessionStorage.removeItem('turnwire.connection'); (remember ? localStorage : sessionStorage).setItem('turnwire.connection', JSON.stringify(value)); setSnapshot(undefined); setSelected(undefined); setEvents([]); setState('connecting'); setConnection(value); }
  function disconnect() { clientRef.current?.close(); localStorage.removeItem('turnwire.connection'); sessionStorage.removeItem('turnwire.connection'); setConnection(undefined); setSnapshot(undefined); setSelected(undefined); setEvents([]); setShowConnection(true); setState('offline'); }
  async function checkConnection() { const c = clientRef.current; if (!(c instanceof RemoteClient)) return; setChecking(true); try { await c.checkConnection(); setError(''); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setChecking(false); } }
  const connected = state === 'connected';
  function rememberDevice() { const c = clientRef.current; if (c instanceof RemoteClient) { localStorage.setItem('turnwire.connection', JSON.stringify({ kind: 'remote', code: encodePairing(c.currentPairing) })); sessionStorage.removeItem('turnwire.connection'); } }
  return <div className="app">
    {drawer && <button className="scrim" aria-label="关闭会话列表" onClick={() => setDrawer(false)} />}
    <aside className={`sidebar ${drawer ? 'visible' : ''}`}>
      <div className="brand"><img src="/icon.svg" width="30" height="30" alt="" /><span>turnwire<span className="brand-suffix">remote</span></span><button className="icon-button mobile-only" aria-label="关闭列表" onClick={() => setDrawer(false)}><X size={20} /></button></div>
      <button className="new-session" disabled={!snapshot} onClick={() => { setCreate(true); setDrawer(false); }}><Plus size={18} />新建会话<span>⌘ N</span></button>
      <button className="new-session" disabled={!snapshot} onClick={() => { setShowInbox(true); setShowConnection(false); setDrawer(false); }}>收件箱 <span>{snapshot?.approvals.length ?? 0}</span></button>
      <div className="session-filter"><input aria-label="搜索会话" placeholder="搜索会话或工作目录" value={sessionSearch} onChange={e => setSessionSearch(e.target.value)} /><label><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />已归档</label></div>
      <div className="sidebar-label">{showArchived ? '已归档' : '工作会话'}</div>
      <nav aria-label="会话列表" className="session-list">
        {snapshot?.sessions.filter(s => !!s.archived === showArchived && (!sessionSearch || (s.title + ' ' + s.cwd).toLocaleLowerCase().includes(sessionSearch.toLocaleLowerCase()))).map(s => <button key={s.id} className={`session-row ${selected === s.id ? 'selected' : ''}`} onClick={() => { setSelected(s.id); setShowInbox(false); setShowConnection(false); setDrawer(false); }} aria-current={selected === s.id ? 'page' : undefined}><ChatCircle size={17} /><span><strong>{s.title}</strong><small>{shortPath(s.cwd)}</small></span><span className={`session-dot ${s.status}`} aria-label={labels[s.status]} /></button>)}
        {!snapshot?.sessions.length && <p className="sidebar-empty">{snapshot ? '新建一个会话，开始工作。' : '连接主机后，工作会话会显示在这里。'}</p>}
      </nav>
      <div className="sidebar-bottom"><button className="device-row" onClick={() => { setShowConnection(true); setDrawer(false); }}><Desktop size={20} /><span><strong>{snapshot?.device.name ?? '连接你的主机'}</strong><small><i className={connected ? 'online' : ''} />{connected ? '已连接' : state === 'connecting' ? '连接中' : '离线'}</small></span><GearSix size={17} /></button><div className="local-note"><ShieldCheck size={14} />任务在你的主机上运行</div></div>
    </aside>
    <main>
      <header className="topbar"><button className="icon-button mobile-only" aria-label="打开会话列表" onClick={() => setDrawer(true)}><List size={22} /></button><div className="breadcrumb"><Laptop size={17} /><span>{snapshot?.device.name ?? 'Turnwire Remote'}</span><CaretRight size={12} /><strong>{showConnection ? '设备连接' : showInbox ? '收件箱' : session?.title ?? '工作空间'}</strong></div><div className="topbar-right">{session && !showConnection && !showInbox && <><Status status={session.status} /><details className="session-actions"><summary>会话操作</summary><div><button disabled={!connected || busy} onClick={() => { setRenameTitle(session.title); }}>重命名</button>{renameTitle !== undefined && <form onSubmit={event => { event.preventDefault(); void perform(async c => { await c.request('session.rename', { sessionId: session.id, title: renameTitle }); setRenameTitle(undefined); }); }}><input aria-label="新的会话名称" value={renameTitle} onChange={event => setRenameTitle(event.target.value)} /><button disabled={busy || !renameTitle.trim()}>保存名称</button></form>}<button disabled={!connected || busy || ['running', 'waiting_approval'].includes(session.status)} onClick={() => void perform(async c => { await c.request('session.archive', { sessionId: session.id, archived: !session.archived }); })}>{session.archived ? '取消归档' : '归档会话'}</button></div></details></>}<button className="icon-button" aria-label="连接设置" onClick={() => setShowConnection(true)}><Plug size={19} /></button></div></header>
      {connection?.kind === 'remote' && <div className="connection-health" data-phase={health?.phase ?? 'connecting'} role="status"><div><strong>{health?.phase === 'connected' ? `已连接到 ${snapshot?.device.name ?? '主机'}` : health?.message ?? '正在连接主机…'}</strong><small>{health?.phase === 'connected' ? `往返 ${health.latencyMs ?? 0} ms · 最近确认 ${health.lastVerifiedAt ? new Date(health.lastVerifiedAt).toLocaleTimeString() : '—'} · ${health.route === 'direct' ? '局域网直连' : 'Relay'}${health.protocol === 1 ? ' · 旧配对，可在主机升级' : ''}` : health?.retryInMs ? `约 ${Math.ceil(health.retryInMs / 1000)} 秒后重试；可点按钮立即重连。` : '收到主机的加密确认后才会显示已连接。'}</small></div><button disabled={checking} onClick={() => void checkConnection()}>{checking ? '连接中…' : '立即重连'}</button></div>}
      {error && <div role="alert" className="error-banner"><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={17} /></button></div>}
      {showConnection ? <ConnectionView initial={connection?.kind === 'remote' && clientRef.current instanceof RemoteClient ? { kind: 'remote', code: encodePairing(clientRef.current.currentPairing) } : connection} connecting={loading} connected={!!snapshot} onConnect={saveConnection} onDisconnect={disconnect} onBack={() => setShowConnection(false)} />
        : showInbox && clientRef.current ? <Inbox client={clientRef.current} cursor={snapshot?.cursor ?? 0} connected={connected} remember={rememberDevice} onOpen={id => { setSelected(id); setShowInbox(false); }} />
        : !session ? <div className="empty-workspace"><div className="empty-symbol"><TerminalWindow size={38} weight="light" /></div><span className="eyebrow">一个会话，随处接续</span><h1>工作从这里开始。</h1><p>在主机上运行 Agent，<br />在这里查看进度、补充想法和处理审批。</p><button className="primary" onClick={() => setCreate(true)} disabled={!snapshot}><Plus size={17} />新建会话</button></div>
        : <>
          <section className="conversation" aria-label="会话内容" ref={scroller} onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (shouldLoadEarlier({ scrollTop: el.scrollTop, before, loading, failed: historyError, pages: autoPages.current })) void earlier(true); }}><div className="conversation-inner"><div className="session-heading"><span><FolderSimple size={16} />{shortPath(session.cwd)}</span><h1>{session.title}</h1><p>{runtime?.name ?? session.runtimeId}{session.runtimeId === 'demo' && ' · 不执行真实代码'}</p></div>
            {(before !== null || historyError) && <button className="history-more" disabled={loading} onClick={() => void earlier()}>{loading ? '正在读取更早记录…' : historyError ? '重试加载记录' : '加载更早记录'}</button>}
            {loading && !messages.length && <div className="loading"><CircleNotch className="spin" size={18} />正在读取会话…</div>}
            {!loading && !messages.length && <div className="conversation-empty"><ChatCircle size={26} weight="light" /><p>这个会话准备好了。<br />告诉 Agent 你想完成什么。</p></div>}
            {messages.map(message => message.role === 'tool' ? <details className="tool-message" key={message.id}><summary><TerminalWindow size={16} /><span>{message.tool}</span><span>{message.isError ? '失败' : message.complete ? '已返回' : ['running', 'waiting_approval'].includes(session.status) ? '执行中' : '未收到结果'}</span></summary>{message.input !== undefined && <><strong>输入参数</strong><pre>{message.input}</pre></>}{message.output !== undefined && <><strong>返回结果</strong><pre>{message.output}</pre></>}</details> : <article className={`message ${message.role}`} key={message.id}><div className="message-author">{message.role === 'user' ? <><span className="avatar">你</span>你</> : <><img src="/icon.svg" width="23" height="23" alt="" />Turnwire</>}<time>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><div className="message-text">{message.role === 'assistant' ? <MarkdownMessage text={message.text} id={message.id} /> : message.text}{!message.complete && <span className="cursor" />}</div></article>)}
            <div ref={bottom} /></div></section>
          <footer className="composer-area"><div className="composer-width">{session.archived && <div className="resume-row"><span>会话已归档，历史记录仍可查看。</span><button disabled={!connected || busy} onClick={() => void perform(async c => { await c.request('session.archive', { sessionId: session.id, archived: false }); })}>取消归档</button></div>}
            {approvals.map(approval => <section key={approval.id} className="approval-panel" aria-label="待审批操作"><div className="approval-title"><ShieldCheck size={20} /><strong>需要你的批准</strong><span>仅本次</span></div><code>{approval.tool}</code><p>{approval.reason}</p><div className="approval-actions"><button disabled={busy || !connected} onClick={() => void perform(async c => { await c.request('approval.decide', { approvalId: approval.id, decision: 'rejected' }); })}><X size={16} />拒绝</button><button className="primary" disabled={busy || !connected} onClick={() => void perform(async c => { await c.request('approval.decide', { approvalId: approval.id, decision: 'approved' }); })}><Check size={16} />批准本次</button></div></section>)}
            {!session.archived && (session.status === 'interrupted' || session.status === 'error') && <div className="resume-row"><span>恢复会话后继续工作。</span><button disabled={busy || !connected} onClick={() => void perform(async c => { await c.request('session.resume', { sessionId: session.id }); })}>恢复会话<ArrowRight size={15} /></button></div>}
            
          {modelSupport && <div className="model-picker composer-model">{catalog?.runtimeId === runtime?.id ? <><label>模型<select aria-label="模型" value={session.model ? `${session.model.provider}/${session.model.model}` : ''} disabled={!connected || busy || session.archived} onChange={event => { const [provider, model] = event.target.value.split('/'); if (provider && model) chooseModel(provider, model, session.model?.reasoningEffort); }}>{!session.model && <option value="">运行时默认（{catalog.value.default.provider}/{catalog.value.default.model}）</option>}{catalog.value.groups.map(group => <optgroup key={group.id} label={group.name}>{group.models.map(model => <option key={model.id} value={`${group.id}/${model.id}`}>{model.name}{catalog.value.routableProviders.includes(group.id) ? '' : ' · 当前不可用'}</option>)}</optgroup>)}</select></label>{session.model && effortOptions.length > 0 && <label>思考强度<select aria-label="思考强度" value={session.model.reasoningEffort ?? ''} disabled={!connected || busy || session.archived} onChange={event => chooseModel(session.model!.provider, session.model!.model, event.target.value || undefined)}>{!session.model.reasoningEffort && <option value="">运行时默认</option>}{effortOptions.map(effort => <option key={effort.id} value={effort.id}>{effort.name}{effort.id === catalog.value.groups.find(group => group.id === session.model?.provider)?.models.find(model => model.id === session.model?.model)?.reasoning?.defaultEffort ? '（默认）' : ''}</option>)}</select></label>}</> : <span className="model-loading">正在读取模型目录…</span>}{catalog?.runtimeId === runtime?.id && catalog.value.failures.length > 0 && <span className="model-loading">{catalog.value.failures.map(failure => `${failure.name} 不可用`).join('、')}</span>}</div>}
          <form className="composer" onSubmit={event => { event.preventDefault(); if (!prompt.trim()) return; const text = prompt; void perform(async c => { await c.request('session.message', { sessionId: session.id, text }); setPrompt(''); }); }}>
              <textarea aria-label="消息" placeholder="描述任务，或补充下一步想法…" value={prompt} onChange={event => setPrompt(event.target.value)} rows={2} disabled={!connected || session.archived || ['interrupted', 'error'].includes(session.status)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
              <div className="composer-bottom"><span><FolderSimple size={14} />{shortPath(session.cwd)}</span><div>{['running', 'waiting_approval'].includes(session.status) && <button className="stop-button" type="button" aria-label="停止任务" disabled={!connected} onClick={() => void perform(async c => { await c.request('session.cancel', { sessionId: session.id }); })}><Stop size={13} weight="fill" />停止</button>}<button className="send-button" type="submit" aria-label="发送消息" disabled={busy || !connected || session.archived || !prompt.trim() || ['interrupted', 'error'].includes(session.status)}>{busy ? <CircleNotch className="spin" size={18} /> : <ArrowUp size={20} />}</button></div></div>
            </form><div className="composer-caption"><span><ShieldCheck size={12} />{connection?.kind === 'remote' ? '设备间加密连接' : '本机连接'}</span><span>{connected ? '所有客户端共享当前会话' : '连接已断开，正在重连'}</span></div>
          </div></footer>
        </>}
    </main>
    {create && snapshot && <CreateSession snapshot={snapshot} busy={busy} close={() => setCreate(false)} onCreate={(cwd, title, runtimeId) => void perform(async c => { const s = await c.request<Session>('session.create', { cwd, title, runtimeId }); setSnapshot(previous => previous ? { ...previous, sessions: [s, ...previous.sessions.filter(p => p.id !== s.id)] } : previous); setSelected(s.id); setShowConnection(false); setCreate(false); })} />}
  </div>;
}

function ConnectionView({ initial, connecting, connected, onConnect, onDisconnect, onBack }: { initial?: Connection; connecting: boolean; connected: boolean; onConnect: (c: Connection, remember: boolean) => void; onDisconnect: () => void; onBack: () => void }) {
  const [kind, setKind] = useState<'local' | 'remote'>(initial?.kind ?? 'remote'); const [url, setUrl] = useState(initial?.kind === 'local' ? initial.url : 'http://127.0.0.1:9898');
  const [token, setToken] = useState(initial?.kind === 'local' ? initial.token : ''); const [code, setCode] = useState(initial?.kind === 'remote' ? initial.code : ''); const [remember, setRemember] = useState(false);
  return <section className="connection-view"><div className="connection-intro"><div className="connection-symbol"><Laptop size={38} weight="light" /><span /><ChatCircle size={28} weight="light" /></div><span className="eyebrow">你的主机，随身接续</span><h1>连接，继续工作。</h1><p>查看同一个会话的实时进度，<br />把下一步想法发回主机。</p><div className="connection-facts"><div><ShieldCheck size={18} /><span>操作权限由你掌握</span></div><div><TerminalWindow size={18} /><span>代码和执行留在本机</span></div></div></div><form className="connection-form" onSubmit={(event: FormEvent) => { event.preventDefault(); onConnect(kind === 'local' ? { kind, url, token } : { kind, code }, remember); }}><h2>连接设备</h2><div className="segmented"><button type="button" className={kind === 'remote' ? 'active' : ''} onClick={() => setKind('remote')}>远程配对</button><button type="button" className={kind === 'local' ? 'active' : ''} onClick={() => setKind('local')}>本机连接</button></div>{kind === 'remote' ? <><label>配对码<textarea required value={code} onChange={e => setCode(e.target.value)} placeholder="粘贴主机生成的配对码或配对链接" rows={4} /></label><p className="field-help">在主机的终端运行 <code>turnwire devices pair</code> 获取配对码。</p></> : <><label>主机服务地址<input type="url" required value={url} onChange={e => setUrl(e.target.value)} /></label><label>连接令牌<input type="password" required value={token} onChange={e => setToken(e.target.value)} autoComplete="off" placeholder="粘贴本机连接令牌" /></label><p className="field-help">在这台主机上运行 <code>turnwire connect</code> 查看连接信息。</p></>}<label className="remember"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />记住这台受信任设备</label><button className="primary wide" disabled={connecting}>{connecting ? <CircleNotch size={18} className="spin" /> : <Plug size={18} />}{connecting ? '正在连接' : '连接主机'}<ArrowRight size={17} /></button>{connected && <div className="connection-actions"><button type="button" onClick={onBack}>返回会话</button><button type="button" onClick={onDisconnect}>断开并忘记连接</button></div>}</form></section>;
}

function CreateSession({ snapshot, busy, close, onCreate }: { snapshot: Snapshot; busy: boolean; close: () => void; onCreate: (cwd: string, title: string, runtimeId: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null); const [cwd, setCwd] = useState(snapshot.sessions[0]?.cwd ?? ''); const [title, setTitle] = useState(''); const [runtimeId, setRuntime] = useState(snapshot.runtimes[0]?.id ?? 'dsh');
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} onCancel={close} aria-labelledby="new-title"><form onSubmit={e => { e.preventDefault(); onCreate(cwd, title, runtimeId); }}><div className="dialog-heading"><h2 id="new-title">新建会话</h2><button type="button" className="icon-button" onClick={close} aria-label="关闭"><X size={20} /></button></div><p>选择主机上的工作目录，开始一个共享会话。</p><label>会话名称<input autoFocus required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：重构网络请求" /></label><label>工作目录<input required value={cwd} onChange={e => setCwd(e.target.value)} placeholder="/absolute/path/to/project" /></label><label>运行时<select value={runtimeId} onChange={e => setRuntime(e.target.value)}>{snapshot.runtimes.map(runtime => <option key={runtime.id} value={runtime.id} disabled={!runtime.online}>{runtime.name}{!runtime.online ? ' · 未连接' : ''}</option>)}</select></label>{!snapshot.runtimes.some(r => r.online) && <p role="status">请先启动并配置 DSH，然后重新连接 Turnwire。</p>}<div className="dialog-actions"><button type="button" onClick={close}>取消</button><button className="primary" disabled={busy || !snapshot.runtimes.some(r => r.id === runtimeId && r.online)}>{busy ? '正在创建' : '创建会话'}<ArrowRight size={16} /></button></div></form></dialog>;
}
