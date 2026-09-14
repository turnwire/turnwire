import WebSocket from 'ws';
import { ContextProjection } from './context.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TurnwireError, methodSchemas, imageAttachmentSchema, isCanonicalBase64, MAX_IMAGE_BASE64_LENGTH, modelCatalogSchema, modelSelectionSchema, type ImageInput, type ImageAttachment } from '@turnwire/protocol';
import type { ApprovalDecision, ModelCatalog, ModelSelection, QueueAction, QueueItemView, QuestionAnswerItem, QuestionItem, RuntimeCapabilities, SubagentView, SubagentHistoryPage } from '@turnwire/protocol';
import type { AgentRuntime, RuntimeEvent, RuntimeSession } from '@turnwire/runtime';
import { assistantId, compactText, imageContent, mapEvent, record, wireEventSchema } from './mapper.js';
export { mapEvent, compactText } from './mapper.js';
import { historyPageSchema, historySnapshotSchema, historyRecords, liveHistoryRecord, type HistorySnapshot } from './history.js';

export const DSH_SOURCE_REVISION = 'fb2c4b9e698e30edb738bca4cf0618587db7d203';
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
const subagentDetailSchema = z.object({ sessionId: z.string(), projections: z.object({ values: z.object({
  title: z.string().nullable().optional(),
  todos: z.array(z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) })).nullable().optional(),
  // `session/list` reports a projection's client-facing value: the delegation label is flat here,
  // while the projection *cache* stores it under `identity`. Reading the cache's shape, or reading
  // these off `projections` instead of `projections.values`, silently finds nothing at all.
  subagent: z.object({ mode: z.string(), label: z.string().optional() }).nullable().optional(),
  subagentTiming: z.object({ settledMs: z.number().optional(), active: z.object({ since: z.number() }).optional() }).optional(),
}).optional() }).optional() }).passthrough();
interface SubagentDetail { label?: string; title?: string; elapsedMs?: number; todos: SubagentView['todos'] }
/** One prompt still waiting in a session's inbox, with the client id it arrived under. */
const inboxMessageSchema = z.object({ id: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()), source: z.object({ rpcId: z.string().optional() }).passthrough().optional() }).passthrough();
const sessionInboxSchema = z.object({ sessionId: z.string(), projections: z.object({ values: z.object({ inbox: z.object({ 'next-turn': z.array(z.unknown()), 'next-step': z.array(z.unknown()) }).optional() }).optional() }).optional() }).passthrough();
/** The Host's question item, as its own client UI receives it. */
const questionItemSchema = z.object({ id: z.string(), question: z.string(), detail: z.string().optional(), header: z.string().optional(), options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(), multiSelect: z.boolean().optional() }).passthrough();
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
  private contextAvailable = true;
  private contextProjection = new ContextProjection((id, context) => {
    const session = this.sessions.get(id); if (session) session.context = context;
    this.emit(id, { type: 'context', context });
  });
  private clearContext() {
    this.contextProjection.reset();
    for (const session of this.sessions.values()) delete session.context;
    for (const id of this.listeners.keys()) this.emit(id, { type: 'context' });
  }
  private streams = new Map<string, string>();
  private queues = new Map<string, Promise<void>>();
  private cursors = new Map<string, number>();
  private live = new Map<string, { id: string; nextIndex: number; text: string }>();
  private pending = new Map<string, { sessionId: string; clientId: string; resolving?: boolean; cancelled?: boolean }>();
  /** Question batches the Host is waiting on, keyed by their Remote event id. */
  private questions = new Map<string, { sessionId: string; clientId: string; resolving?: boolean; cancelled?: boolean }>();
  private childReads = new Map<string, { resolve: (snapshot: HistorySnapshot) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private childCuts = new Map<string, number>();
  private imageSends = new Map<string, { sessionId: string; messageId: string; count: number; resolve: (images: ImageAttachment[]) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private clientId?: string;
  private lastError = 'DSH is not connected yet';
  constructor(private options: DshOptions) {
    this.url = new URL(options.url); this.token = options.token ?? this.url.searchParams.get('token') ?? undefined;
    this.url.search = ''; this.url.hash = ''; this.url.pathname = '/';
    if (!['http:', 'https:'].includes(this.url.protocol)) throw new Error('DSH URL must use HTTP or HTTPS');
    if (this.url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname)) throw new Error('Non-loopback DSH connections require HTTPS');
  }
  capabilities(): RuntimeCapabilities { return { approvals: true, streaming: true, resume: true, shell: true, diff: false, fileEdits: true, toolCalls: true, backgroundTasks: false, modelSelection: true, imageInput: true }; }
  /** Count descendants of followed sessions. Unknown or bounded-out reads must never mean idle. */
  async busy(sessionIds?: string[]): Promise<number> {
    await this.connect();
    let count = 0;
    // Maintenance supplies durable managed roots, including roots not followed since restart.
    // Count every queued prompt, not just prompts carrying Turnwire RPC identities.
    if (sessionIds?.length) {
      const value = z.object({ items: z.array(sessionInboxSchema) }).parse(await this.rpc('session/list', { _request: {} }));
      for (const id of sessionIds) {
        const row = value.items.find(row => row.sessionId === id);
        const inbox = row?.projections?.values?.inbox;
        if (!inbox) throw new Error('Managed queue activity is unknown');
        count += inbox['next-turn'].length + inbox['next-step'].length;
      }
    }
    const queue = (sessionIds ?? [...this.sessions.keys()]).map(id => ({ id, depth: 0 }));
    const seen = new Set(queue.map(item => item.id));
    let examined = 0;
    while (queue.length) {
      const parent = queue.shift()!;
      for (const entry of await this.childEntries(parent.id)) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        if (++examined > MAX_SUBAGENTS) throw new Error('Runtime activity cannot be fully verified within the catalog limit');
        if (entry.activity !== 'running' && entry.activity !== 'inactive') throw new Error('Child activity is unknown');
        if (entry.activity === 'running') count++;
        if (entry.hasChildren) {
          if (parent.depth + 1 >= MAX_SUBAGENT_DEPTH) throw new Error('Runtime activity cannot be fully verified within the depth limit');
          queue.push({ id: entry.id, depth: parent.depth + 1 });
        }
      }
    }
    return count;
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
  /** Cold child-address reads only. Core supplies the authoritative descendant identity. */
  async subagentHistory(_sessionId: string, subagent: SubagentView, options: { before?: number; cursor?: number; limit: number }): Promise<SubagentHistoryPage> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100 ||
      (options.cursor !== undefined && (!Number.isSafeInteger(options.cursor) || options.cursor < -1)) ||
      (options.before !== undefined && (!Number.isSafeInteger(options.before) || options.before < 0 || options.cursor === undefined))) {
      throw new TurnwireError('INVALID_REQUEST', 'Invalid child history pagination');
    }
    await this.connect();
    const address = { kind: 'subagent', parentSessionId: subagent.parentId, childSessionId: subagent.id, mode: subagent.mode };
    const key = JSON.stringify(address);
    let cut = this.childCuts.get(key);
    const snapshot = options.before === undefined || cut === undefined ? await this.childSnapshot(address, options.limit) : undefined;
    const cursor = options.cursor ?? snapshot!.cursor;
    const readPage = async (before: number | undefined, limit = options.limit) => historyPageSchema.parse(await this.rpc('session/page', { request: { address, throughSeq: cursor, ...(before === undefined ? {} : { beforeSeq: before }), maxMessages: limit } }));
    const page = options.before === undefined && options.cursor === undefined ? snapshot! : await readPage(options.before);
    if (cut === undefined) {
      if (!snapshot!.header.isSeeded) cut = 0;
      else {
        // A resumed session adds untagged end-seed events. Only the LAST inherited marker
        // separates the child's own execution from its forked parent transcript.
        let boundaryPage = historyPageSchema.parse(snapshot);
        for (let count = 0; count < 20; count++) {
          const marker = boundaryPage.records.findLast(row => row.event.type === 'session/end-seed' && row.event.data.inherited === true);
          if (marker) { cut = marker.event.seq + 1; break; }
          const first = boundaryPage.records[0]?.event.seq;
          if (!boundaryPage.hasMore || first === undefined) break;
          boundaryPage = historyPageSchema.parse(await this.rpc('session/page', { request: { address, throughSeq: snapshot!.cursor, beforeSeq: first, maxMessages: 100 } }));
          if (boundaryPage.records[0]?.event.seq === first) break;
        }
        if (cut === undefined) throw new TurnwireError('RUNTIME_UNAVAILABLE', 'Cannot safely separate inherited child context within the history read bound');
      }
      if (this.childCuts.size >= 256) this.childCuts.delete(this.childCuts.keys().next().value!);
      this.childCuts.set(key, cut);
    }
    const own = page.records.map(row => row.event).filter(event => event.seq >= cut! && event.seq <= cursor);
    // One bounded look-behind supplies arguments when a message-aligned page starts with
    // a tool result. Stable call ids let clients coalesce the older call row on pagination.
    const first = page.records[0]?.event.seq;
    const context = first !== undefined && first > cut && own.some(event => event.type === 'tool/result')
      ? (await readPage(first, 1)).records.map(row => row.event).filter(event => event.seq >= cut!) : [];
    const records = historyRecords(subagent.id, own, context);
    if (snapshot && options.before === undefined && options.cursor === undefined) {
      const live = liveHistoryRecord(subagent.id, snapshot);
      if (live) { const index = records.findIndex(row => row.id === live.id); if (index >= 0) records[index] = live; else records.push(live); }
    }
    const hasMore = page.hasMore && first !== undefined && first > cut;
    return { subagent, records, cursor, hasMore, nextBefore: hasMore ? first! : null };
  }
  private childSnapshot(address: unknown, limit: number): Promise<HistorySnapshot> {
    if (this.childReads.size >= 32) return Promise.reject(new TurnwireError('RUNTIME_UNAVAILABLE', 'Too many child history reads'));
    return new Promise((resolve, reject) => {
      const streamId = `child-history:${randomUUID()}`;
      const timer = setTimeout(() => this.finishChildRead(streamId, undefined, new TurnwireError('RUNTIME_UNAVAILABLE', 'Child history read timed out')), 10_000);
      this.childReads.set(streamId, { resolve, reject, timer });
      this.send({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address, maxMessages: limit, assistantStream: true } } } });
    });
  }
  private finishChildRead(streamId: string, snapshot?: HistorySnapshot, error?: unknown) {
    const pending = this.childReads.get(streamId); if (!pending) return;
    this.childReads.delete(streamId); clearTimeout(pending.timer);
    this.send({ type: 'cancel', streamId });
    if (snapshot) pending.resolve(snapshot); else pending.reject(error ?? new TurnwireError('RUNTIME_UNAVAILABLE', 'Child history stream ended before its snapshot'));
  }
  private cancelChildReads() {
    for (const id of this.childReads.keys()) this.finishChildRead(id);
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
      const values = item.projections?.values;
      const timing = values?.subagentTiming;
      // A live child is timed from its own start; a settled one keeps the duration it ran for.
      const elapsedMs = timing === undefined ? undefined : Math.max(0, timing.active ? Date.now() - timing.active.since : timing.settledMs ?? 0);
      details.set(item.sessionId, {
        ...(values?.subagent?.label === undefined ? {} : { label: values.subagent.label }),
        ...(values?.title == null ? {} : { title: values.title }),
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
        todos: values?.todos?.map(todo => ({ content: todo.content, status: todo.status })) ?? [],
      });
    }
    return details;
  }
  /**
   * Change one prompt that has not run yet. The Host keys its queue by its own message id while a
   * client only knows the id Turnwire gave the prompt, so the pending inbox is read to translate
   * between them — the same projection the client is looking at, which means a stale client id
   * fails here instead of mutating a different prompt. `session/updateQueue` refuses an item that
   * has already left the queue, and that refusal is the same answer as never finding it.
   */
  async queueAction(sessionId: string, messageId: string, action: QueueAction): Promise<void> {
    await this.connect();
    const item = (await this.queuedItems(sessionId)).find(entry => entry.rpcId === messageId);
    if (!item) throw new TurnwireError('QUEUE_ITEM_GONE', 'That prompt is no longer waiting to run');
    try {
      await this.rpc('session/updateQueue', { request: { sessionId, itemId: item.itemId, action: action.kind === 'edit' ? { kind: 'edit', content: [{ type: 'text', text: action.text }] } : { kind: action.kind } } });
    } catch (error) {
      if (error instanceof TurnwireError && error.code === 'session/queue-item-not-found') throw new TurnwireError('QUEUE_ITEM_GONE', 'That prompt is no longer waiting to run');
      throw error;
    }
  }
  /** The prompts still waiting in one session, in the order the Host will run them. */
  /**
   * The prompts this session is still holding behind the running turn. A client that has just
   * loaded the page has seen no events, so this is the only way it can show what is queued — and
   * the text is read here rather than remembered from the send, so an edit made anywhere is what
   * the client renders.
   */
  async listQueue(sessionId: string): Promise<QueueItemView[]> {
    // Connection failure is not evidence that the runtime inbox is empty.
    await this.connect();
    return (await this.queuedItems(sessionId))
      .filter(entry => entry.rpcId !== undefined)
      .map(entry => ({ messageId: entry.rpcId!, target: entry.step ? 'next-step' as const : 'next-turn' as const, text: entry.text }));
  }
  private async queuedItems(sessionId: string): Promise<Array<{ itemId: string; rpcId?: string; step: boolean; text: string }>> {
    const value = z.object({ items: z.array(z.unknown()) }).parse(await this.rpc('session/list', { _request: {} }));
    for (const row of value.items) {
      const parsed = sessionInboxSchema.safeParse(row);
      if (!parsed.success || parsed.data.sessionId !== sessionId) continue;
      const inbox = parsed.data.projections?.values?.inbox;
      if (inbox === undefined) return [];
      const read = (entries: unknown[], step: boolean) => entries.flatMap(entry => {
        const message = inboxMessageSchema.safeParse(entry);
        if (!message.success) return [];
        return [{ itemId: message.data.id, step, text: message.data.content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('\n'), ...(message.data.source?.rpcId === undefined ? {} : { rpcId: message.data.source.rpcId }) }];
      });
      return [...read(inbox['next-step'], true), ...read(inbox['next-turn'], false)];
    }
    return [];
  }
  async health() { try { await this.connect(); return { online: true, message: 'Connected to the DSH host' }; } catch { return { online: false, message: this.lastError }; } }
  async createSession(options: { id: string; cwd: string }): Promise<RuntimeSession> {
    await this.connect();
    // Recovery of an uncertain allocation adopts the durable identity, never a new root.
    const existing = (await this.listSessions()).find(session => session.id === options.id);
    if (existing) { this.sessions.set(existing.id, existing); return existing; }
    if ((this.cursors.get(options.id) ?? this.options.readCursor?.(options.id) ?? -1) >= 0) throw new TurnwireError('RUNTIME_ROOT_MISSING', 'Runtime root is missing but its replay cursor still exists; refusing recreation');
    const created = z.object({ sessionId: z.literal(options.id) }).passthrough().parse(await this.rpc('session/create', { request: { sessionId: options.id, cwd: options.cwd } }));
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
    if (existing === undefined) throw new TurnwireError('RUNTIME_ROOT_MISSING', 'The persisted runtime root is missing; resume cannot recreate its history');
    const session = existing;
    this.sessions.set(session.id, session); this.follow(session.id); return session;
  }
  async listSessions(): Promise<RuntimeSession[]> {
    await this.connect();
    const value = z.object({ items: z.array(summarySchema) }).parse(await this.rpc('session/list', { _request: {} }));
    return value.items.map(s => ({ id: s.sessionId, cwd: s.cwd ?? '', status: s.running ? 'running' : 'idle', context: this.contextProjection.current(s.sessionId) }));
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
  async sendMessage(sessionId: string, input: { id: string; text: string; steer?: boolean; images?: ImageInput[] }): Promise<void | ImageAttachment[]> {
    const validated = methodSchemas['session.message'].parse({ sessionId, text: input.text, images: input.images, steer: input.steer });
    const images = validated.images ?? [];
    await this.connect();
    const key = JSON.stringify([sessionId, input.id]);
    if (images.length && (this.imageSends.has(key) || this.imageSends.size >= 32)) throw new TurnwireError('RUNTIME_UNAVAILABLE', 'Too many pending image prompts or duplicate request');
    let refs: Promise<ImageAttachment[]> | undefined;
    if (images.length) {
      refs = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.imageSends.delete(key);
          reject(new TurnwireError('OUTCOME_UNKNOWN', 'Image prompt outcome unknown: durable references did not arrive; reconnect before retrying'));
        }, 10_000);
        this.imageSends.set(key, { sessionId, messageId: input.id, count: images.length, resolve, reject, timer });
      });
      // A prompt RPC can outlive the echo timeout. Handle that rejection immediately.
      void refs.catch(() => {});
    }
    this.follow(sessionId);
    try {
      // The actual model's admission check is authoritative; never guess from a catalog cache.
      const accepted = this.rpc('session/prompt', { request: { requestId: input.id, sessionId, mode: input.steer ? 'steer' : 'queue', content: [{ type: 'text', text: input.text }, ...images.map(image => ({ type: 'image', ...image }))] } });
      if (refs) return (await Promise.all([accepted, refs]))[1];
      await accepted;
    } finally {
      const pending = this.imageSends.get(key);
      if (pending) { clearTimeout(pending.timer); this.imageSends.delete(key); pending.reject(new TurnwireError('RUNTIME_UNAVAILABLE', 'Image prompt did not complete')); }
    }
  }
  async readImage(sessionId: string, attachmentId: string): Promise<{ attachment: ImageAttachment; data: string }> {
    await this.connect();
    const value = z.object({ attachment: imageAttachmentSchema.strip(), data: z.string().max(MAX_IMAGE_BASE64_LENGTH) }).parse(await this.rpc('session/attachment', { request: { sessionId, attachmentId } }));
    if (value.attachment.attachmentId !== attachmentId || !isCanonicalBase64(value.data) || Buffer.from(value.data, 'base64').length !== value.attachment.bytes) throw new TurnwireError('RUNTIME_UNAVAILABLE', 'Invalid image attachment response');
    return value;
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
  /**
   * Answer a question batch. The Host's waterfall expects the whole batch at once, and the answer
   * is the structured shape its own client UI sends, so nothing here interprets the choices.
   */
  async answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswerItem[]) {
    const pending = this.questions.get(requestId);
    if (!pending || pending.resolving || pending.sessionId !== sessionId || pending.clientId !== this.clientId) throw new TurnwireError('QUESTION_EXPIRED', 'That question has already been answered or has expired');
    pending.resolving = true;
    try {
      await this.rpc('$events/result', { clientId: pending.clientId, eventId: requestId, outcome: { kind: 'result', value: { answers } } });
      if (this.questions.get(requestId) !== pending) throw new TurnwireError('QUESTION_EXPIRED', 'Question connection expired while answering');
      this.questions.delete(requestId);
      // Core owns the complete answered transition (including answers). Remote cancel while
      // resolving is waterfall cleanup; successful RPC confirmation wins over that echo.
    } catch (error) {
      pending.resolving = false;
      if (pending.cancelled && this.questions.get(requestId) === pending) { this.questions.delete(requestId); this.emit(sessionId, { type: 'question.resolved', requestId, decision: 'cancelled' }); }
      throw error;
    }
  }
  subscribe(sessionId: string, listener: (event: RuntimeEvent) => void) {
    const set = this.listeners.get(sessionId) ?? new Set(); set.add(listener); this.listeners.set(sessionId, set);
    listener({ type: 'context', context: this.contextProjection.current(sessionId) });
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
          if (this.socket !== socket) return;
          try {
            const frame = z.object({ type: z.enum(['item', 'error', 'end', 'cancel']), streamId: z.string(), value: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string() }).passthrough().optional() }).parse(JSON.parse(raw.toString()));
            // Temporary reads have independent lifecycles. Late cancel/end acknowledgements
            // remain harmless after the pending entry is removed; never poison root streams.
            if (frame.streamId.startsWith('child-history:')) {
              if (this.childReads.has(frame.streamId)) {
                if (frame.type !== 'item') this.finishChildRead(frame.streamId, undefined, new TurnwireError('RUNTIME_UNAVAILABLE', frame.error?.message ?? 'Child history stream ended'));
                else {
                  try { this.finishChildRead(frame.streamId, historySnapshotSchema.parse(frame.value)); }
                  catch { this.finishChildRead(frame.streamId, undefined, new TurnwireError('RUNTIME_UNAVAILABLE', 'Invalid child history snapshot')); }
                }
              }
              return;
            }
            if (frame.streamId === 'context-control') {
              if (frame.type === 'item') this.contextProjection.frame(record(frame.value));
              else { this.contextAvailable = false; this.clearContext(); }
              return;
            }
            if (frame.type !== 'item') throw new Error(frame.error?.message ?? `DSH stream ${frame.streamId} ended`);
            const value = record(frame.value);
            if (frame.streamId === 'events' && value.type === 'ready') {
              this.clientId = z.string().parse(value.clientId); clearTimeout(timer); resolve();
              this.contextAvailable = true;
              this.send({ type: 'open', streamId: 'context-control', endpoint: 'session/control', payload: { args: {} } });
              for (const id of this.listeners.keys()) this.follow(id);
            } else if (frame.streamId === 'events') { void this.remoteEvent(value).catch(error => this.fail(error)); }
            else {
              const id = this.streams.get(frame.streamId);
              if (id) { const previous = this.queues.get(id) ?? Promise.resolve(); const next = previous.then(() => { if (this.socket === socket && this.streams.get(frame.streamId) === id) return this.sessionFrame(id, value, () => this.socket === socket && this.streams.get(frame.streamId) === id); }).catch(error => this.fail(error)); this.queues.set(id, next); }
            }
          } catch (error) { clearTimeout(timer); reject(error); this.fail(error); }
        });
        socket.on('error', error => { clearTimeout(timer); reject(error); this.lastError = 'Cannot reach the DSH host; check that DSH is running and the address and token are correct'; });
        socket.on('unexpected-response', (_request, response) => { if (response.statusCode === 401) this.cookie = ''; response.resume(); clearTimeout(timer); reject(new Error(`DSH WebSocket returned HTTP ${response.statusCode}`)); socket.terminate(); });
        socket.on('close', () => { clearTimeout(timer); reject(new Error('The DSH connection closed')); if (this.socket !== socket) return; this.socket = undefined; this.clientId = undefined; this.clearContext(); this.streams.clear(); this.live.clear(); this.cancelPending(); this.cancelChildReads();
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
  private async sessionFrame(id: string, value: Record<string, unknown>, current = () => true) {
    if (value.type === 'snapshot') {
      const cursor = this.cursors.get(id) ?? this.options.readCursor?.(id) ?? -1;
      if (record(value.header).id !== id || typeof value.cursor !== 'number' || value.cursor < cursor) throw new TurnwireError('RUNTIME_IDENTITY_MISMATCH', 'Runtime snapshot identity or replay cursor regressed; refusing history reuse');
      const records = z.array(z.object({ type: z.literal('event'), event: wireEventSchema })).parse(value.records);
      let more = value.hasMore === true;
      while (more && records.length && records[0]!.event.seq > cursor + 1) {
        const page = record(await this.rpc('session/page', { request: { address: { kind: 'session', sessionId: id }, throughSeq: value.cursor, beforeSeq: records[0]!.event.seq, maxMessages: 100 } }));
        const older = z.array(z.object({ type: z.literal('event'), event: wireEventSchema })).parse(page.records);
        if (!older.length) break; records.unshift(...older); more = page.hasMore === true;
      }
      if (!current()) return;
      if (this.contextAvailable) this.contextProjection.baseline(id, value.projections);
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
    const mappedEvents = mapEvent(id, event);
    // Admission is durable in the inbox before a busy agent consumes user/message.
    // Observe replay behind the saved cursor too: retries still need the native refs.
    const messages = event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' && Array.isArray(event.data.inserted) ? event.data.inserted.map(record) : [];
    for (const message of messages) {
      const source = record(message.source);
      if (source.kind !== 'user' || typeof source.rpcId !== 'string') continue;
      const key = JSON.stringify([id, source.rpcId]);
      const pending = this.imageSends.get(key);
      if (!pending) continue;
      const images = imageContent(message.content);
      clearTimeout(pending.timer); this.imageSends.delete(key);
      if (images.length === pending.count) pending.resolve(images);
      else pending.reject(new TurnwireError('OUTCOME_UNKNOWN', 'Image prompt accepted with incomplete references; reconnect before retrying'));
    }
    const cursor = this.cursors.get(id) ?? this.options.readCursor?.(id) ?? -1; if (event.seq <= cursor) return;
    for (const mapped of mappedEvents) this.emit(id, mapped);
    this.cursors.set(id, event.seq); this.options.saveCursor?.(id, event.seq);
  }
  private async remoteEvent(frame: Record<string, unknown>) {
    if (frame.type === 'cancel') {
      const id = String(frame.eventId); const pending = this.pending.get(id);
      if (pending) { if (pending.resolving) pending.cancelled = true; else { this.pending.delete(id); this.emit(pending.sessionId, { type: 'approval.resolved', requestId: id, decision: 'cancelled' }); } }
      // A question the Host has given up on — an aborted turn, for instance — leaves no panel behind.
      const question = this.questions.get(id);
      if (question) { if (question.resolving) question.cancelled = true; else { this.questions.delete(id); this.emit(question.sessionId, { type: 'question.resolved', requestId: id, decision: 'cancelled' }); } }
    }
    if (frame.type === 'emit') {
      const args = Array.isArray(frame.args) ? frame.args : [];
      if (frame.event === 'api-session/status' && typeof args[0] === 'string' && this.listeners.has(args[0])) this.emit(args[0], { type: 'status', status: args[1] === true ? 'running' : 'idle' });
      if (frame.event === 'api-session/error' && typeof args[0] === 'string') this.emit(args[0], { type: 'error', message: String(args[1]) });
    }
    if (frame.type !== 'waterfall' || !this.clientId) return;
    const sessionId = z.string().parse(frame.agentId); const eventId = z.string().parse(frame.eventId);
    const request = record(frame.request);
    // A question is the agent asking, so it is offered to whoever is watching this session. With
    // nobody watching — or with a waterfall event this adapter does not carry — the Host's other
    // answerers get their turn instead of being answered on someone else's behalf.
    if (frame.event === 'user-questions/request' && this.listeners.has(sessionId)) {
      this.questions.set(eventId, { sessionId, clientId: this.clientId });
      this.emit(sessionId, { type: 'question.requested', requestId: eventId, questions: z.array(questionItemSchema).parse(request.questions) });
      return;
    }
    if (frame.event !== 'approval/request' || !this.listeners.has(sessionId)) { await this.rpc('$events/result', { clientId: this.clientId, eventId, outcome: { kind: 'next' } }); return; }
    this.pending.set(eventId, { sessionId, clientId: this.clientId });
    this.emit(sessionId, { type: 'approval.requested', requestId: eventId, tool: String(request.toolName ?? 'tool call'), reason: String(request.reason ?? 'DSH asks for authorization to run this tool') });
  }
  private emit(id: string, event: RuntimeEvent) { if (event.type === 'model.selected') { const session = this.sessions.get(id); if (session) session.model = event.selection; } for (const listener of this.listeners.get(id) ?? []) listener(event); }
  private send(value: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value)); }
  private cancelPending() {
    for (const pending of this.imageSends.values()) { clearTimeout(pending.timer); pending.reject(new TurnwireError('OUTCOME_UNKNOWN', 'DSH disconnected before image references arrived; reconnect before retrying')); }
    this.imageSends.clear();
    for (const [id, pending] of this.pending) this.emit(pending.sessionId, { type: 'approval.resolved', requestId: id, decision: 'cancelled' });
    this.pending.clear();
    for (const [id, question] of this.questions) this.emit(question.sessionId, { type: 'question.resolved', requestId: id, decision: 'cancelled' });
    this.questions.clear();
  }
  private fail(error: unknown) { this.lastError = error instanceof Error ? error.message : 'DSH protocol error'; for (const id of this.listeners.keys()) this.emit(id, { type: 'error', message: this.lastError }); this.socket?.terminate(); }
  async dispose() { this.closed = true; if (this.retry) clearTimeout(this.retry); this.cancelPending(); this.cancelChildReads(); this.childCuts.clear(); this.listeners.clear(); this.socket?.terminate(); await Promise.allSettled(this.queues.values()); }
}
