import { Inbox } from './Inbox';
import { ImagePicker, MessageImages, useImageDraft } from './ImageInput';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowUp, ArrowRight, Check, CircleNotch, Desktop, FolderSimple, GearSix, Laptop, List, Plus, Question as QuestionIcon, ShieldCheck, Stop, TerminalWindow, X, Plug, ChatCircle, CaretRight } from '@phosphor-icons/react';
import { LocalClient, RemoteClient, applyEvent, conversation, decodePairing, encodePairing, loadHistoryPage, HistoryBuffer } from '@turnwire/sdk';
import type { ConnectionState, ConnectionHealth, ConversationMessage, TurnwireClient } from '@turnwire/sdk';
import { TurnwireError, eventSessionId, methodSchemas } from '@turnwire/protocol';
import type { Question, QuestionAnswerItem, TurnwireEvent, Session, SessionStatus, Snapshot, ModelCatalog, QueueItemView, SubagentView, WorkspaceListing } from '@turnwire/protocol';
import { MarkdownMessage } from './MarkdownMessage';
import { AgentStrip } from './AgentStrip';
import { InlineChild } from './InlineChild';
import { conversationRows, currentTurnChildren, launchChild, type ConversationRowData } from './inlineChild';
import { ModelPicker } from './ModelPicker';
import { shouldLoadEarlier } from './historyScroll';
import { t, useLocale, errorText, getLocale, setLocale, type MessageKey } from './i18n';

type Connection = { kind: 'local'; url: string; token: string } | { kind: 'remote'; code: string };
/** Failures a verified connection has answered: they stop being true, so they stop being shown. */
const STALE_CONNECTION_FAILURES = new Set(['DISCONNECTED', 'OUTCOME_UNKNOWN', 'HOST_OFFLINE', 'STAGE_TIMEOUT', 'PROBE_TIMEOUT', 'CONNECTION_FAILED', 'REMOTE_ERROR']);
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
/**
 * A question batch the agent is blocked on, rendered where it was asked. Choices and free text
 * are collected before one explicit, batch-validated submission. Once settled the card becomes the
 * record of what was asked and what was chosen, which is why the answer lives in the transcript at all.
 */
function QuestionCard({ question, pending, disabled, onAnswer }: { question: Question; pending: boolean; disabled: boolean; onAnswer: (answers: QuestionAnswerItem[]) => void }) {
  const t = useLocale();
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const ready = question.questions.length > 0 && question.questions.every(item => (picks[item.id]?.length ?? 0) > 0 || (texts[item.id] ?? '').trim() !== '');
  const answer = () => {
    if (!pending || disabled || !ready) return;
    onAnswer(question.questions.map(item => {
      const custom = (texts[item.id] ?? '').trim();
      return { id: item.id, selected: picks[item.id] ?? [], ...(custom === '' ? {} : { custom }) };
    }));
  };
  return <section className="question-card" aria-label={t('question.aria')} data-status={pending ? 'pending' : question.status}>
    <div className="question-title"><QuestionIcon size={17} /><strong>{pending ? t('question.title') : t('question.answeredTitle')}</strong></div>
    {question.questions.map(item => <div className="question-item" key={item.id}>
      {item.header && <span className="question-header">{item.header}</span>}
      <p className="question-text">{item.question}</p>
      {item.detail && <p className="question-detail">{item.detail}</p>}
      {pending && item.options && item.options.length > 0 && <div className="question-options">{item.options.map(option => <button key={option.label} type="button" aria-pressed={(picks[item.id] ?? []).includes(option.label)} className={(picks[item.id] ?? []).includes(option.label) ? 'chosen' : ''} disabled={disabled} onClick={() => {
        setPicks(current => {
          const chosen = current[item.id] ?? [];
          return { ...current, [item.id]: item.multiSelect === true ? (chosen.includes(option.label) ? chosen.filter(entry => entry !== option.label) : [...chosen, option.label]) : [option.label] };
        });
      }}>{option.label}{option.description ? <small>{option.description}</small> : null}</button>)}</div>}
      {pending && <span className="question-other-row"><input className="question-other" aria-label={`${item.header ?? item.question} — ${t('question.other')}`} placeholder={t('question.other')} value={texts[item.id] ?? ''} disabled={disabled} onChange={event => setTexts(current => ({ ...current, [item.id]: event.target.value }))} onKeyDown={event => {
        if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault(); answer();
      }} /></span>}
      {!pending && <p className="question-given">{answerText(question, item.id) || t('question.noAnswer')}</p>}
    </div>)}
    {pending && <div className="question-actions"><button className="primary" type="button" disabled={disabled || !ready} onClick={answer}>{t('question.send')}</button></div>}
  </section>;
}

/** What was chosen for one question, as the record shows it. */
function answerText(question: Question, id: string) {
  const answer = question.answers?.find(entry => entry.id === id);
  if (!answer) return '';
  return [...answer.selected, ...(answer.custom ? [answer.custom] : [])].join(t('common.listSeparator'));
}

function Status({ status }: { status: SessionStatus }) { const t = useLocale(); return <span className={`status ${status}`} title={t(statusKeys[status])}><span />{t(statusKeys[status])}</span>; }
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
  /** The code of the error on screen. A connection failure stops being true once the link verifies. */
  const failure = useRef('');
  const reportFailure = (error: unknown) => { failure.current = (error as { code?: string } | undefined)?.code ?? ''; setError(errorText(error)); };
  const clearFailure = () => { failure.current = ''; setError(''); };
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false);
  const [showConnection, setShowConnection] = useState(!connection); const [drawer, setDrawer] = useState(false); const [create, setCreate] = useState(false);
  const draftKey = useMemo(() => ({}), [selected, connection]);
  const draftContext = useRef(draftKey); draftContext.current = draftKey;
  const imageDraft = useImageDraft(draftKey);
  const [textDraft, setTextDraft] = useState({ key: draftKey, text: '' });
  const prompt = textDraft.key === draftKey ? textDraft.text : '';
  const setPrompt = (text: string) => setTextDraft({ key: draftKey, text }); const [sessionSearch, setSessionSearch] = useState(''); const [showArchived, setShowArchived] = useState(false); const [renameTitle, setRenameTitle] = useState<string>(); const clientRef = useRef<TurnwireClient | undefined>(undefined); const bottom = useRef<HTMLDivElement>(null);
  const session = snapshot?.sessions.find(s => s.id === selected);
  const messages = useMemo(() => selected ? conversation(events, selected) : [], [events, selected]);
  const approvals = snapshot?.approvals.filter(a => a.sessionId === selected) ?? [];
  const questions = snapshot?.questions.filter(question => question.sessionId === selected) ?? [];
  const runtime = snapshot?.runtimes.find(r => r.id === session?.runtimeId);
  // Model choice belongs to the runtime that owns the session, so the catalog is fetched per
  // runtime and only from a runtime that advertises the capability.
  const [catalog, setCatalog] = useState<{ runtimeId: string; value: ModelCatalog }>();
  const [catalogStatus, setCatalogStatus] = useState<{ runtimeId: string; loading: boolean; error: string }>();
  const catalogRequest = useRef(0);
  const catalogContext = useRef(runtime?.id ?? session?.runtimeId); catalogContext.current = runtime?.id ?? session?.runtimeId;
  useEffect(() => { catalogRequest.current++; setCatalog(undefined); setCatalogStatus(undefined); }, [connection]);
  const sidebar = useRef<HTMLElement>(null); const sidebarTrigger = useRef<HTMLButtonElement>(null);
  const [mobileSidebar, setMobileSidebar] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  const sidebarWasOpen = useRef(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)');
    const change = () => { setMobileSidebar(media.matches); setDrawer(false); };
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useLayoutEffect(() => {
    if (mobileSidebar && drawer) sidebar.current?.querySelector<HTMLButtonElement>('button')?.focus();
    else if (mobileSidebar && sidebarWasOpen.current) sidebarTrigger.current?.focus();
    sidebarWasOpen.current = mobileSidebar && drawer;
  }, [mobileSidebar, drawer]);
  useEffect(() => {
    if (!mobileSidebar || !drawer) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setDrawer(false); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(sidebar.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []);
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [mobileSidebar, drawer]);
  // The picker stays collapsed behind a chip in the composer: a phone needs that space for the
  // conversation and the keyboard, so the control appears only when it is wanted.
  const [showModel, setShowModel] = useState(false); const modelSwitch = useRef<HTMLSpanElement | null>(null);
  const modelRequest = useRef(false);
  const [modelPending, setModelPending] = useState(false);
  const [modelError, setModelError] = useState('');
  const modelContext = useRef(selected); modelContext.current = selected;
  const closeModel = (restoreFocus = true) => { setShowModel(false); if (restoreFocus) modelSwitch.current?.querySelector('button')?.focus({ preventScroll: true }); };
  useEffect(() => { setShowModel(false); setModelError(''); }, [selected, connection]);
  // Queued prompts are shown as their own list above the composer instead of inside the running
  // turn's flow. The list is the runtime's own queue, not this tab's memory of what it saw arrive:
  // a page that has just loaded, or one that was asleep while another client queued something, must
  // still show what is waiting.
  const [queueState, setQueueState] = useState<{ key: object; items: QueueItemView[] }>({ key: draftKey, items: [] });
  const queue = queueState.key === draftKey ? queueState.items : [];
  const setQueue = (items: QueueItemView[] | ((current: QueueItemView[]) => QueueItemView[])) => setQueueState(current => ({ key: draftKey, items: typeof items === 'function' ? items(current.key === draftKey ? current.items : []) : items }));
  const turnRunning = ['running', 'waiting_approval'].includes(session?.status ?? '');
  const pending = useMemo(() => queue.map(item => ({ id: item.messageId, text: item.text, images: item.images })), [queue]);
  const visible = useMemo(() => pending.length ? messages.filter(message => !pending.some(item => item.id === message.id)) : messages, [messages, pending]);
  /**
   * Background agents the session has delegated to. A delegation returns at once, so the transcript
   * goes quiet while children work. Shared by launch entries and the footer strip. Polled while the
   * session runs, and once more when it settles so the last state is not left half-read.
   */
  const [agents, setAgents] = useState<{ sessionId: string; children: SubagentView[] }>();
  // Scope during render, not in an effect: even the first frame of a session switch must not show
  // another session's children. Archived transcript entries remain readable too.
  const scopedAgents = useMemo(() => agents && agents.sessionId === selected ? agents.children : [], [agents, selected]);
  useEffect(() => {
    const client = clientRef.current;
    if (!selected || !session || !client) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let retry = true;
      try {
        const result = await client.request<{ subagents: SubagentView[] }>('subagent.list', { sessionId: selected });
        if (!active) return;
        setAgents({ sessionId: selected, children: result.subagents });
        retry = turnRunning || result.subagents.some(agent => agent.activity === 'running');
      } catch {
        // A failed list is not an empty list. Retain known children and retry even if the parent
        // turn is idle (including a failure of the first request after opening a session).
      }
      if (active && retry) timer = setTimeout(() => void load(), 4000);
    };
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [selected, session?.id, session?.archived, session?.status, turnRunning, state]);
  // A queued prompt can be reconsidered before it runs: rewritten, taken back, or pulled into the
  // turn that is already going. The row owns those actions, so nothing else in the page repeats them.
  const [editingQueued, setEditingQueued] = useState<string>();
  const [queuedDraft, setQueuedDraft] = useState('');
  const refreshQueue = useCallback(async (sessionId: string) => {
    const client = clientRef.current; if (!client) return;
    const context = draftKey;
    try { const result = await client.request<{ items: QueueItemView[] }>('session.queue', { sessionId }); if (draftContext.current === context) setQueue(result.items); }
    catch { if (draftContext.current === context) setQueue([]); }
  }, [draftKey]);
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
  /**
   * Adjacent tool calls become one row, and a row is marked when it opens a run by a new author —
   * a tool call is the assistant acting, so it continues the assistant's run. Only the row that
   * opens a run carries the name, avatar and time; repeating that on every reply is chrome the
   * conversation pays for on a phone.
   */
  const rows = useMemo(() => conversationRows(visible), [visible]);
  const turnAgents = useMemo(() => currentTurnChildren(messages, scopedAgents), [messages, scopedAgents]);
  // The model panel hangs off the chip, so it closes the way a menu does: a tap anywhere else, or Esc.
  useEffect(() => {
    if (!showModel) return;
    const away = (event: MouseEvent) => { if (!modelSwitch.current?.contains(event.target as Node)) setShowModel(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closeModel(); } };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape); };
  }, [showModel]);
  const modelSupport = runtime?.capabilities.modelSelection === true;
  const effortOptions = catalog?.value.groups.find(group => group.id === session?.model?.provider)?.models.find(model => model.id === session?.model?.model)?.reasoning?.efforts ?? [];
  /**
   * The catalog belongs to the runtime and changes with it — a route can gain or lose a model while a
   * page sits open — so opening the picker asks for it again instead of trusting what was fetched when
   * the session was selected. A selection the host refuses for that reason refreshes it the same way.
   */
  const refreshCatalog = useCallback(() => {
    const target = runtime?.id ?? session?.runtimeId; const client = clientRef.current;
    if (!target || !client) return;
    const request = ++catalogRequest.current;
    const current = () => request === catalogRequest.current && clientRef.current === client && catalogContext.current === target;
    setCatalogStatus({ runtimeId: target, loading: true, error: '' });
    return client.request<ModelCatalog>('model.catalog', { runtimeId: target })
      .then(value => { if (current()) { setCatalog({ runtimeId: target, value }); setCatalogStatus({ runtimeId: target, loading: false, error: '' }); } })
      .catch(error => { if (current()) setCatalogStatus({ runtimeId: target, loading: false, error: errorText(error) }); });
  }, [runtime?.id, session?.runtimeId]);
  useEffect(() => {
    if (!runtime?.capabilities.modelSelection || state !== 'connected') return;
    void refreshCatalog();
  }, [runtime?.capabilities.modelSelection, refreshCatalog, state, connection]);
  /** The daemon records the resolved selection, so the request omits what the runtime may fill in. */
  /** Sending is always queueing; steering is the separate action that jumps the queue. */
  const pendingQuestions = useMemo(() => new Set(questions.map(question => question.id)), [questions]);
  const answerQuestion = (question: Question, answers: QuestionAnswerItem[]) => void perform(async c => { await c.request('question.answer', { questionId: question.id, answers }); });
  function submit(text: string, asSteer: boolean) {
    if (!session || busy || (!text.trim() && !imageDraft.images.length) || !imageDraft.validate(text, runtime?.capabilities.imageInput === true)) return;
    const sessionId = session.id; const context = draftKey; const images = imageDraft.images;
    void perform(async c => {
      const accepted = await c.request<{ messageId?: string; queued?: boolean }>('session.message', { sessionId, text, ...(images.length ? { images } : {}), ...(asSteer ? { steer: true } : {}) });
      if (draftContext.current !== context) return;
      setTextDraft(current => current.key === context && current.text === text ? { key: context, text: '' } : current);
      imageDraft.clear();
      // The daemon says whether this waits behind the turn. If it does, show it above the composer
      // at once rather than letting the echo put it in the flow for a round trip and then move it.
      if (!images.length && accepted?.queued === true && accepted.messageId !== undefined) {
        setQueue(current => current.some(item => item.messageId === accepted.messageId) ? current : [...current, { messageId: accepted.messageId!, target: 'next-turn', text }]);
      }
      // Then the runtime's own list is the authority, in case it disagrees.
      await refreshQueue(sessionId);
    });
  }
  /** Each state sends its own constant, so what the reader sees is what the host is told. */
  function setDelegated(sessionId: string, enabled: boolean) { void perform(async c => { await c.request('session.autoApprove', { sessionId, enabled }); }); }
  function chooseModel(provider: string, model: string, reasoningEffort?: string) {
    const client = clientRef.current;
    if (!client || !session || state !== 'connected' || busy || session.archived || modelRequest.current) return;
    const sessionId = session.id;
    const requestPanel = modelSwitch.current?.querySelector('.model-picker');
    modelRequest.current = true; setModelPending(true); setModelError('');
    void client.request<Session>('session.setModel', { sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) })
      .then(updated => {
        if (clientRef.current !== client) return;
        setSnapshot(previous => previous ? { ...previous, sessions: previous.sessions.map(item => item.id === updated.id ? { ...item, model: updated.model } : item) } : previous);
        // Only the still-open panel that initiated this request may restore focus. A dismissal,
        // reopening, or Tab/click into another control must not be undone by a late response.
        if (modelContext.current === sessionId && requestPanel?.isConnected) closeModel(requestPanel.contains(document.activeElement));
      })
      .catch(error => {
        if (clientRef.current !== client || modelContext.current !== sessionId) return;
        setModelError(errorText(error));
        if ((error as { code?: string }).code === 'MODEL_UNAVAILABLE') void refreshCatalog();
      })
      .finally(() => { modelRequest.current = false; setModelPending(false); });
  }
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key.toLowerCase() === 'n' && (event.metaKey || event.ctrlKey) && snapshot) { event.preventDefault(); setCreate(true); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [snapshot]);

  useEffect(() => {
    if (!connection) return;
    let active = true; let unsubscribe: (() => void) | undefined; let c: TurnwireClient;
    setError(''); setLoading(true);
    try { c = connection.kind === 'local' ? new LocalClient(connection.url, connection.token) : new RemoteClient(decodePairing(connection.code), { persistPairing: pairing => { const value = JSON.stringify({ kind: 'remote', code: encodePairing(pairing) }); const storage = localStorage.getItem('turnwire.connection') ? localStorage : sessionStorage; storage.setItem('turnwire.connection', value); } }); }
    catch (error) { reportFailure(error); setLoading(false); setShowConnection(true); return; }
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
        if (history && eventSessionId(d) === history.sessionId) history.buffer.apply(event);
        if (!flush) flush = setTimeout(() => {
          flush = undefined; const batch = pending; pending = [];
          setSnapshot(previous => previous ? batch.reduce(applyEvent, previous) : previous);
          if (historyRef.current) setEvents(historyRef.current.buffer.events);
          const failure = batch.find(e => e.data.type === 'session.error'); if (failure?.data.type === 'session.error') setError(failure.data.message);
        }, 50);
      }, nextState => {
        if (!active) return; setState(nextState);
        // Reconnecting answers what the banner was complaining about, so it goes without being dismissed.
        if (nextState === 'connected' && STALE_CONNECTION_FAILURES.has(failure.current)) clearFailure();
        if (nextState === 'connected' && wasConnected) void c.request<Snapshot>('system.snapshot').then(value => { if (active) setSnapshot(previous => previous && previous.cursor > value.cursor ? previous : value); }).catch(() => {});
        if (nextState === 'connected') wasConnected = true;
      }, next.cursor);
    }).catch(error => { if (active) { reportFailure(error); setLoading(false); if (connection?.kind === 'local') setShowConnection(true);  } }).finally(() => { bootstrapping = false; }); }
    bootstrap();
    const resume = () => { if (c instanceof RemoteClient) { if (document.visibilityState === 'visible') c.resume(); else c.suspend(); } };
    const offline = () => { if (c instanceof RemoteClient) c.suspend('offline'); };
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
    }).catch(error => { if (active) { buffer.cancel(); setHistoryError(true); reportFailure(error); setLoading(false); } });
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
    } catch (error) { if (historyRef.current === history) { history.buffer.cancel(); reportFailure(error); } }
    finally { if (historyRef.current === history) setLoading(false); historyBusy.current = false; }
  }
  useLayoutEffect(() => {
    if (prepend.current && scroller.current) { const old = prepend.current; scroller.current.scrollTop = old.top + scroller.current.scrollHeight - old.height; prepend.current = undefined; }
    else if (follow.current) bottom.current?.scrollIntoView({ block: 'end', behavior: 'instant' });
  }, [events, approvals.length]);
  async function perform(action: (c: TurnwireClient) => Promise<void>) { if (!clientRef.current) return; setBusy(true); clearFailure(); try { await action(clientRef.current); } catch (error) { reportFailure(error); } finally { setBusy(false); } }
  function saveConnection(value: Connection, remember: boolean) { localStorage.removeItem('turnwire.connection'); sessionStorage.removeItem('turnwire.connection'); (remember ? localStorage : sessionStorage).setItem('turnwire.connection', JSON.stringify(value)); setSnapshot(undefined); setSelected(undefined); setEvents([]); setState('connecting'); setConnection(value); }
  function disconnect() { clientRef.current?.close(); localStorage.removeItem('turnwire.connection'); sessionStorage.removeItem('turnwire.connection'); setConnection(undefined); setSnapshot(undefined); setSelected(undefined); setEvents([]); setShowConnection(true); setState('offline'); }
  async function checkConnection() { const c = clientRef.current; if (!(c instanceof RemoteClient)) return; setChecking(true); try { await c.checkConnection(); clearFailure(); } catch (error) { reportFailure(error); } finally { setChecking(false); } }
  const connected = state === 'connected';
  function rememberDevice() { const c = clientRef.current; if (c instanceof RemoteClient) { localStorage.setItem('turnwire.connection', JSON.stringify({ kind: 'remote', code: encodePairing(c.currentPairing) })); sessionStorage.removeItem('turnwire.connection'); } }
  return <div className="app">
    {drawer && <button className="scrim" aria-label={t('sidebar.closeSessionList')} onClick={() => setDrawer(false)} />}
    <aside ref={sidebar} id="session-sidebar" inert={mobileSidebar && !drawer} aria-hidden={mobileSidebar && !drawer ? true : undefined} className={`sidebar ${drawer ? 'visible' : ''}`}>
      <div className="brand"><img src="/icon-192.png" width="30" height="30" alt="" /><span>turnwire<span className="brand-suffix">remote</span></span><button className="icon-button mobile-only" aria-label={t('sidebar.closeList')} onClick={() => setDrawer(false)}><X size={20} /></button></div>
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
      <header className="topbar"><button ref={sidebarTrigger} className="icon-button mobile-only" aria-expanded={drawer} aria-controls="session-sidebar" aria-label={t('topbar.openSessionList')} onClick={() => setDrawer(true)}><List size={22} /></button><div className="breadcrumb"><Laptop size={17} /><span>{snapshot?.device.name ?? 'Turnwire Remote'}</span><CaretRight size={12} /><strong>{showConnection ? t('topbar.deviceConnection') : showInbox ? t('topbar.inbox') : session?.title ?? t('topbar.workspace')}</strong></div><div className="topbar-right">{session && !showConnection && !showInbox && <><Status status={session.status} /><details className="session-actions"><summary>{t('topbar.sessionActions')}</summary><div><button disabled={!connected || busy} onClick={() => { setRenameTitle(session.title); }}>{t('topbar.rename')}</button>{renameTitle !== undefined && <form onSubmit={event => { event.preventDefault(); void perform(async c => { await c.request('session.rename', { sessionId: session.id, title: renameTitle }); setRenameTitle(undefined); }); }}><input aria-label={t('topbar.newSessionName')} value={renameTitle} onChange={event => setRenameTitle(event.target.value)} /><button disabled={busy || !renameTitle.trim()}>{t('topbar.saveName')}</button></form>}<button disabled={!connected || busy || ['running', 'waiting_approval'].includes(session.status)} onClick={() => void perform(async c => { await c.request('session.archive', { sessionId: session.id, archived: !session.archived }); })}>{session.archived ? t('common.unarchive') : t('topbar.archiveSession')}</button></div></details></>}<button className="icon-button" aria-label={t('topbar.connectionSettings')} onClick={() => setShowConnection(true)}><Plug size={19} /></button></div></header>
      {connection?.kind === 'remote' && (health?.phase === 'connected'
        // Connected is the normal state, so it costs one thin line: the host and the round trip, with the
        // full story on the pointer and a click to verify again. Everything else keeps the bar that says
        // what is wrong and what will happen next.
        ? <button type="button" className="connection-ok" disabled={checking} onClick={() => void checkConnection()} title={`${t('health.details', { latency: health.latencyMs ?? 0, time: health.lastVerifiedAt ? new Date(health.lastVerifiedAt).toLocaleTimeString() : '—', route: health.route === 'direct' ? t('health.routeDirect') : 'Relay' })} · ${t('health.reconnectNow')}`}><span className="connection-dot" />{t('health.connectedTo', { host: snapshot?.device.name ?? t('health.host') })}{health.latencyMs === undefined ? '' : ` · ${health.latencyMs} ms`}{checking ? <CircleNotch className="spin" size={11} /> : null}</button>
        : <div className="connection-health" data-phase={health?.phase ?? 'connecting'} role="status"><div><strong>{health?.message ?? t('health.connecting')}</strong><small>{health?.retryInMs ? t('health.retry', { seconds: Math.ceil(health.retryInMs / 1000) }) : t('health.unconfirmed')}</small></div><button disabled={checking} onClick={() => void checkConnection()}>{checking ? t('health.connectingAction') : t('health.reconnectNow')}</button></div>)}
      {error && <div role="alert" className="error-banner"><span>{error}</span><button className="icon-button" aria-label={t('error.dismiss')} onClick={clearFailure}><X size={17} /></button></div>}
      {showConnection ? <ConnectionView initial={connection?.kind === 'remote' && clientRef.current instanceof RemoteClient ? { kind: 'remote', code: encodePairing(clientRef.current.currentPairing) } : connection} connecting={loading} connected={!!snapshot} onConnect={saveConnection} onDisconnect={disconnect} onBack={() => setShowConnection(false)} />
        : showInbox && clientRef.current ? <Inbox client={clientRef.current} cursor={snapshot?.cursor ?? 0} connected={connected} remember={rememberDevice} onOpen={id => { setSelected(id); setShowInbox(false); }} />
        : !session ? <div className="empty-workspace"><div className="empty-symbol"><TerminalWindow size={38} weight="light" /></div><span className="eyebrow">{t('empty.eyebrow')}</span><h1>{t('empty.title')}</h1><p>{t('empty.bodyLine1')}<br />{t('empty.bodyLine2')}</p><button className="primary" onClick={() => setCreate(true)} disabled={!snapshot}><Plus size={17} />{t('common.newSession')}</button></div>
        : <>
          <section className="conversation" aria-label={t('conversation.aria')} ref={scroller} onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (shouldLoadEarlier({ scrollTop: el.scrollTop, before, loading, failed: historyError, pages: autoPages.current })) void earlier(true); }}><div className="conversation-inner"><div className="session-heading"><span><FolderSimple size={16} />{shortPath(session.cwd)}</span><h1>{session.title}</h1><p>{runtime?.name ?? session.runtimeId}{session.runtimeId === 'demo' && t('conversation.demoNote')}</p></div>
            {(before !== null || historyError) && <button className="history-more" disabled={loading} onClick={() => void earlier()}>{loading ? t('conversation.loadingEarlier') : historyError ? t('conversation.retryEarlier') : t('conversation.loadEarlier')}</button>}
            {loading && !messages.length && <div className="loading"><CircleNotch className="spin" size={18} />{t('conversation.loading')}</div>}
            {!loading && !messages.length && <div className="conversation-empty"><ChatCircle size={26} weight="light" /><p>{t('conversation.readyLine1')}<br />{t('conversation.readyLine2')}</p></div>}
            {/* The wire history does not say that the last assistant message summarizes its predecessors.
                Keep every received answer visible; only explicit tool details are collapsible. */}
            {rows.map(row => <ConversationRow key={`${session.id}:${row.key}`} row={row} running={turnRunning} agents={scopedAgents} client={clientRef.current} sessionId={session.id} connected={connected} pendingQuestions={pendingQuestions} disabled={busy || !connected} onAnswer={answerQuestion} />)}
            <div ref={bottom} /></div></section>
          <footer className="composer-area"><div className="composer-width"><div className="composer-attachments">{session.archived && <div className="resume-row"><span>{t('session.archivedRow')}</span><button disabled={!connected || busy} onClick={() => void perform(async c => { await c.request('session.archive', { sessionId: session.id, archived: false }); })}>{t('common.unarchive')}</button></div>}
            {approvals.map(approval => <section key={approval.id} className="approval-panel" aria-label={t('approval.panelAria')}><div className="approval-title"><ShieldCheck size={20} /><strong>{t('approval.needed')}</strong><span>{session.autoApprove ? t('approval.autoOn') : t('approval.once')}</span></div><code>{approval.tool}</code><p>{approval.reason}</p><div className="approval-actions"><button disabled={busy || !connected} onClick={() => void perform(async c => { await c.request('approval.decide', { approvalId: approval.id, decision: 'rejected' }); })}><X size={16} />{t('common.reject')}</button><button className="primary" disabled={busy || !connected} onClick={() => void perform(async c => { await c.request('approval.decide', { approvalId: approval.id, decision: 'approved' }); })}><Check size={16} />{t('common.approveOnce')}</button></div></section>)}
            {!session.archived && (session.status === 'interrupted' || session.status === 'error') && <div className="resume-row"><span>{t('session.resumeHint')}</span><button disabled={busy || !connected} onClick={() => void perform(async c => { await c.request('session.resume', { sessionId: session.id }); })}>{t('session.resume')}<ArrowRight size={15} /></button></div>}
            
          <AgentStrip key={session.id} agents={session.archived ? [] : turnAgents} client={clientRef.current} sessionId={session.id} connected={connected} />
          {pending.length > 0 && <div className="queued-strip" role="status" aria-label={t('queue.aria')}>{pending.map(item => <div className="queued-item" key={item.id}>{editingQueued === item.id ? <input className="queued-edit" aria-label={t('queue.editLabel')} value={queuedDraft} autoFocus onChange={event => setQueuedDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (queuedDraft.trim()) void changeQueued(item.id, { kind: 'edit', text: queuedDraft.trim() }); } if (event.key === 'Escape') setEditingQueued(undefined); }} /> : <span className="queued-text" title={item.text}>{item.text}</span>}<MessageImages client={clientRef.current} sessionId={session.id} images={item.images} /><span className="queued-buttons">{editingQueued === item.id ? <button type="button" disabled={!connected || busy || !queuedDraft.trim()} onClick={() => void changeQueued(item.id, { kind: 'edit', text: queuedDraft.trim() })}>{t('queue.save')}</button> : <button type="button" disabled={!connected || busy} onClick={() => { setEditingQueued(item.id); setQueuedDraft(item.text); }}>{t('queue.edit')}</button>}<button type="button" disabled={!connected || busy} onClick={() => void changeQueued(item.id, { kind: 'remove' })}>{t('queue.remove')}</button><button type="button" disabled={!connected || busy} onClick={() => void changeQueued(item.id, { kind: 'steer' })}>{t('queue.steer')}</button></span></div>)}</div>}
          </div><form className="composer" onSubmit={event => { event.preventDefault(); if (!prompt.trim() && !imageDraft.images.length) return; submit(prompt, false); }}>
              <ImagePicker draft={imageDraft} supported={runtime?.capabilities.imageInput === true} disabled={busy || !connected || session.archived || ['interrupted', 'error'].includes(session.status)} />
              <textarea onPaste={event => imageDraft.onPaste(event, runtime?.capabilities.imageInput === true)} aria-label={t('composer.messageAria')} placeholder={t('composer.placeholder')} value={prompt} onChange={event => setPrompt(event.target.value)} rows={2} disabled={busy || !connected || session.archived || ['interrupted', 'error'].includes(session.status)} onKeyDown={event => { if (event.key !== 'Enter') return; if (event.altKey) { event.preventDefault(); submit(prompt, true); } else if (event.metaKey || event.ctrlKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
              <div className="composer-bottom"><span className="composer-path" title={session.cwd}><FolderSimple size={14} /><span dir="rtl"><bdi dir="ltr">{session.cwd}</bdi></span></span><div><span className="approval-mode"><button type="button" role="switch" aria-checked={session.autoApprove === true} aria-label={t('session.autoApprove')} data-auto-approve={session.autoApprove ? 'on' : 'off'} disabled={!connected || busy || session.archived} onClick={() => setDelegated(session.id, !session.autoApprove)} title={`${t(session.autoApprove ? 'session.autoApproveOn' : 'session.autoApprove')} — ${t('session.autoApproveHint')}`}><ShieldCheck size={15} aria-hidden="true" /><span>{t(session.autoApprove ? 'session.autoApproveShortOn' : 'session.autoApproveShort')}</span></button></span>{modelSupport && <span className="model-switch" ref={modelSwitch}><button type="button" className="model-chip" aria-label={t('composer.chooseModel')} aria-expanded={showModel} aria-haspopup="dialog" disabled={!connected || session.archived} onClick={() => { if (!showModel) void refreshCatalog(); setShowModel(value => !value); }}>{modelPending ? t('model.switching') : modelChipLabel(session, catalog)}</button>{showModel && <ModelPicker anchor={modelSwitch} catalog={catalog?.runtimeId === runtime?.id ? catalog?.value : undefined} current={session.model} disabled={!connected || busy || session.archived === true} pending={modelPending} error={modelError} catalogLoading={catalogStatus?.runtimeId === runtime?.id && catalogStatus.loading} catalogError={catalogStatus?.runtimeId === runtime?.id ? catalogStatus.error : ''} retryCatalog={() => void refreshCatalog()} choose={chooseModel}>{catalog?.runtimeId === runtime?.id && <>{session.model && effortOptions.length > 0 && <label>{t('model.reasoningEffort')}<select aria-label={t('model.reasoningEffort')} value={session.model.reasoningEffort ?? ''} disabled={!connected || busy || modelPending || session.archived} onChange={event => chooseModel(session.model!.provider, session.model!.model, event.target.value || undefined)}>{!session.model.reasoningEffort && <option value="">{t('model.runtimeDefault')}</option>}{effortOptions.map(effort => <option key={effort.id} value={effort.id}>{effort.name}{effort.id === catalog.value.groups.find(group => group.id === session.model?.provider)?.models.find(model => model.id === session.model?.model)?.reasoning?.defaultEffort ? t('model.defaultSuffix') : ''}</option>)}</select></label>}</>}{catalog?.runtimeId === runtime?.id && catalog.value.failures.length > 0 && <span className="model-loading">{catalog.value.failures.map(failure => t('model.unavailable', { name: failure.name })).join(t('common.listSeparator'))}</span>}</ModelPicker>}</span>}{['running', 'waiting_approval'].includes(session.status) && <button className="stop-button" title={t('composer.stop')} type="button" aria-label={t('composer.stopTask')} disabled={!connected} onClick={() => void perform(async c => { await c.request('session.cancel', { sessionId: session.id }); })}><Stop size={13} weight="fill" />{t('composer.stop')}</button>}<button className="send-button" type="submit" aria-label={t('composer.send')} disabled={busy || !connected || session.archived || imageDraft.processing || (!prompt.trim() && !imageDraft.images.length) || ['interrupted', 'error'].includes(session.status)}>{busy ? <CircleNotch className="spin" size={18} /> : <ArrowUp size={20} />}</button></div></div>
            </form><div className="composer-caption"><LocaleSwitch /><span><ShieldCheck size={12} />{connection?.kind === 'remote' ? t('composer.encrypted') : t('composer.local')}</span><span>{connected ? t('composer.shared') : t('composer.disconnected')}</span></div>
          </div></footer>
        </>}
    </main>
    {create && snapshot && <CreateSession snapshot={snapshot} busy={busy} close={() => setCreate(false)} onBrowse={async path => { const c = clientRef.current; if (!c) throw new TurnwireError('DISCONNECTED', 'The host connection is not available'); return c.request<WorkspaceListing>('workspace.list', path ? { path } : {}); }} onCreateDirectory={async (parent, name) => { const c = clientRef.current; if (!c) throw new TurnwireError('DISCONNECTED', 'The host connection is not available'); return c.request<WorkspaceListing>('workspace.mkdir', { parent, name }); }} onCreate={(cwd, title, runtimeId) => void perform(async c => { const s = await c.request<Session>('session.create', { cwd, title, runtimeId }); setSnapshot(previous => previous ? { ...previous, sessions: [s, ...previous.sessions.filter(p => p.id !== s.id)] } : previous); setSelected(s.id); setShowConnection(false); setCreate(false); })} />}
  </div>;
}

function ConnectionView({ initial, connecting, connected, onConnect, onDisconnect, onBack }: { initial?: Connection; connecting: boolean; connected: boolean; onConnect: (c: Connection, remember: boolean) => void; onDisconnect: () => void; onBack: () => void }) {
  const t = useLocale();
  const [kind, setKind] = useState<'local' | 'remote'>(initial?.kind ?? 'remote'); const [url, setUrl] = useState(initial?.kind === 'local' ? initial.url : 'http://127.0.0.1:9898');
  const [token, setToken] = useState(initial?.kind === 'local' ? initial.token : ''); const [code, setCode] = useState(initial?.kind === 'remote' ? initial.code : ''); const [remember, setRemember] = useState(false);
  return <section className="connection-view"><div className="connection-intro"><div className="connection-symbol"><Laptop size={38} weight="light" /><span /><ChatCircle size={28} weight="light" /></div><span className="eyebrow">{t('connection.eyebrow')}</span><h1>{t('connection.title')}</h1><p>{t('connection.bodyLine1')}<br />{t('connection.bodyLine2')}</p><div className="connection-facts"><div><ShieldCheck size={18} /><span>{t('connection.factPermissions')}</span></div><div><TerminalWindow size={18} /><span>{t('connection.factLocal')}</span></div></div></div><form className="connection-form" onSubmit={(event: FormEvent) => { event.preventDefault(); onConnect(kind === 'local' ? { kind, url, token } : { kind, code }, remember); }}><h2>{t('connection.connectDevice')}</h2><div className="segmented"><button type="button" className={kind === 'remote' ? 'active' : ''} onClick={() => setKind('remote')}>{t('connection.remotePairing')}</button><button type="button" className={kind === 'local' ? 'active' : ''} onClick={() => setKind('local')}>{t('connection.localPairing')}</button></div>{kind === 'remote' ? <><label>{t('connection.pairingCode')}<textarea required value={code} onChange={e => setCode(e.target.value)} placeholder={t('connection.pairingPlaceholder')} rows={4} /></label><p className="field-help">{t('connection.pairingHelpBefore')}<code>turnwire devices pair</code>{t('connection.pairingHelpAfter')}</p></> : <><label>{t('connection.hostUrl')}<input type="url" required value={url} onChange={e => setUrl(e.target.value)} /></label><label>{t('connection.token')}<input type="password" required value={token} onChange={e => setToken(e.target.value)} autoComplete="off" placeholder={t('connection.tokenPlaceholder')} /></label><p className="field-help">{t('connection.connectHelpBefore')}<code>turnwire connect</code>{t('connection.connectHelpAfter')}</p></>}<label className="remember"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />{t('connection.remember')}</label><button className="primary wide" disabled={connecting}>{connecting ? <CircleNotch size={18} className="spin" /> : <Plug size={18} />}{connecting ? t('connection.connecting') : t('connection.connect')}<ArrowRight size={17} /></button>{connected && <div className="connection-actions"><button type="button" onClick={onBack}>{t('connection.back')}</button><button type="button" onClick={onDisconnect}>{t('connection.disconnect')}</button></div>}</form></section>;
}

/** The first line of a value, since a closed row has room for one. */
function firstLine(value: string) { return value.split('\n').map(line => line.trim()).find(Boolean) ?? ''; }

/**
 * What a tool call is doing, in the tool's own words: the command it runs, the file it touches, the
 * task it delegates. The arguments arrive as the tool's raw JSON, and a closed row that only said
 * `shell` made the reader open every call to find out which command was running.
 */
function toolAction(message: ConversationMessage) {
  const source = (message.input ?? message.output ?? message.text ?? '').trim();
  if (!source) return '';
  if (source.startsWith('{')) {
    try {
      const parsed = JSON.parse(source) as Record<string, unknown>;
      // The keys that describe the action, before any other string the arguments happen to carry.
      for (const key of ['command', 'description', 'query', 'pattern', 'path', 'file_path', 'filePath', 'url', 'prompt', 'name']) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim()) return firstLine(value);
      }
      const first = Object.values(parsed).find(value => typeof value === 'string' && value.trim());
      if (typeof first === 'string') return firstLine(first);
    } catch { /* Not JSON: the detail already is the action. */ }
  }
  return firstLine(source);
}

/** The tool and what it is doing. A closed tool row lives on the second half of this. */
function ToolHeading({ message }: { message: ConversationMessage }) {
  const t = useLocale();
  const action = toolAction(message);
  return <><span className="tool-name">{message.tool === 'subagent' ? t('tool.subagentName') : message.tool ?? t('tool.tool')}</span>{action && <span className="tool-action" title={action}>{action}</span>}</>;
}

/** One tool call: a quiet line that says what it is doing until someone opens it. */
function ToolCall({ message }: { message: ConversationMessage }) {
  const t = useLocale();
  return <details className="tool-message"><summary><TerminalWindow size={13} /><ToolHeading message={message} /><span className="tool-status">{message.isError ? t('tool.failed') : message.complete ? t('tool.returned') : t('tool.running')}</span><CaretRight size={11} className="tool-caret" /></summary>{message.input !== undefined && <><strong>{t('tool.input')}</strong><pre>{message.input}</pre></>}{message.output !== undefined && <><strong>{t('tool.output')}</strong><pre>{message.output}</pre></>}</details>;
}

/** One row of the conversation: a message, or a run of tool calls. */
function ConversationRow({ row, running, agents, client, sessionId, connected, pendingQuestions, disabled, onAnswer }: { row: ConversationRowData; running: boolean; agents: SubagentView[]; client?: TurnwireClient; sessionId: string; connected: boolean; pendingQuestions?: Set<string>; disabled?: boolean; onAnswer?: (question: Question, answers: QuestionAnswerItem[]) => void }) {
  const t = useLocale();
  if (row.launch) return <InlineChild agent={launchChild(row.launch, agents)} client={client} sessionId={sessionId} connected={connected} tool={<ToolCall message={row.launch} />} />;
  if (row.tools) return <ToolRun items={row.tools} running={running} />;
  const message = row.message!;
  if (message.role === 'question' && message.question) return <QuestionCard question={message.question} pending={pendingQuestions?.has(message.question.id) === true} disabled={disabled === true} onAnswer={answers => onAnswer?.(message.question!, answers)} />;
  return <article className={`message ${message.role}${row.lead ? '' : ' follow'}`}>{row.lead && <div className="message-author">{message.role === 'user' ? <><span className="avatar">{t('conversation.you')}</span>{t('conversation.you')}</> : <><img src="/icon-192.png" width="23" height="23" alt="" />Turnwire</>}<time>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>}{(message.queued || message.steer) && <div className="message-tags">{message.queued && <span className="queued-chip">{t('message.queuedChip')}</span>}{message.steer && <span className="queued-chip">{t('message.steerChip')}</span>}</div>}<MessageImages client={client} sessionId={sessionId} images={message.images} /><div className="message-text">{message.role === 'assistant' ? <MarkdownMessage text={message.text} id={message.id} /> : message.text}{!message.complete && <span className="cursor" />}</div></article>;
}

/**
 * Consecutive tool calls read as one line and open into the calls themselves: a turn that runs ten
 * tools should not look like ten blocks of content. While the run is in flight the closed line is the
 * newest call, so it says what is happening right now; once it settles it becomes the run's summary.
 */
function ToolRun({ items, running }: { items: ConversationMessage[]; running: boolean }) {
  const t = useLocale();
  if (items.length === 1) return <ToolCall message={items[0]!} />;
  const tools = [...new Set(items.map(item => item.tool ?? t('tool.tool')))];
  const failures = items.filter(item => item.isError).length;
  const working = items.some(item => !item.complete);
  const label = tools.length === 1 && tools[0] === 'subagent' ? t('tool.subagentCount', { count: items.length }) : tools.length === 1 ? t('tool.namedCount', { tool: tools[0] ?? '', count: items.length }) : t('tool.manyItems', { tool: tools[0] ?? '', count: items.length });
  const status = failures ? t('tool.failures', { count: failures }) : !working ? t('tool.allReturned') : running ? t('tool.running') : t('tool.noResult');
  return <details className="tool-group"><summary><TerminalWindow size={13} />{working ? <ToolHeading message={items[items.length - 1]!} /> : <span>{label}</span>}<span className="tool-status">{status}</span><CaretRight size={11} className="tool-caret" /></summary><div className="tool-group-items">{items.map(item => <ToolCall key={item.id} message={item} />)}</div></details>;
}

export function CreateSession({ snapshot, busy, close, onBrowse, onCreateDirectory, onCreate }: { snapshot: Snapshot; busy: boolean; close: () => void; onBrowse: (path?: string) => Promise<WorkspaceListing>; onCreateDirectory: (parent: string, name: string) => Promise<WorkspaceListing>; onCreate: (cwd: string, title: string, runtimeId: string) => void }) {
  const t = useLocale();
  const ref = useRef<HTMLDialogElement>(null); const [cwd, setCwd] = useState(snapshot.sessions[0]?.cwd ?? ''); const [title, setTitle] = useState(''); const [runtimeId, setRuntime] = useState(snapshot.runtimes[0]?.id ?? 'dsh');
  const [listing, setListing] = useState<WorkspaceListing>(); const [failure, setFailure] = useState(''); const [reading, setReading] = useState(false); const [choosing, setChoosing] = useState(false);
  const [newFolder, setNewFolder] = useState(false); const [folderName, setFolderName] = useState(''); const [makingFolder, setMakingFolder] = useState(false); const [folderFailure, setFolderFailure] = useState('');
  const folderBusy = reading || makingFolder;
  const validFolderName = methodSchemas['workspace.mkdir'].safeParse({ parent: listing?.path ?? '/', name: folderName }).success;
  const picker = useRef<HTMLElement | null>(null);
  function cancelNewFolder() { setNewFolder(false); setFolderName(''); setFolderFailure(''); }
  async function createDirectory() {
    if (!listing || folderBusy || !validFolderName) return;
    setMakingFolder(true); setFolderFailure('');
    try { setListing(await onCreateDirectory(listing.path, folderName)); cancelNewFolder(); setFailure(''); }
    catch (error) { setFolderFailure(errorText(error)); }
    finally { setMakingFolder(false); }
  }
  useEffect(() => { ref.current?.showModal(); }, []);
  // The picker opens on the tap, not on the answer: a prompt tap that shows nothing until the host
  // replies reads as a dead button, and on a slow or older host that reply can be a long wait.
  useEffect(() => { if (choosing) picker.current?.scrollIntoView({ block: 'nearest' }); }, [choosing, listing]);
  /** Opens the picker at `path`, falling back to the host home so a stale path is not a dead end. */
  async function browse(path?: string) {
    if (folderBusy) return;
    cancelNewFolder(); setChoosing(true); setReading(true); setFailure('');
    try { setListing(await onBrowse(path)); }
    catch (error) {
      if (!path) setFailure(errorText(error));
      else { try { setListing(await onBrowse()); setFailure(errorText(error)); } catch (homeError) { setFailure(errorText(homeError)); } }
    }
    setReading(false);
  }
  return <dialog ref={ref} onCancel={close} aria-labelledby="new-title"><form onSubmit={e => { e.preventDefault(); onCreate(cwd, title, runtimeId); }}>
    <div className="dialog-heading"><h2 id="new-title">{t('common.newSession')}</h2><button type="button" className="icon-button" onClick={close} aria-label={t('common.close')}><X size={20} /></button></div>
    <p>{t('create.intro')}</p>
    <label>{t('create.name')}<input autoFocus required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder={t('create.namePlaceholder')} /></label>
    <label>{t('create.cwd')}<span className="field-row"><input required value={cwd} onChange={e => setCwd(e.target.value)} placeholder="/absolute/path/to/project" /><button type="button" className="choose-folder" disabled={folderBusy} aria-busy={folderBusy} onClick={() => void browse(cwd || undefined)}>{reading ? <CircleNotch size={16} className="spin" /> : <FolderSimple size={16} />}{t('create.choose')}</button></span></label>
    {choosing && <section className="folder-picker" ref={picker} aria-label={t('create.folderPicker')}>
      <header><code title={listing?.path ?? cwd}>{listing?.path ?? t('create.reading')}</code><span><button type="button" disabled={folderBusy || !listing} onClick={() => listing && void browse(listing.home)}>{t('create.home')}</button><button type="button" disabled={folderBusy || !listing?.parent} onClick={() => listing?.parent && void browse(listing.parent)}>{t('create.up')}</button></span></header>
      <div className="folder-list">
        {listing?.entries.map(entry => <button type="button" key={entry.path} disabled={folderBusy} onClick={() => void browse(entry.path)}><FolderSimple size={15} /><span>{entry.name}</span><CaretRight size={12} /></button>)}
        {!reading && listing && !listing.entries.length && <p role="status">{t('create.noFolders')}</p>}
        {reading && <p role="status" className="folder-reading"><CircleNotch size={14} className="spin" />{t('create.reading')}</p>}
      </div>
      {listing && listing.entries.length < listing.total && <p className="folder-note">{t('create.truncated', { shown: listing.entries.length, total: listing.total })}</p>}
      {newFolder ? <div className="folder-create" aria-busy={makingFolder}>
        <label>{t('create.folderName')}<input autoFocus value={folderName} disabled={makingFolder} onChange={e => { setFolderName(e.target.value); setFolderFailure(''); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (!e.nativeEvent.isComposing && e.keyCode !== 229) void createDirectory(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!makingFolder) cancelNewFolder(); } }} /></label>
        <p className="folder-hint">{t('create.folderNameHint')}</p>
        {folderFailure && <p className="folder-error" role="alert">{folderFailure}</p>}
        <div className="folder-create-actions"><button type="button" disabled={folderBusy || !validFolderName} onClick={() => void createDirectory()}>{makingFolder ? t('create.creatingFolder') : t('create.createFolder')}</button><button type="button" disabled={makingFolder} onClick={cancelNewFolder}>{t('common.cancel')}</button></div>
      </div> : <button type="button" className="folder-new" disabled={folderBusy || !listing} onClick={() => { setNewFolder(true); setFolderFailure(''); }}>{t('create.newFolder')}</button>}
      <footer><button type="button" className="primary" disabled={folderBusy || !listing} onClick={() => { if (!listing) return; setCwd(listing.path); setListing(undefined); setChoosing(false); setFailure(''); cancelNewFolder(); }}>{t('create.useFolder')}</button><button type="button" disabled={folderBusy} onClick={() => { setListing(undefined); setChoosing(false); setFailure(''); cancelNewFolder(); }}>{t('common.cancel')}</button></footer>
    </section>}
    {failure && <p className="folder-error" role="alert">{failure}</p>}
    {choosing && failure && <p className="folder-hint">{t('create.browseHint')}</p>}
    <label>{t('create.runtime')}<select value={runtimeId} onChange={e => setRuntime(e.target.value)}>{snapshot.runtimes.map(runtime => <option key={runtime.id} value={runtime.id} disabled={!runtime.online}>{runtime.name}{!runtime.online ? t('create.runtimeOffline') : ''}</option>)}</select></label>
    {!snapshot.runtimes.some(r => r.online) && <p role="status">{t('create.noRuntime')}</p>}
    <div className="dialog-actions"><button type="button" onClick={close}>{t('common.cancel')}</button><button className="primary" disabled={busy || !snapshot.runtimes.some(r => r.id === runtimeId && r.online)}>{busy ? t('create.creating') : t('create.create')}<ArrowRight size={16} /></button></div>
  </form></dialog>;
}
