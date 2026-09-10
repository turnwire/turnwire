import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TurnwireError } from '@turnwire/protocol';
import type { ApprovalDecision, RuntimeCapabilities } from '@turnwire/protocol';
import type { AgentRuntime, RuntimeEvent, RuntimeSession } from '@turnwire/runtime';
import { assistantId, compactText, mapEvent, record, wireEventSchema } from './mapper.js';
export { mapEvent, compactText } from './mapper.js';

export const DSH_SOURCE_REVISION = '5dda764ed3aa172535a7967b06ff95d9cbfe536a';
const resultSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.unknown() }), z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }).passthrough() })]);
const summarySchema = z.object({ sessionId: z.string(), running: z.boolean(), cwd: z.string().optional() }).passthrough();
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
  private lastError = 'DSH 尚未连接';
  constructor(private options: DshOptions) {
    this.url = new URL(options.url); this.token = options.token ?? this.url.searchParams.get('token') ?? undefined;
    this.url.search = ''; this.url.hash = ''; this.url.pathname = '/';
    if (!['http:', 'https:'].includes(this.url.protocol)) throw new Error('DSH URL must use HTTP or HTTPS');
    if (this.url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname)) throw new Error('Non-loopback DSH connections require HTTPS');
  }
  capabilities(): RuntimeCapabilities { return { approvals: true, streaming: true, resume: true, shell: true, diff: false, fileEdits: true, toolCalls: true, backgroundTasks: false }; }
  async health() { try { await this.connect(); return { online: true, message: 'DSH Host 已连接' }; } catch { return { online: false, message: this.lastError }; } }
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
  async sendMessage(sessionId: string, input: { id: string; text: string }) {
    await this.connect(); this.follow(sessionId);
    await this.rpc('session/prompt', { request: { requestId: input.id, sessionId, mode: 'queue', content: [{ type: 'text', text: input.text }] } });
  }
  async cancel(sessionId: string) { await this.connect(); await this.rpc('session/cancel', { request: { sessionId } }); }
  async approve(sessionId: string, requestId: string, decision: ApprovalDecision) {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId || pending.clientId !== this.clientId) throw new TurnwireError('APPROVAL_EXPIRED', 'DSH 审批已失效，请等待新的审批请求');
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
    if (!this.token) throw new TurnwireError('DSH_AUTH_REQUIRED', '请设置 TURNWIRE_DSH_TOKEN，或将 DSH 启动时输出的完整 URL 设置为 TURNWIRE_DSH_URL');
    const url = new URL(this.url); url.searchParams.set('token', this.token);
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const cookie = response.headers.get('set-cookie');
    if (response.status !== 303 || !cookie) throw new TurnwireError('DSH_AUTH_FAILED', 'DSH 启动令牌无效；请从 DSH 的终端输出复制当前令牌');
    this.cookie = cookie.split(';')[0]!;
    await response.body?.cancel();
  }
  private async rpc(endpoint: string, args: unknown): Promise<unknown> {
    await this.authenticate();
    const rpcId = randomUUID();
    const response = await fetch(new URL(`/api/${endpoint}`, this.url), { method: 'POST', headers: { 'content-type': 'application/json', cookie: this.cookie }, body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }), signal: AbortSignal.timeout(30_000) });
    if (response.status === 401) this.cookie = '';
    if (!response.ok) throw new TurnwireError('DSH_HTTP_ERROR', `DSH ${endpoint} 返回 HTTP ${response.status}`);
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
        const timer = setTimeout(() => { socket.terminate(); reject(new Error('DSH 事件流握手超时')); }, 10_000);
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
        socket.on('error', error => { clearTimeout(timer); reject(error); this.lastError = '无法连接 DSH Host，请确认 DSH 已启动及地址、令牌正确'; });
        socket.on('unexpected-response', (_request, response) => { if (response.statusCode === 401) this.cookie = ''; response.resume(); clearTimeout(timer); reject(new Error(`DSH WebSocket returned HTTP ${response.statusCode}`)); socket.terminate(); });
        socket.on('close', () => { clearTimeout(timer); reject(new Error('DSH 连接已断开')); if (this.socket !== socket) return; this.socket = undefined; this.clientId = undefined; this.streams.clear(); this.live.clear(); this.cancelPending();
          for (const id of this.listeners.keys()) this.emit(id, { type: 'status', status: 'interrupted' });
          if (!this.closed && this.listeners.size && !this.retry) this.retry = setTimeout(() => { this.retry = undefined; void this.connect().catch(() => {}); }, 2000);
        });
      });
    })();
    try { await this.connecting; } catch (error) { this.lastError = error instanceof TurnwireError ? error.message : '无法连接 DSH Host，请确认 DSH 已启动及地址、令牌正确'; throw error; } finally {
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
    this.emit(sessionId, { type: 'approval.requested', requestId: eventId, tool: String(request.toolName ?? '工具操作'), reason: String(request.reason ?? 'DSH 请求执行此操作的授权') });
  }
  private emit(id: string, event: RuntimeEvent) { for (const listener of this.listeners.get(id) ?? []) listener(event); }
  private send(value: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value)); }
  private cancelPending() { for (const [id, pending] of this.pending) this.emit(pending.sessionId, { type: 'approval.resolved', requestId: id, decision: 'cancelled' }); this.pending.clear(); }
  private fail(error: unknown) { this.lastError = error instanceof Error ? error.message : 'DSH protocol error'; for (const id of this.listeners.keys()) this.emit(id, { type: 'error', message: this.lastError }); this.socket?.terminate(); }
  async dispose() { this.closed = true; if (this.retry) clearTimeout(this.retry); this.cancelPending(); this.listeners.clear(); this.socket?.terminate(); await Promise.allSettled(this.queues.values()); }
}
