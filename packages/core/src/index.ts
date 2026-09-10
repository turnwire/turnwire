import { randomUUID, createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { TurnwireError, errorResponse, methodSchemas, requestSchema } from '@turnwire/protocol';
import type { EventData, TurnwireEvent, Question, RpcRequest, RpcResponse, Session, Snapshot, NotificationStatus, PushSubscriptionData, WorkspaceEntry } from '@turnwire/protocol';
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
  /** How prompts accepted while a turn was running were sent, until the runtime echoes them back. */
  private promptModes = new Map<string, 'queue' | 'steer'>();
  /**
   * Prompts accepted behind a running turn, by message id. The journal records a prompt when the host
   * accepts it, which is where it was *written*; this is what lets the host say when the runtime
   * actually started it, and — because a prompt the model already has cannot be taken back — which
   * ones are still the reader's to change.
   */
  private waiting = new Map<string, { sessionId: string; started: boolean }>();
  /**
   * Sessions whose approvals are granted on arrival. Deliberately in memory only: delegating a
   * session's approvals is a decision about the work happening right now, and a host that restarts
   * should make someone look again rather than keep granting in the background.
   */
  private delegated = new Set<string>();
  /** Approvals the delegation is granting right now, so the journal can say nobody was asked. */
  private delegating = new Set<string>();
  /** Questions the agent is blocked on, keyed by approval-style id `${sessionId}:${requestId}`. */
  private questions = new Map<string, Question>();
  private runtimes: Map<string, AgentRuntime>;
  constructor(readonly store: Store, runtimes: AgentRuntime[], readonly device: { id: string; name: string }) { this.runtimes = new Map(runtimes.map(runtime => [runtime.id, runtime])); }
  async start() {
    // Interactive approvals belong to a live runtime connection and expire across daemon restarts.
    for (const approval of this.store.approvals()) if (approval.status === 'pending') this.publish({ type: 'approval.resolved', approval: { ...approval, status: 'cancelled' } });
    for (const session of this.store.sessions()) {
      this.update(session.id, { status: 'interrupted' });
      this.bind(session);
      try { const resumed = await this.runtime(session.runtimeId).resumeSession({ id: session.runtimeSessionId, cwd: session.cwd }); this.update(session.id, { status: resumed.status }); }
      catch (error) { this.publish({ type: 'session.error', sessionId: session.id, message: error instanceof Error ? error.message : 'Resume failed' }); }
    }
  }
  async snapshot(): Promise<Snapshot> {
    // A read that is about to report whether anything is running repairs a status left behind first.
    await this.reconcileStatuses();
    const runtimes = await Promise.all([...this.runtimes.values()].map(async runtime => ({ id: runtime.id, name: runtime.name, capabilities: runtime.capabilities(), ...(runtime.busy ? { busy: await runtime.busy().catch(() => 0) } : {}), ...await runtime.health().catch(error => ({ online: false, message: String(error) })) })));
    // Read all state and the cursor together after asynchronous health checks finish.
    // The delegated flag is host state, not a stored field, so the snapshot is where a client sees it.
    return { device: this.device, sessions: this.store.sessions().map(session => this.delegated.has(session.id) ? { ...session, autoApprove: true } : session), approvals: this.store.approvals().filter(a => a.status === 'pending'), questions: [...this.questions.values()].filter(question => question.status === 'pending'), runtimes, cursor: this.store.cursor() };
  }
  subscribe(listener: (event: TurnwireEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async handle(value: unknown, context?: { clientId: string }): Promise<RpcResponse> {
    const parsed = requestSchema.safeParse(value);
    // A rejected request still has to be answered in the asker's name. An unknown method is exactly
    // how an older host meets a newer client, and a response addressed to `invalid` is one no client
    // can match: a remote client drops it and waits for its own timeout, which reads as a dead button.
    if (!parsed.success) return errorResponse(typeof (value as { id?: unknown })?.id === 'string' ? (value as { id: string }).id : 'invalid', parsed.error);
    const request = parsed.data;
    try { methodSchemas[request.method].parse(request.params); } catch (error) { return errorResponse(request.id, error); }
    if (request.method === 'system.snapshot' || request.method === 'subagent.list' || request.method === 'subagent.history' || request.method === 'session.queue' || request.method === 'workspace.list' || request.method === 'events.list' || request.method === 'history.page' || request.method === 'inbox.page' || request.method === 'request.result' || request.method === 'notifications.status') {
      try { return { v: 1, id: request.id, ok: true, result: await this.execute(request, context) }; } catch (error) { return errorResponse(request.id, error); }
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ method: request.method, params: request.params, ...(request.method.startsWith('notifications.') ? { clientId: context?.clientId } : {}) })).digest('hex');
    const saved = this.store.request(request.id);
    if (saved) {
      if (saved.fingerprint !== fingerprint) return errorResponse(request.id, new TurnwireError('REQUEST_CONFLICT', 'Request ID is already used by another command'));
      return saved.result ?? this.inFlight.get(request.id) ?? errorResponse(request.id, new TurnwireError('OUTCOME_UNKNOWN', 'The daemon was interrupted while handling this request; check session state before sending a new request'));
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
      case 'notifications.status': return this.notifications?.status(context?.clientId) ?? { enabled: false, available: false, subscribed: false, queued: 0, message: 'Push notifications are not configured on this host' };
      case 'notifications.subscribe':
      case 'notifications.unsubscribe': {
        if (!context?.clientId || !this.notifications) throw new TurnwireError('NOT_AVAILABLE', 'Enable or disable notifications for this device from a paired phone');
        return request.method === 'notifications.subscribe' ? this.notifications.subscribe(context.clientId, methodSchemas['notifications.subscribe'].parse(request.params)) : this.notifications.unsubscribe(context.clientId);
      }
      case 'history.page': { const p = methodSchemas['history.page'].parse(request.params); this.session(p.sessionId); return this.store.history(p.sessionId, p.limit, p.before); }
      case 'session.queue': {
        const p = methodSchemas['session.queue'].parse(request.params);
        const session = this.session(p.sessionId); const runtime = this.runtime(session.runtimeId);
        const items = runtime.listQueue ? await runtime.listQueue(session.runtimeSessionId) : [];
        // A runtime keeps its inbox entry around after it has picked the prompt up, so a prompt the
        // host has already announced as started is filtered out here: it belongs to the transcript
        // now, and it is not something a reader can still take back.
        return { items: items.filter(item => !this.waiting.get(item.messageId)?.started) };
      }
      case 'subagent.history': {
        const p = methodSchemas['subagent.history'].parse(request.params);
        const session = this.session(p.sessionId); const runtime = this.runtime(session.runtimeId);
        if (!runtime.listSubagents || !runtime.subagentHistory) throw new TurnwireError('RUNTIME_UNAVAILABLE', 'This runtime does not expose child execution history');
        // Never let a client turn a known root session into an arbitrary runtime-session reader.
        const child = (await runtime.listSubagents(session.runtimeSessionId)).find(entry => entry.id === p.subagentId);
        if (!child) throw new TurnwireError('SESSION_NOT_FOUND', 'The subagent does not belong to this session or is no longer available');
        return runtime.subagentHistory(session.runtimeSessionId, child, { before: p.before, cursor: p.cursor, limit: p.limit });
      }
      case 'subagent.list': {
        const p = methodSchemas['subagent.list'].parse(request.params);
        const session = this.session(p.sessionId); const runtime = this.runtime(session.runtimeId);
        return { subagents: runtime.listSubagents ? await runtime.listSubagents(session.runtimeSessionId) : [] };
      }
      case 'events.list': { const p = methodSchemas['events.list'].parse(request.params); return { events: this.store.events(p.after, p.limit, p.sessionId), cursor: this.store.cursor() }; }
      case 'workspace.list': return this.listWorkspace(methodSchemas['workspace.list'].parse(request.params));
      case 'session.create': {
        const p = methodSchemas['session.create'].parse(request.params);
        if (!isAbsolute(p.cwd)) throw new TurnwireError('INVALID_WORKSPACE', 'Working directory must be an absolute path');
        const cwd = await realpath(p.cwd).catch(() => { throw new TurnwireError('INVALID_WORKSPACE', 'Working directory does not exist'); });
        if (!(await stat(cwd)).isDirectory()) throw new TurnwireError('INVALID_WORKSPACE', 'Working directory must be a folder');
        const runtime = this.runtime(p.runtimeId);
        // Checked before the runtime session exists, so an unlisted model cannot leave a
        // half-created session behind.
        if (p.model && runtime.setModel) await this.assertSelectable(runtime, p.model.provider, p.model.model);
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
        // An archived session has no work to approve, so its delegation ends with it.
        const p = methodSchemas['session.archive'].parse(request.params);
        return this.lock(p.sessionId, async () => {
          const session = this.session(p.sessionId);
          if (p.archived && (['running', 'waiting_approval'].includes(session.status) || this.store.approvals().some(a => a.sessionId === session.id && a.status === 'pending'))) throw new TurnwireError('SESSION_BUSY', 'Stop the task or resolve approvals before archiving the session');
          if (p.archived) this.delegated.delete(session.id);
          return this.update(session.id, { archived: p.archived });
        });
      }
      case 'session.message': {
        const p = methodSchemas['session.message'].parse(request.params);
        return this.lock(p.sessionId, async () => {
          const session = this.session(p.sessionId);
          this.requireActive(session);
          if (session.status === 'interrupted' || session.status === 'error') throw new TurnwireError('RESUME_REQUIRED', 'Resume this session before sending a message');
          // The runtime queues a prompt sent during a turn instead of interrupting it, so record which
          // happened: a client can then say so instead of leaving the user to guess.
          const running = session.status === 'running' || session.status === 'waiting_approval';
          const mode = p.steer ? 'steer' as const : 'queue' as const;
          // Recorded before the send: the runtime echoes the prompt back as an event while this call is
          // still in flight, and that echo is the message the journal keeps.
          if (running) this.promptModes.set(request.id, mode);
          if (running && mode === 'queue') this.waiting.set(request.id, { sessionId: session.id, started: false });
          await this.runtime(session.runtimeId).sendMessage(session.runtimeSessionId, { id: request.id, text: p.text, ...(p.steer ? { steer: true } : {}) });
          this.publish({ type: 'message.user', sessionId: session.id, messageId: request.id, text: p.text, ...(running ? (mode === 'steer' ? { steer: true } : { queued: true }) : {}) }, `${session.id}:user:${request.id}`);
          // The client is told which of the two happened, so it can put the prompt where it belongs
          // before the event stream catches up: a queued prompt belongs above the composer, not in
          // the flow, and waiting for a queue read to move it leaves it visible in the wrong place.
          return { accepted: true, messageId: request.id, ...(running && mode === 'queue' ? { queued: true } : {}) };
        });
      }
      case 'session.cancel': {
        const p = methodSchemas['session.cancel'].parse(request.params);
        // Cancellation is independent of the command lock, so a slow prompt cannot block Stop.
        const session = this.session(p.sessionId); await this.runtime(session.runtimeId).cancel(session.runtimeSessionId);
        // The runtime drops whatever was waiting with the turn, so none of it will be dispatched.
        for (const [messageId, entry] of this.waiting) if (entry.sessionId === session.id) this.waiting.delete(messageId);
        return { accepted: true };
      }
      case 'session.queueAction': {
        const p = methodSchemas['session.queueAction'].parse(request.params);
        const session = this.session(p.sessionId); this.requireActive(session);
        const runtime = this.runtime(session.runtimeId);
        const queueAction = runtime.queueAction?.bind(runtime);
        if (!queueAction) throw new TurnwireError('NOT_AVAILABLE', 'This runtime cannot change a prompt that is already waiting');
        return this.lock(p.sessionId, async () => {
          // Runtimes accept a change for an item they have already handed to the model, and taking it
          // would erase a prompt that is being answered right now from every client. The host knows
          // when it started, so that answer is the honest one.
          if (this.waiting.get(p.messageId)?.started) throw new TurnwireError('QUEUE_ITEM_STARTED', 'That prompt has already started running and cannot be taken back');
          await queueAction(session.runtimeSessionId, p.messageId, p.action);
          // The journal recorded the prompt as it was first sent. An edit or a steer would otherwise
          // leave the transcript describing a prompt that is not the one that ran, and a removal
          // would leave one that never did, so each outcome is written back under the command's own
          // id — a retry stays a no-op because the daemon replays the receipt instead of re-running.
          const source = `${p.sessionId}:queue:${p.action.kind}:${request.id}`;
          // Taking a prompt back or steering it settles it here: it will not be dispatched from the
          // queue, so there is no start left to announce.
          if (p.action.kind !== 'edit') this.waiting.delete(p.messageId);
          if (p.action.kind === 'remove') this.publish({ type: 'message.removed', sessionId: p.sessionId, messageId: p.messageId }, source);
          else if (p.action.kind === 'edit') this.publish({ type: 'message.updated', sessionId: p.sessionId, messageId: p.messageId, text: p.action.text }, source);
          else this.publish({ type: 'message.updated', sessionId: p.sessionId, messageId: p.messageId, queued: false, steer: true }, source);
          return { accepted: true };
        });
      }
      case 'session.setModel': {
        const p = methodSchemas['session.setModel'].parse(request.params);
        return this.lock(p.sessionId, async () => {
          const session = this.session(p.sessionId); this.requireActive(session);
          const runtime = this.runtime(session.runtimeId);
          if (!runtime.setModel) throw new TurnwireError('MODEL_SELECTION_UNSUPPORTED', 'This runtime does not support model selection');
          await this.assertSelectable(runtime, p.provider, p.model);
          const selection = await runtime.setModel(session.runtimeSessionId, { provider: p.provider, model: p.model, ...(p.reasoningEffort === undefined ? {} : { reasoningEffort: p.reasoningEffort }) }).catch(error => {
            // A rejected route is a rejected choice, not a session failure. Report it in the
            // client's language instead of leaking the runtime's adapter-internal wording.
            if (error instanceof TurnwireError && error.code === 'session/model-unavailable') throw new TurnwireError('MODEL_UNAVAILABLE', 'The selected model is currently unavailable; choose another from the model catalog');
            throw error;
          });
          return this.update(session.id, { model: selection });
        });
      }
      case 'model.catalog': {
        const p = methodSchemas['model.catalog'].parse(request.params);
        const runtime = p.runtimeId ? this.runtime(p.runtimeId) : this.selectableRuntime();
        if (!runtime.modelCatalog) throw new TurnwireError('MODEL_SELECTION_UNSUPPORTED', 'This runtime does not support model selection');
        return runtime.modelCatalog();
      }
      case 'session.autoApprove': {
        const p = methodSchemas['session.autoApprove'].parse(request.params);
        const session = this.session(p.sessionId); this.requireActive(session);
        if (p.enabled) { this.delegated.add(session.id); await this.grantPending(session.id); }
        else this.delegated.delete(session.id);
        const enabled = this.delegated.has(session.id);
        // Live state has no stored row to change, so clients learn it from this event.
        this.publish({ type: 'session.autoApprove', sessionId: session.id, auto: enabled });
        return { enabled };
      }
      case 'question.answer': {
        const p = methodSchemas['question.answer'].parse(request.params);
        const question = this.questions.get(p.questionId);
        if (!question || question.status !== 'pending') throw new TurnwireError('QUESTION_EXPIRED', 'That question was already answered or has expired');
        const session = this.session(question.sessionId); const runtime = this.runtime(session.runtimeId);
        const answerQuestion = runtime.answerQuestion?.bind(runtime);
        if (!answerQuestion) throw new TurnwireError('NOT_AVAILABLE', 'This runtime does not ask questions');
        return this.lock(`question:${p.questionId}`, async () => {
          await answerQuestion(session.runtimeSessionId, p.questionId.slice(question.sessionId.length + 1), p.answers);
          // The journal keeps what was asked and what was chosen, so a transcript can show the
          // decision rather than a tool call that simply ended.
          const answered = { ...question, status: 'answered' as const, answers: p.answers };
          this.questions.set(question.id, answered);
          this.publish({ type: 'question.resolved', question: answered });
          this.questions.delete(question.id);
          return { accepted: true };
        });
      }
      case 'approval.decide': {
        const p = methodSchemas['approval.decide'].parse(request.params);
        return this.lock(`approval:${p.approvalId}`, async () => {
          const approval = this.store.approval(p.approvalId);
          if (!approval || approval.status !== 'pending') throw new TurnwireError('APPROVAL_EXPIRED', 'Approval was already handled or has expired');
          const session = this.session(approval.sessionId);
          const requestId = approval.id.slice(session.id.length + 1);
          await this.runtime(session.runtimeId).approve(session.runtimeSessionId, requestId, p.decision);
          if (this.store.approval(approval.id)?.status === 'pending') this.publish({ type: 'approval.resolved', approval: { ...approval, status: p.decision } });
          return { accepted: true };
        });
      }
    }
  }
  /**
   * Grant every approval waiting on a delegated session. Each one goes through the same path a
   * client's decision takes, so the runtime sees an ordinary grant and the journal records who
   * answered — which here is the delegation itself, marked `auto`.
   */
  private async grantPending(sessionId: string) {
    for (const approval of this.store.approvals().filter(a => a.sessionId === sessionId && a.status === 'pending')) {
      const session = this.store.session(sessionId); if (!session) return;
      this.delegating.add(approval.id);
      try { await this.runtime(session.runtimeId).approve(session.runtimeSessionId, approval.id.slice(sessionId.length + 1), 'approved'); }
      catch { continue; }
      finally { this.delegating.delete(approval.id); }
      if (this.store.approval(approval.id)?.status === 'pending') this.publish({ type: 'approval.resolved', approval: { ...approval, status: 'approved', auto: true } });
    }
  }
  private runtime(id: string) { const runtime = this.runtimes.get(id); if (!runtime) throw new TurnwireError('RUNTIME_UNAVAILABLE', `Runtime ${id} is not configured`); return runtime; }
  /** The runtime a client sees a model catalog for when it does not name one. */
  private selectableRuntime() { const runtime = [...this.runtimes.values()].find(candidate => candidate.capabilities().modelSelection && candidate.modelCatalog); if (!runtime) throw new TurnwireError('MODEL_SELECTION_UNSUPPORTED', 'No runtime supports model selection'); return runtime; }
  /**
   * Models belong to the runtime, so a selection is only valid when the runtime's own catalog
   * lists that provider and model. Without this, a client can store an id the runtime does not
   * know and the failure only surfaces when the next turn tries to run it.
   */
  private async assertSelectable(runtime: AgentRuntime, provider: string, model: string) {
    if (!runtime.modelCatalog) return;
    const catalog = await runtime.modelCatalog();
    const listed = catalog.groups.some(group => group.id === provider && group.models.some(entry => entry.id === model));
    if (!listed) throw new TurnwireError('MODEL_UNAVAILABLE', 'The selected model is currently unavailable; choose another from the model catalog');
  }
  private requireActive(session: Session) { if (session.archived) throw new TurnwireError('SESSION_ARCHIVED', 'Unarchive this session before continuing'); }
  /**
   * Browsing exists so a client can choose a working directory instead of typing an absolute path,
   * which is the point on a phone. It reads folders only, one level at a time, and reports the home
   * directory so a client has somewhere to start; the same validation as `session.create` applies,
   * so a folder offered here is a folder that can actually host a session.
   */
  private async listWorkspace(p: { path?: string }) {
    const home = homedir(); const requested = p.path ?? home;
    if (!isAbsolute(requested)) throw new TurnwireError('INVALID_WORKSPACE', 'Working directory must be an absolute path');
    const path = await realpath(requested).catch(() => { throw new TurnwireError('INVALID_WORKSPACE', 'Working directory does not exist'); });
    if (!(await stat(path)).isDirectory()) throw new TurnwireError('INVALID_WORKSPACE', 'Working directory must be a folder');
    const found = await readdir(path, { withFileTypes: true }).catch(error => { throw new TurnwireError('WORKSPACE_UNREADABLE', `The host cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`); });
    const folders: WorkspaceEntry[] = [];
    for (const entry of found) {
      // Dotfolders are configuration and cache noise here; a typed path still reaches them.
      if (entry.name.startsWith('.')) continue;
      const child = join(path, entry.name);
      const directory = entry.isDirectory() || (entry.isSymbolicLink() && await stat(child).then(value => value.isDirectory()).catch(() => false));
      if (directory) folders.push({ name: entry.name, path: child });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const parent = dirname(path);
    // One level of a huge tree is still unbounded (a flat `node_modules`), so the client is told how
    // many folders exist even when it only receives the first page.
    return { path, home, ...(parent === path ? {} : { parent }), total: folders.length, entries: folders.slice(0, 1000) };
  }
  private reconciledAt = 0;
  /**
   * A daemon that dies in the middle of a turn leaves that session marked `running` with nothing running
   * behind it — and a host that only reloads when nothing runs would then never reload again, which is
   * exactly how a stale status can stall an update for hours. The runtime's own view is the authority, so
   * this repairs the status before it is reported. It is throttled, and it only touches a session that has
   * looked busy for a while: a turn that started a moment ago must not be mistaken for a left-over one.
   */
  private async reconcileStatuses() {
    const now = Date.now();
    const stale = this.store.sessions().filter(session => (session.status === 'running' || session.status === 'waiting_approval') && now - Date.parse(session.updatedAt) > 30_000);
    if (!stale.length || now - this.reconciledAt < 15_000) return;
    this.reconciledAt = now;
    for (const [id, runtime] of this.runtimes) {
      const claimed = stale.filter(session => session.runtimeId === id);
      if (!claimed.length || !runtime.listSessions) continue;
      // A runtime that cannot be asked leaves the status alone: guessing is worse than waiting.
      const rows = await runtime.listSessions().catch(() => undefined);
      if (!rows) continue;
      const running = new Set(rows.filter(row => row.status === 'running').map(row => row.id));
      for (const session of claimed) if (!running.has(session.runtimeSessionId)) this.update(session.id, { status: 'interrupted' });
    }
  }
  private session(id: string) { const session = this.store.session(id); if (!session) throw new TurnwireError('SESSION_NOT_FOUND', 'Session not found'); return session; }
  /**
   * Records that a queued prompt has started running. The journal keeps a prompt where it was written,
   * which is in the middle of the answer it waited behind, so this is the event that says where it
   * really belongs and that it is no longer waiting. A runtime starts one turn at a time, so the
   * prompt that has been waiting longest is the one a new turn begins with.
   */
  private startWaiting(sessionId: string) {
    for (const [messageId, entry] of this.waiting) {
      if (entry.sessionId !== sessionId || entry.started) continue;
      entry.started = true;
      this.publish({ type: 'message.updated', sessionId, messageId, queued: false }, `${sessionId}:queue:started:${messageId}`);
      return;
    }
  }
  private bind(session: Session) {
    if (this.subscriptions.has(session.id)) return;
    const runtime = this.runtimes.get(session.runtimeId); if (!runtime) return;
    this.subscriptions.set(session.id, runtime.subscribe(session.runtimeSessionId, event => this.accept(session.id, event)));
  }
  private accept(sessionId: string, event: RuntimeEvent) {
    if (event.type === 'status') {
      const previous = this.store.session(sessionId)?.status;
      const status = event.status === 'running' && this.store.approvals().some(a => a.sessionId === sessionId && a.status === 'pending') ? 'waiting_approval' : event.status;
      this.update(sessionId, { status });
      // A new turn starting is when the runtime picks up the prompt that has been waiting longest; the
      // journal recorded that prompt where it was written, inside the answer it was waiting behind.
      if (event.status === 'running' && previous === 'idle') this.startWaiting(sessionId);
      return;
    }
    if (event.type === 'error') { this.update(sessionId, { status: 'error' }); this.publish({ type: 'session.error', sessionId, message: event.message }); return; }
    if (event.type === 'approval.requested') {
      this.publish({ type: 'approval.requested', approval: { id: `${sessionId}:${event.requestId}`, sessionId, tool: event.tool, reason: event.reason, status: 'pending', createdAt: new Date().toISOString() } });
      this.update(sessionId, { status: 'waiting_approval' });
      // The request still reaches the journal first, so a client watching sees what was granted for
      // it even though nobody was asked.
      if (this.delegated.has(sessionId)) void this.grantPending(sessionId).catch(() => {});
      return;
    }
    if (event.type === 'question.requested') {
      const question: Question = { id: `${sessionId}:${event.requestId}`, sessionId, questions: event.questions, status: 'pending', createdAt: new Date().toISOString() };
      this.questions.set(question.id, question);
      this.publish({ type: 'question.requested', question });
      return;
    }
    if (event.type === 'question.resolved') {
      const question = this.questions.get(`${sessionId}:${event.requestId}`);
      if (question?.status === 'pending') this.publish({ type: 'question.resolved', question: { ...question, status: event.decision === 'answered' ? 'answered' : 'cancelled' } });
      this.questions.delete(`${sessionId}:${event.requestId}`);
      return;
    }
    if (event.type === 'approval.resolved') {
      const approval = this.store.approval(`${sessionId}:${event.requestId}`);
      // The runtime echoes its own resolution, and that echo is what the store keeps — so a grant
      // made by the delegation has to be marked here, or it would read as a person's decision.
      if (approval?.status === 'pending') this.publish({ type: 'approval.resolved', approval: { ...approval, status: event.decision, ...(this.delegating.has(approval.id) ? { auto: true } : {}) } });
      if (!this.store.approvals().some(a => a.sessionId === sessionId && a.status === 'pending')) this.update(sessionId, { status: 'running' });
      return;
    }
    // A selection made anywhere in the Host (including its own Web UI) arrives here and
    // becomes the session's recorded model.
    if (event.type === 'model.selected') { this.update(sessionId, { model: event.selection }); return; }
    // The runtime echo is what the journal keeps, so how the prompt was sent has to ride on it.
    const mode = event.type === 'message.user' ? this.promptModes.get(event.messageId) : undefined;
    if (event.type === 'message.user') this.promptModes.delete(event.messageId);
    const source = event.type === 'message.user' ? `${sessionId}:user:${event.messageId}` : undefined;
    this.publish({ ...event, sessionId, ...(mode === 'steer' ? { steer: true } : mode === 'queue' ? { queued: true } : {}) }, source);
  }
  private update(id: string, patch: Partial<Session>): Session { const session = { ...this.session(id), ...patch, updatedAt: new Date().toISOString() }; this.publish({ type: 'session.updated', session }); return session; }
  private publish(data: EventData, source?: string) { const event = this.store.append(data, source); if (event) for (const listener of this.listeners) { try { listener(event); } catch { /* A disconnected client must not interrupt runtime state. */ } } }
  private async lock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation); this.locks.set(key, result);
    try { return await result; } finally { if (this.locks.get(key) === result) this.locks.delete(key); }
  }
  async dispose() { this.delegated.clear(); this.questions.clear(); this.waiting.clear(); for (const unsubscribe of this.subscriptions.values()) unsubscribe(); await Promise.allSettled(this.inFlight.values()); await Promise.allSettled([...this.runtimes.values()].map(r => r.dispose())); this.listeners.clear(); this.store.close(); }
}
