import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TurnwireError, modelCatalogSchema, modelSelectionSchema } from '@turnwire/protocol';
import type { ApprovalDecision, ModelCatalog, ModelSelection, RuntimeCapabilities, SubagentView } from '@turnwire/protocol';
import type { AgentRuntime, RuntimeEvent, RuntimeSession } from '@turnwire/runtime';
import { assistantId, compactText, mapEvent, record, wireEventSchema } from './mapper.js';
export { mapEvent, compactText } from './mapper.js';

export const DSH_SOURCE_REVISION = '5dda764ed3aa172535a7967b06ff95d9cbfe536a';
/** Bounds on one progress read: a run of delegations should be visible, not unbounded. */
const MAX_SUBAGENTS = 50; const MAX_SUBAGENT_DEPTH = 3;
const resultSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.unknown() }), z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }).passthrough() })]);
const summarySchema = z.object({ sessionId: z.string(), running: z.boolean(), cwd: z.string().optional() }).passthrough();
/** One `subagents/list` row: the durable child identity plus the Host's live read of its activity. */
const subagentEntrySchema = z.object({ kind: z.string(), id: z.string(), activity: z.string().optional(), hasChildren: z.boolean().optional(), mode: z.string().optional(), label: z.string().optional() }).passthrough();
/**
 * The slice of `session/list` a progress view needs. The Host projects the child's own plan
 * (`todos`), its delegation identity (`subagent.identity`, which carries the label and mode), its
 * title and its timing onto every listed session, so one call describes every child without
 * replaying any transcript. Every field is optional and the object passes unknown keys through:
 * the Host owns these projections, and a shape this adapter has not seen must cost one child its
 * detail rather than the whole listing.
 */
const subagentDetailSchema = z.object({ sessionId: z.string(), projections: z.object({
  title: z.string().nullable().optional(),
  todos: z.array(z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) })).nullable().optional(),
  subagent: z.object({ identity: z.object({ mode: z.string(), label: z.string().optional() }).optional() }).nullable().optional(),
  subagentTiming: z.object({ settledMs: z.number().optional(), active: z.object({ since: z.number() }).optional() }).optional(),
}).optional() }).passthrough();
interface SubagentDetail { label?: string; title?: string; elapsedMs?: number; todos: SubagentView['todos'] }
export interface DshOptions {
  url: string; token?: string;
  readCursor?: (sessionId: string) => number | undefined;
  saveCursor?: (sessionId: string, seq: number) => void;
}

/** DSH's authenticated Host API plus its official Remote mux/event waterfall. */
export class DshRuntime implements AgentRuntime {
  readonly id = 'dsh'; readonly name = 'DeepSeek Harness';
  private url: URL; private token?: string; private cookie = '';
  private socket?: WebSocket; private connecting?: Promise<void>; private closed = false;
  private retry?: ReturnType<typeof setTimeout>;
  private listeners = new Map<string, Set<(event: RuntimeEvent) => void>>();
  private sessions = new Map<string, RuntimeSession>();
  private streams = new Map<string, string>();
  private queues = new Map<string, Promise<void>>();
  private cursors = new Map<string, number>();
  private live = new Map<string, { id: string; nextIndex: number; text: string }>();
  private pending = new Map<string, { sessionId: string; clientId: string; resolving?: boolean; cancelled?: boolean }>();
  private clientId?: string;
  private lastError = 'DSH is not connected yet';
  constructor(private options: DshOptions) {
    this.url = new URL(options.url); this.token = options.token ?? this.url.searchParams.get('token') ?? undefined;
    this.url.search = ''; this.url.hash = ''; this.url.pathname = '/';
    if (!['http:', 'https:'].includes(this.url.protocol)) throw new Error('DSH URL must use HTTP or HTTPS');
    if (this.url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname)) throw new Error('Non-loopback DSH connections require HTTPS');
  }
  capabilities(): RuntimeCapabilities { return { approvals: true, streaming: true, resume: true, shell: true, diff: false, fileEdits: true, toolCalls: true, backgroundTasks: false, modelSelection: true }; }
  /**
   * Ask the Host for each followed session's direct children and count the running ones.
   * `subagents/list` is a live Session query, unlike the `subagent/start`/`subagent/end`
   * lifecycle frames the Remote waterfall never forwards to this client, so an agent that
   * started while we were disconnected still counts and a duplicate frame cannot double it.
   * A read that fails reports 0: an unanswerable count must not block a reload, and a
   * runtime we cannot query owns nothing we can prove is alive.
   */
  async busy(): Promise<number> {
    try { await this.connect(); } catch { return 0; }
    let count = 0;
    for (const sessionId of this.sessions.keys()) count += await this.runningChildren(sessionId);
    return count;
  }
  private async runningChildren(parentSessionId: string): Promise<number> {
    try { return (await this.childEntries(parentSessionId)).filter(entry => entry.activity === 'running').length; } catch { return 0; }
  }
  /**
   * The subagent tree under one session, ready for a progress view: `subagents/list` is the
   * authoritative enumerator (the same route `busy` reads), and one `session/list` adds each
   * child's plan, label and timing. A child whose detail read fails still appears, so the view
   * never hides an agent it knows about. Breadth-first with a small bound, because a runaway
   * delegation tree must not turn a client poll into an unbounded walk.
   */
  async listSubagents(sessionId: string): Promise<SubagentView[]> {
    try { await this.connect(); } catch { return []; }
    const details = await this.sessionDetails().catch(() => new Map<string, SubagentDetail>());
    const views: SubagentView[] = [];
    const queue: Array<{ id: string; depth: number }> = [{ id: sessionId, depth: 0 }];
    const seen = new Set<string>([sessionId]);
    while (queue.length && views.length < MAX_SUBAGENTS) {
      const parent = queue.shift()!;
      for (const entry of await this.childEntries(parent.id).catch(() => [])) {
        if (seen.has(entry.id) || views.length >= MAX_SUBAGENTS) continue;
        seen.add(entry.id);
        const detail = details.get(entry.id);
        views.push({
          id: entry.id, parentId: parent.id, depth: parent.depth + 1,
          label: entry.label || detail?.label || detail?.title || 'Subagent',
          mode: entry.mode === 'continuable' ? 'continuable' : 'one-shot',
          activity: entry.activity === 'running' ? 'running' : 'inactive',
          ...(detail?.elapsedMs === undefined ? {} : { elapsedMs: detail.elapsedMs }),
          todos: detail?.todos ?? [],
        });
        if (entry.hasChildren && parent.depth + 1 < MAX_SUBAGENT_DEPTH) queue.push({ id: entry.id, depth: parent.depth + 1 });
      }
    }
    return views;
  }
  private async childEntries(parentSessionId: string) {
    const catalog = z.object({ entries: z.array(subagentEntrySchema) }).parse(await this.rpc('subagents/list', { parentSessionId }));
    return catalog.entries.filter(entry => entry.kind === 'child');
  }
  private async sessionDetails(): Promise<Map<string, SubagentDetail>> {
    // Each row is read on its own: one session with a projection this adapter does not understand
    // loses its own detail and nothing else.
    const value = z.object({ items: z.array(z.unknown()) }).parse(await this.rpc('session/list', { _request: {} }));
    const details = new Map<string, SubagentDetail>();
    for (const row of value.items) {
      const parsed = subagentDetailSchema.safeParse(row);
      if (!parsed.success) continue;
      const item = parsed.data;
      const timing = item.projections?.subagentTiming;
      // A live child is timed from its own start; a settled one keeps the duration it ran for.
      const elapsedMs = timing === undefined ? undefined : Math.max(0, timing.active ? Date.now() - timing.active.since : timing.settledMs ?? 0);
      details.set(item.sessionId, {
        ...(item.projections?.subagent?.identity?.label === undefined ? {} : { label: item.projections.subagent.identity.label }),
        ...(item.projections?.title == null ? {} : { title: item.projections.title }),
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
        todos: item.projections?.todos?.map(todo => ({ content: todo.content, status: todo.status })) ?? [],
      });
    }
    return details;
  }
  async health() { try { await this.connect(); return { online: true, message: 'Connected to the DSH host' }; } catch { return { online: false, message: this.lastError }; } }
  async createSession(options: { id: string; cwd: string }): Promise<RuntimeSession> {
    await this.connect();
    const created = z.object({ sessionId: z.string() }).passthrough().parse(await this.rpc('session/create', { request: { sessionId: options.id, cwd: options.cwd } }));
    const session: RuntimeSession = { id: created.sessionId, cwd: options.cwd, status: 'idle' }; this.sessions.set(session.id, session); return session;
  }
  async resumeSession(options: { id: string; cwd: string }): Promise<RuntimeSession> {
    await this.connect();
    // `session/create` idempotently adopts an existing id, but DSH hands its single
    // write handle to the first attached client only: a session already open
    // elsewhere (the DSH Web UI, for example) refuses adoption with
    // SessionAlreadyOwnedError. `session/list` reads stored rows without resuming an
    // Agent and `session/prompt` attaches the Agent on demand, so an existing session
    // is followed read-only instead of being claimed again.
    const existing = (await this.listSessions()).find(s => s.id === options.id);
    if (existing === undefined) await this.rpc('session/create', { request: { sessionId: options.id, cwd: options.cwd } });
    const session = existing ?? { id: options.id, cwd: options.cwd, status: 'idle' as const };
    this.sessions.set(session.id, session); this.follow(session.id); return session;
  }
  async listSessions(): Promise<RuntimeSession[]> {
    await this.connect();
    const value = z.object({ items: z.array(summarySchema) }).parse(await this.rpc('session/list', { _request: {} }));
    return value.items.map(s => ({ id: s.sessionId, cwd: s.cwd ?? '', status: s.running ? 'running' : 'idle' }));
  }
  /**
   * `session/modelCatalog` takes no arguments. The Host lists every registered provider
   * route without needing a resolved credential, so an empty `failures` list does not
   * mean a prompt will succeed — a missing key surfaces when a turn runs.
   */
  async modelCatalog(): Promise<ModelCatalog> {
    await this.connect();
    return modelCatalogSchema.parse(await this.rpc('session/modelCatalog', {}));
  }
  /**
   * `session/selectModel` returns the selection the Host resolved, which can differ from
   * the request: an absent `reasoningEffort` comes back filled with the model default.
   * An unknown route fails per-request with `session/model-unavailable` and leaves the
   * session intact, so callers should surface it as a rejected choice.
   */
  async setModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection> {
    await this.connect();
    const value = z.object({ selected: modelSelectionSchema }).parse(await this.rpc('session/selectModel', { request: { sessionId, ...selection } }));
    const session = this.sessions.get(sessionId); if (session) session.model = value.selected;
    return value.selected;
  }
  async sendMessage(sessionId: string, input: { id: string; text: string; steer?: boolean }) {
    await this.connect(); this.follow(sessionId);
    // `steer` joins the turn that is already running, `queue` waits behind it: that is the whole
    // difference between interrupting the agent and adding to its backlog.
    await this.rpc('session/prompt', { request: { requestId: input.id, sessionId, mode: input.steer ? 'steer' : 'queue', content: [{ type: 'text', text: input.text }] } });
  }
  async cancel(sessionId: string) { await this.connect(); await this.rpc('session/cancel', { request: { sessionId } }); }
  async approve(sessionId: string, requestId: string, decision: ApprovalDecision) {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId || pending.clientId !== this.clientId) throw new TurnwireError('APPROVAL_EXPIRED', 'The DSH approval has expired; wait for a new approval request');
    pending.resolving = true;
    try {
      await this.rpc('$events/result', { clientId: pending.clientId, eventId: requestId, outcome: { kind: 'result', value: decision === 'approved' ? 'allowed-once' : 'rejected' } });
      if (this.pending.delete(requestId)) this.emit(sessionId, { type: 'approval.resolved', requestId, decision });
    } catch (error) {
      pending.resolving = false;
      if (pending.cancelled && this.pending.delete(requestId)) this.emit(sessionId, { type: 'approval.resolved', requestId, decision: 'cancelled' });
      throw error;
    }
  }
  subscribe(sessionId: string, listener: (event: RuntimeEvent) => void) {
    const set = this.listeners.get(sessionId) ?? new Set(); set.add(listener); this.listeners.set(sessionId, set);
    if (this.clientId) this.follow(sessionId);
    return () => { set.delete(listener); if (!set.size) { this.listeners.delete(sessionId); const stream = [...this.streams].find(([, id]) => id === sessionId)?.[0]; if (stream) { this.send({ type: 'cancel', streamId: stream }); this.streams.delete(stream); } } };
  }
  private async authenticate() {
    if (this.cookie) return;
    if (!this.token) throw new TurnwireError('DSH_AUTH_REQUIRED', 'Set TURNWIRE_DSH_TOKEN, or set TURNWIRE_DSH_URL to the full URL DSH prints at startup');
    const url = new URL(this.url); url.searchParams.set('token', this.token);
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const cookie = response.headers.get('set-cookie');
    if (response.status !== 303 || !cookie) throw new TurnwireError('DSH_AUTH_FAILED', 'The DSH launch token is invalid; copy the current token from the DSH terminal output');
    this.cookie = cookie.split(';')[0]!;
    await response.body?.cancel();
  }
  private async rpc(endpoint: string, args: unknown): Promise<unknown> {
    await this.authenticate();
    const rpcId = randomUUID();
    const response = await fetch(new URL(`/api/${endpoint}`, this.url), { method: 'POST', headers: { 'content-type': 'application/json', cookie: this.cookie }, body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }), signal: AbortSignal.timeout(30_000) });
    if (response.status === 401) this.cookie = '';
    if (!response.ok) throw new TurnwireError('DSH_HTTP_ERROR', `DSH ${endpoint} returned HTTP ${response.status}`);
    const envelope = z.object({ type: z.literal('server-response'), rpcId: z.literal(rpcId), result: resultSchema }).parse(await response.json());
    const parsed = envelope.result;
    if (!parsed.ok) throw new TurnwireError(parsed.error.code, parsed.error.message);
    return parsed.value;
  }
  private async connect(): Promise<void> {
    if (this.closed) throw new Error('DSH adapter disposed');
    if (this.socket?.readyState === WebSocket.OPEN && this.clientId) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.authenticate();
      const url = new URL('/api/remote.mux', this.url); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url, { headers: { cookie: this.cookie }, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 8000 }); this.socket = socket;
        const timer = setTimeout(() => { socket.terminate(); reject(new Error('Timed out while opening the DSH event stream')); }, 10_000);
        socket.on('open', () => this.send({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }));
        socket.on('message', raw => {
          try {
            const frame = z.object({ type: z.enum(['item', 'error', 'end']), streamId: z.string(), value: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string() }).passthrough().optional() }).parse(JSON.parse(raw.toString()));
            if (frame.type !== 'item') throw new Error(frame.error?.message ?? `DSH stream ${frame.streamId} ended`);
            const value = record(frame.value);
            if (frame.streamId === 'events' && value.type === 'ready') {
              this.clientId = z.string().parse(value.clientId); clearTimeout(timer); resolve();
              for (const id of this.listeners.keys()) this.follow(id);
            } else if (frame.streamId === 'events') { void this.remoteEvent(value).catch(error => this.fail(error)); }
            else {
              const id = this.streams.get(frame.streamId);
              if (id) { const previous = this.queues.get(id) ?? Promise.resolve(); const next = previous.then(() => this.sessionFrame(id, value)).catch(error => this.fail(error)); this.queues.set(id, next); }
            }
          } catch (error) { clearTimeout(timer); reject(error); this.fail(error); }
        });
        socket.on('error', error => { clearTimeout(timer); reject(error); this.lastError = 'Cannot reach the DSH host; check that DSH is running and the address and token are correct'; });
        socket.on('unexpected-response', (_request, response) => { if (response.statusCode === 401) this.cookie = ''; response.resume(); clearTimeout(timer); reject(new Error(`DSH WebSocket returned HTTP ${response.statusCode}`)); socket.terminate(); });
        socket.on('close', () => { clearTimeout(timer); reject(new Error('The DSH connection closed')); if (this.socket !== socket) return; this.socket = undefined; this.clientId = undefined; this.streams.clear(); this.live.clear(); this.cancelPending();
          for (const id of this.listeners.keys()) this.emit(id, { type: 'status', status: 'interrupted' });
          if (!this.closed && this.listeners.size && !this.retry) this.retry = setTimeout(() => { this.retry = undefined; void this.connect().catch(() => {}); }, 2000);
        });
      });
    })();
    try { await this.connecting; } catch (error) { this.lastError = error instanceof TurnwireError ? error.message : 'Cannot reach the DSH host; check that DSH is running and the address and token are correct'; throw error; } finally {
      this.connecting = undefined;
      if (!this.closed && this.listeners.size && !this.clientId && !this.retry) this.retry = setTimeout(() => { this.retry = undefined; void this.connect().catch(() => {}); }, 2000);
    }
  }
  private follow(sessionId: string) {
    if (!this.clientId || [...this.streams.values()].includes(sessionId)) return;
    const streamId = randomUUID(); this.streams.set(streamId, sessionId);
    this.send({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 100, assistantStream: true } } } });
  }
  private async sessionFrame(id: string, value: Record<string, unknown>) {
    if (value.type === 'snapshot') {
      const cursor = this.cursors.get(id) ?? this.options.readCursor?.(id) ?? -1;
      const records = z.array(z.object({ type: z.literal('event'), event: wireEventSchema })).parse(value.records);
      let more = value.hasMore === true;
      while (more && records.length && records[0]!.event.seq > cursor + 1) {
        const page = record(await this.rpc('session/page', { request: { address: { kind: 'session', sessionId: id }, throughSeq: value.cursor, beforeSeq: records[0]!.event.seq, maxMessages: 100 } }));
        const older = z.array(z.object({ type: z.literal('event'), event: wireEventSchema })).parse(page.records);
        if (!older.length) break; records.unshift(...older); more = page.hasMore === true;
      }
      for (const entry of records) this.durable(id, entry.event);
      const active = record(record(value.assistantStream).activeAttempt);
      if (typeof active.attemptId === 'string') { const messageId = assistantId(id, active.turn, active.step); const text = compactText(active.stream); this.live.set(active.attemptId, { id: messageId, nextIndex: Number(active.nextIndex), text }); this.emit(id, { type: 'message.completed', messageId, text }); }
      // List's current status is authoritative even when all durable events were already seen.
      const rows = await this.listSessions(); const row = rows.find(s => s.id === id); if (row) this.emit(id, { type: 'status', status: row.status });
    } else if (value.type === 'event') this.durable(id, wireEventSchema.parse(value.event));
    else if (value.type === 'assistant-stream') {
      const frame = record(value.frame); const attemptId = String(frame.attemptId);
      if (frame.type === 'start') this.live.set(attemptId, { id: assistantId(id, frame.turn, frame.step), nextIndex: 0, text: '' });
      if (frame.type === 'chunk') {
        const live = this.live.get(attemptId); if (!live) throw new Error('DSH live stream missing baseline');
        if (frame.index !== live.nextIndex) throw new Error('DSH live stream index gap'); live.nextIndex++;
        const chunk = record(frame.chunk);
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') { live.text += chunk.text; this.emit(id, { type: 'message.delta', messageId: live.id, text: chunk.text }); }
      }
      if (frame.type === 'end') this.live.delete(attemptId);
    }
  }
  private durable(id: string, event: z.infer<typeof wireEventSchema>) {
    const cursor = this.cursors.get(id) ?? this.options.readCursor?.(id) ?? -1; if (event.seq <= cursor) return;
    for (const mapped of mapEvent(id, event)) this.emit(id, mapped);
    this.cursors.set(id, event.seq); this.options.saveCursor?.(id, event.seq);
  }
  private async remoteEvent(frame: Record<string, unknown>) {
    if (frame.type === 'cancel') { const id = String(frame.eventId); const pending = this.pending.get(id); if (pending) { if (pending.resolving) pending.cancelled = true; else { this.pending.delete(id); this.emit(pending.sessionId, { type: 'approval.resolved', requestId: id, decision: 'cancelled' }); } } }
    if (frame.type === 'emit') {
      const args = Array.isArray(frame.args) ? frame.args : [];
      if (frame.event === 'api-session/status' && typeof args[0] === 'string' && this.listeners.has(args[0])) this.emit(args[0], { type: 'status', status: args[1] === true ? 'running' : 'idle' });
      if (frame.event === 'api-session/error' && typeof args[0] === 'string') this.emit(args[0], { type: 'error', message: String(args[1]) });
    }
    if (frame.type !== 'waterfall' || !this.clientId) return;
    const sessionId = z.string().parse(frame.agentId); const eventId = z.string().parse(frame.eventId);
    if (frame.event !== 'approval/request' || !this.listeners.has(sessionId)) { await this.rpc('$events/result', { clientId: this.clientId, eventId, outcome: { kind: 'next' } }); return; }
    const request = record(frame.request);
    this.pending.set(eventId, { sessionId, clientId: this.clientId });
    this.emit(sessionId, { type: 'approval.requested', requestId: eventId, tool: String(request.toolName ?? 'tool call'), reason: String(request.reason ?? 'DSH asks for authorization to run this tool') });
  }
  private emit(id: string, event: RuntimeEvent) { if (event.type === 'model.selected') { const session = this.sessions.get(id); if (session) session.model = event.selection; } for (const listener of this.listeners.get(id) ?? []) listener(event); }
  private send(value: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value)); }
  private cancelPending() { for (const [id, pending] of this.pending) this.emit(pending.sessionId, { type: 'approval.resolved', requestId: id, decision: 'cancelled' }); this.pending.clear(); }
  private fail(error: unknown) { this.lastError = error instanceof Error ? error.message : 'DSH protocol error'; for (const id of this.listeners.keys()) this.emit(id, { type: 'error', message: this.lastError }); this.socket?.terminate(); }
  async dispose() { this.closed = true; if (this.retry) clearTimeout(this.retry); this.cancelPending(); this.listeners.clear(); this.socket?.terminate(); await Promise.allSettled(this.queues.values()); }
}
