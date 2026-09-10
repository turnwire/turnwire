import { randomUUID, createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { TurnwireError, errorResponse, methodSchemas, requestSchema } from '@turnwire/protocol';
import type { EventData, TurnwireEvent, RpcRequest, RpcResponse, Session, Snapshot, NotificationStatus, PushSubscriptionData } from '@turnwire/protocol';
import type { AgentRuntime, RuntimeEvent } from '@turnwire/runtime';
import { Store } from './store.js';
export { Store } from './store.js';

export interface NotificationService { status(clientId?: string): NotificationStatus; subscribe(clientId: string, value: PushSubscriptionData): Promise<NotificationStatus>; unsubscribe(clientId: string): Promise<NotificationStatus> }
export class TurnwireCore {
  notifications?: NotificationService;
  private listeners = new Set<(event: TurnwireEvent) => void>();
  private subscriptions = new Map<string, () => void>();
  private inFlight = new Map<string, Promise<RpcResponse>>();
  private locks = new Map<string, Promise<unknown>>();
  private runtimes: Map<string, AgentRuntime>;
  constructor(readonly store: Store, runtimes: AgentRuntime[], readonly device: { id: string; name: string }) { this.runtimes = new Map(runtimes.map(runtime => [runtime.id, runtime])); }
  async start() {
    // Interactive approvals belong to a live runtime connection and expire across daemon restarts.
    for (const approval of this.store.approvals()) if (approval.status === 'pending') this.publish({ type: 'approval.resolved', approval: { ...approval, status: 'cancelled' } });
    for (const session of this.store.sessions()) {
      this.update(session.id, { status: 'interrupted' });
      this.bind(session);
      try { const resumed = await this.runtime(session.runtimeId).resumeSession({ id: session.runtimeSessionId, cwd: session.cwd }); this.update(session.id, { status: resumed.status }); }
      catch (error) { this.publish({ type: 'session.error', sessionId: session.id, message: error instanceof Error ? error.message : '恢复失败' }); }
    }
  }
  async snapshot(): Promise<Snapshot> {
    const runtimes = await Promise.all([...this.runtimes.values()].map(async runtime => ({ id: runtime.id, name: runtime.name, capabilities: runtime.capabilities(), ...await runtime.health().catch(error => ({ online: false, message: String(error) })) })));
    // Read all state and the cursor together after asynchronous health checks finish.
    return { device: this.device, sessions: this.store.sessions(), approvals: this.store.approvals().filter(a => a.status === 'pending'), runtimes, cursor: this.store.cursor() };
  }
  subscribe(listener: (event: TurnwireEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async handle(value: unknown, context?: { clientId: string }): Promise<RpcResponse> {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) return errorResponse('invalid', parsed.error);
    const request = parsed.data;
    try { methodSchemas[request.method].parse(request.params); } catch (error) { return errorResponse(request.id, error); }
    if (request.method === 'system.snapshot' || request.method === 'events.list' || request.method === 'history.page' || request.method === 'inbox.page' || request.method === 'request.result' || request.method === 'notifications.status') {
      try { return { v: 1, id: request.id, ok: true, result: await this.execute(request, context) }; } catch (error) { return errorResponse(request.id, error); }
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ method: request.method, params: request.params, ...(request.method.startsWith('notifications.') ? { clientId: context?.clientId } : {}) })).digest('hex');
    const saved = this.store.request(request.id);
    if (saved) {
      if (saved.fingerprint !== fingerprint) return errorResponse(request.id, new TurnwireError('REQUEST_CONFLICT', '请求 ID 已被另一条命令使用'));
      return saved.result ?? this.inFlight.get(request.id) ?? errorResponse(request.id, new TurnwireError('OUTCOME_UNKNOWN', 'daemon 在处理此请求时中断；请检查会话状态后再发送新请求'));
    }
    this.store.reserveRequest(request.id, fingerprint);
    const task = (async (): Promise<RpcResponse> => {
      let result: RpcResponse;
      try { result = { v: 1, id: request.id, ok: true, result: await this.execute(request, context) }; }
      catch (error) { result = errorResponse(request.id, error); }
      this.store.finishRequest(request.id, result); return result;
    })();
    this.inFlight.set(request.id, task);
    try { return await task; } finally { this.inFlight.delete(request.id); }
  }
  private async execute(request: RpcRequest, context?: { clientId: string }): Promise<unknown> {
    switch (request.method) {
      case 'system.snapshot': return this.snapshot();
      case 'request.result': { const { requestId } = methodSchemas['request.result'].parse(request.params); const saved = this.store.request(requestId); return !saved ? { state: 'not_found' } : saved.result ? { state: 'completed', response: saved.result } : { state: this.inFlight.has(requestId) ? 'pending' : 'unknown' }; }
      case 'inbox.page': { const p = methodSchemas['inbox.page'].parse(request.params); return this.store.inbox(p.limit, p.status, p.before); }
      case 'notifications.status': return this.notifications?.status(context?.clientId) ?? { enabled: false, available: false, subscribed: false, queued: 0, message: '此主机尚未配置推送' };
      case 'notifications.subscribe':
      case 'notifications.unsubscribe': {
        if (!context?.clientId || !this.notifications) throw new TurnwireError('NOT_AVAILABLE', '请从已配对的手机启用或关闭本设备通知');
        return request.method === 'notifications.subscribe' ? this.notifications.subscribe(context.clientId, methodSchemas['notifications.subscribe'].parse(request.params)) : this.notifications.unsubscribe(context.clientId);
      }
      case 'history.page': { const p = methodSchemas['history.page'].parse(request.params); this.session(p.sessionId); return this.store.history(p.sessionId, p.limit, p.before); }
      case 'events.list': { const p = methodSchemas['events.list'].parse(request.params); return { events: this.store.events(p.after, p.limit, p.sessionId), cursor: this.store.cursor() }; }
      case 'session.create': {
        const p = methodSchemas['session.create'].parse(request.params);
        if (!isAbsolute(p.cwd)) throw new TurnwireError('INVALID_WORKSPACE', '工作目录必须使用绝对路径');
        const cwd = await realpath(p.cwd).catch(() => { throw new TurnwireError('INVALID_WORKSPACE', '工作目录不存在'); });
        if (!(await stat(cwd)).isDirectory()) throw new TurnwireError('INVALID_WORKSPACE', '工作目录必须是文件夹');
        const runtime = this.runtime(p.runtimeId);
        const id = randomUUID();
        const created = await runtime.createSession({ id, cwd });
        // A model chosen at creation time goes through the same path as a later change, so
        // the session records what the runtime resolved rather than what was requested.
        const model = p.model && runtime.setModel ? await runtime.setModel(created.id, p.model) : undefined;
        const now = new Date().toISOString();
        const session: Session = { id, runtimeId: runtime.id, runtimeSessionId: created.id, title: p.title, cwd, status: created.status, createdAt: now, updatedAt: now, ...(model ? { model } : {}) };
        this.publish({ type: 'session.created', session }); this.bind(session); return session;
      }
      case 'session.resume': {
        const p = methodSchemas['session.resume'].parse(request.params);
        return this.lock(p.sessionId, async () => { const session = this.session(p.sessionId); this.requireActive(session); this.bind(session); const resumed = await this.runtime(session.runtimeId).resumeSession({ id: session.runtimeSessionId, cwd: session.cwd }); return this.update(session.id, { status: resumed.status }); });
      }
      case 'session.rename': {
        const p = methodSchemas['session.rename'].parse(request.params);
        return this.lock(p.sessionId, async () => this.update(p.sessionId, { title: p.title }));
      }
      case 'session.archive': {
        const p = methodSchemas['session.archive'].parse(request.params);
        return this.lock(p.sessionId, async () => {
          const session = this.session(p.sessionId);
          if (p.archived && (['running', 'waiting_approval'].includes(session.status) || this.store.approvals().some(a => a.sessionId === session.id && a.status === 'pending'))) throw new TurnwireError('SESSION_BUSY', '请先停止任务或处理审批，再归档会话');
          return this.update(session.id, { archived: p.archived });
        });
      }
      case 'session.message': {
        const p = methodSchemas['session.message'].parse(request.params);
        return this.lock(p.sessionId, async () => {
          const session = this.session(p.sessionId);
          this.requireActive(session);
          if (session.status === 'interrupted' || session.status === 'error') throw new TurnwireError('RESUME_REQUIRED', '请先恢复此会话，再发送消息');
          await this.runtime(session.runtimeId).sendMessage(session.runtimeSessionId, { id: request.id, text: p.text });
          this.publish({ type: 'message.user', sessionId: session.id, messageId: request.id, text: p.text }, `${session.id}:user:${request.id}`);
          return { accepted: true, messageId: request.id };
        });
      }
      case 'session.cancel': {
        const p = methodSchemas['session.cancel'].parse(request.params);
        // Cancellation is independent of the command lock, so a slow prompt cannot block Stop.
        const session = this.session(p.sessionId); await this.runtime(session.runtimeId).cancel(session.runtimeSessionId); return { accepted: true };
      }
      case 'session.setModel': {
        const p = methodSchemas['session.setModel'].parse(request.params);
        return this.lock(p.sessionId, async () => {
          const session = this.session(p.sessionId); this.requireActive(session);
          const runtime = this.runtime(session.runtimeId);
          if (!runtime.setModel) throw new TurnwireError('MODEL_SELECTION_UNSUPPORTED', '此运行时不支持选择模型');
          const selection = await runtime.setModel(session.runtimeSessionId, { provider: p.provider, model: p.model, ...(p.reasoningEffort === undefined ? {} : { reasoningEffort: p.reasoningEffort }) }).catch(error => {
            // A rejected route is a rejected choice, not a session failure. Report it in the
            // client's language instead of leaking the runtime's adapter-internal wording.
            if (error instanceof TurnwireError && error.code === 'session/model-unavailable') throw new TurnwireError('MODEL_UNAVAILABLE', '所选模型当前不可用，请从模型目录中重新选择');
            throw error;
          });
          return this.update(session.id, { model: selection });
        });
      }
      case 'model.catalog': {
        const p = methodSchemas['model.catalog'].parse(request.params);
        const runtime = p.runtimeId ? this.runtime(p.runtimeId) : this.selectableRuntime();
        if (!runtime.modelCatalog) throw new TurnwireError('MODEL_SELECTION_UNSUPPORTED', '此运行时不支持选择模型');
        return runtime.modelCatalog();
      }
      case 'approval.decide': {
        const p = methodSchemas['approval.decide'].parse(request.params);
        return this.lock(`approval:${p.approvalId}`, async () => {
          const approval = this.store.approval(p.approvalId);
          if (!approval || approval.status !== 'pending') throw new TurnwireError('APPROVAL_EXPIRED', '审批已处理或已失效');
          const session = this.session(approval.sessionId);
          const requestId = approval.id.slice(session.id.length + 1);
          await this.runtime(session.runtimeId).approve(session.runtimeSessionId, requestId, p.decision);
          if (this.store.approval(approval.id)?.status === 'pending') this.publish({ type: 'approval.resolved', approval: { ...approval, status: p.decision } });
          return { accepted: true };
        });
      }
    }
  }
  private runtime(id: string) { const runtime = this.runtimes.get(id); if (!runtime) throw new TurnwireError('RUNTIME_UNAVAILABLE', `运行时 ${id} 未配置`); return runtime; }
  /** The runtime a client sees a model catalog for when it does not name one. */
  private selectableRuntime() { const runtime = [...this.runtimes.values()].find(candidate => candidate.capabilities().modelSelection && candidate.modelCatalog); if (!runtime) throw new TurnwireError('MODEL_SELECTION_UNSUPPORTED', '当前没有支持选择模型的运行时'); return runtime; }
  private requireActive(session: Session) { if (session.archived) throw new TurnwireError('SESSION_ARCHIVED', '请先取消归档，再继续会话'); }
  private session(id: string) { const session = this.store.session(id); if (!session) throw new TurnwireError('SESSION_NOT_FOUND', '会话不存在'); return session; }
  private bind(session: Session) {
    if (this.subscriptions.has(session.id)) return;
    const runtime = this.runtimes.get(session.runtimeId); if (!runtime) return;
    this.subscriptions.set(session.id, runtime.subscribe(session.runtimeSessionId, event => this.accept(session.id, event)));
  }
  private accept(sessionId: string, event: RuntimeEvent) {
    if (event.type === 'status') { const status = event.status === 'running' && this.store.approvals().some(a => a.sessionId === sessionId && a.status === 'pending') ? 'waiting_approval' : event.status; this.update(sessionId, { status }); return; }
    if (event.type === 'error') { this.update(sessionId, { status: 'error' }); this.publish({ type: 'session.error', sessionId, message: event.message }); return; }
    if (event.type === 'approval.requested') {
      this.publish({ type: 'approval.requested', approval: { id: `${sessionId}:${event.requestId}`, sessionId, tool: event.tool, reason: event.reason, status: 'pending', createdAt: new Date().toISOString() } });
      this.update(sessionId, { status: 'waiting_approval' }); return;
    }
    if (event.type === 'approval.resolved') {
      const approval = this.store.approval(`${sessionId}:${event.requestId}`);
      if (approval?.status === 'pending') this.publish({ type: 'approval.resolved', approval: { ...approval, status: event.decision } });
      if (!this.store.approvals().some(a => a.sessionId === sessionId && a.status === 'pending')) this.update(sessionId, { status: 'running' });
      return;
    }
    // A selection made anywhere in the Host (including its own Web UI) arrives here and
    // becomes the session's recorded model.
    if (event.type === 'model.selected') { this.update(sessionId, { model: event.selection }); return; }
    const source = event.type === 'message.user' ? `${sessionId}:user:${event.messageId}` : undefined;
    this.publish({ ...event, sessionId }, source);
  }
  private update(id: string, patch: Partial<Session>): Session { const session = { ...this.session(id), ...patch, updatedAt: new Date().toISOString() }; this.publish({ type: 'session.updated', session }); return session; }
  private publish(data: EventData, source?: string) { const event = this.store.append(data, source); if (event) for (const listener of this.listeners) { try { listener(event); } catch { /* A disconnected client must not interrupt runtime state. */ } } }
  private async lock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation); this.locks.set(key, result);
    try { return await result; } finally { if (this.locks.get(key) === result) this.locks.delete(key); }
  }
  async dispose() { for (const unsubscribe of this.subscriptions.values()) unsubscribe(); await Promise.allSettled(this.inFlight.values()); await Promise.allSettled([...this.runtimes.values()].map(r => r.dispose())); this.listeners.clear(); this.store.close(); }
}
