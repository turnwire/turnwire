import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, QueueAction, QueueItemView, QuestionAnswerItem, RuntimeCapabilities } from '@turnwire/protocol';
import { TurnwireError } from '@turnwire/protocol';
import type { AgentRuntime, RuntimeEvent, RuntimeSession } from './index.js';

/** Explicit development simulator. It never executes tools or calls an LLM. */
export class DemoRuntime implements AgentRuntime {
  readonly id = 'demo';
  readonly name = 'Demo · offline';
  private sessions = new Map<string, RuntimeSession>();
  private listeners = new Map<string, Set<(event: RuntimeEvent) => void>>();
  private pending = new Map<string, { sessionId: string; messageId: string }>();
  /**
   * Prompts that arrived while a turn was still going, held in order like a real runtime's queue.
   * The demo used to answer every prompt on the spot, which made a client's queue view impossible
   * to exercise offline: this is what `listQueue` reports and what drains when the turn ends.
   */
  private queues = new Map<string, Array<{ messageId: string; text: string }>>();
  /** Question batches this demo is waiting on, so the question surface works without a model. */
  private asked = new Map<string, string>();
  /** The last answers a client sent, for tests that assert what came back. */
  lastAnswers: QuestionAnswerItem[] = [];
  /** Replies a tool run still owes, so stopping the turn stops the answer it was going to give. */
  private replies = new Map<string, ReturnType<typeof setTimeout>>();
  capabilities(): RuntimeCapabilities { return { approvals: true, streaming: true, resume: true, shell: false, diff: false, fileEdits: false, toolCalls: true, backgroundTasks: false, modelSelection: false }; }
  async health() { return { online: true, message: 'Offline demo: runs no code and calls no model' }; }
  async createSession(options: { id: string; cwd: string }) { const session: RuntimeSession = { ...options, status: 'idle' }; this.sessions.set(session.id, session); return session; }
  async resumeSession(options: { id: string; cwd: string }) { return this.sessions.get(options.id) ?? this.createSession(options); }
  async listSessions() { return [...this.sessions.values()]; }
  async listQueue(sessionId: string): Promise<QueueItemView[]> { return (this.queues.get(sessionId) ?? []).map(item => ({ messageId: item.messageId, target: 'next-turn' as const, text: item.text })); }
  async queueAction(sessionId: string, messageId: string, action: QueueAction) {
    const queue = this.queues.get(sessionId) ?? [];
    const index = queue.findIndex(item => item.messageId === messageId);
    if (index < 0) throw new TurnwireError('QUEUE_ITEM_GONE', 'That prompt is no longer waiting to run');
    if (action.kind === 'edit') { queue[index] = { ...queue[index]!, text: action.text }; return; }
    const [item] = queue.splice(index, 1); this.queues.set(sessionId, queue);
    // Steering takes the prompt out of the queue and into the turn that is already running.
    if (action.kind === 'steer') this.answer(sessionId, item!.text);
  }
  async sendMessage(sessionId: string, input: { id: string; text: string; steer?: boolean }) {
    this.emit(sessionId, { type: 'message.user', messageId: input.id, text: input.text });
    // A prompt that arrives while a turn is going waits behind it, unless it steers that turn.
    if (input.steer !== true && this.running(sessionId)) {
      const queue = this.queues.get(sessionId) ?? []; queue.push({ messageId: input.id, text: input.text }); this.queues.set(sessionId, queue);
      return;
    }
    this.answer(sessionId, input.text);
  }
  async cancel(sessionId: string) {
    const owed = this.replies.get(sessionId); if (owed) { clearTimeout(owed); this.replies.delete(sessionId); }
    for (const [id, pending] of this.pending) if (pending.sessionId === sessionId) { this.pending.delete(id); this.emit(sessionId, { type: 'approval.resolved', requestId: id, decision: 'cancelled' }); }
    this.queues.delete(sessionId);
    for (const [id, owner] of this.asked) if (owner === sessionId) { this.asked.delete(id); this.emit(sessionId, { type: 'question.resolved', requestId: id, decision: 'cancelled' }); }
    this.emit(sessionId, { type: 'status', status: 'idle' });
  }
  async approve(sessionId: string, requestId: string, decision: ApprovalDecision) {
    if (this.pending.get(requestId)?.sessionId !== sessionId) throw new TurnwireError('APPROVAL_EXPIRED', 'The approval has expired');
    this.pending.delete(requestId); this.emit(sessionId, { type: 'approval.resolved', requestId, decision });
    this.emit(sessionId, { type: 'status', status: 'idle' });
    // The turn is over, so whatever was waiting behind it runs now.
    for (const item of this.queues.get(sessionId) ?? []) this.answer(sessionId, item.text);
    this.queues.delete(sessionId);
  }
  async answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswerItem[]) {
    if (!this.asked.has(requestId)) throw new TurnwireError('QUESTION_EXPIRED', 'That question has already been answered or has expired');
    this.asked.delete(requestId);
    this.lastAnswers = answers;
    this.emit(sessionId, { type: 'question.resolved', requestId, decision: 'answered' });
    // The turn the question belongs to can finish now; a real runtime resumes its own turn.
    this.emit(sessionId, { type: 'status', status: 'idle' });
  }
  subscribe(id: string, listener: (event: RuntimeEvent) => void) { const listeners = this.listeners.get(id) ?? new Set(); listeners.add(listener); this.listeners.set(id, listeners); return () => { listeners.delete(listener); }; }
  private running(sessionId: string) { return [...this.pending.values()].some(pending => pending.sessionId === sessionId); }
  /** Produce the demo's canned answer, and an approval when the prompt asks for one. */
  private answer(sessionId: string, prompt: string) {
    this.emit(sessionId, { type: 'status', status: 'running' });
    // A prompt that asks for a tool call produces one first, so a turn of several steps — a step
    // that acts, then a step that reports — can be exercised without a model behind it.
    if (/toolme/i.test(prompt)) { this.toolRun(sessionId, prompt); return; }
    this.reply(sessionId, prompt);
  }
  /**
   * A run of consecutive calls, which is the shape a client actually has to render: two calls settle
   * and the last one stays in flight while the turn keeps running, so a client that only ever saw
   * single finished calls would never exercise its group line, its in-flight row, or the nesting.
   */
  private toolRun(sessionId: string, prompt: string) {
    for (const command of ['echo demo', 'ls -la']) {
      const callId = randomUUID();
      this.emit(sessionId, { type: 'tool.started', callId, tool: 'shell', detail: JSON.stringify({ command }) });
      this.emit(sessionId, { type: 'tool.finished', callId, tool: 'shell', detail: command === 'echo demo' ? 'demo' : 'total 0' });
    }
    const callId = randomUUID();
    this.emit(sessionId, { type: 'tool.started', callId, tool: 'shell', detail: JSON.stringify({ command: 'npm test -- --run session-filter --reporter=verbose --coverage' }) });
    const timer = setTimeout(() => {
      this.replies.delete(sessionId);
      this.emit(sessionId, { type: 'tool.finished', callId, tool: 'shell', detail: 'ok · 3 passed' });
      this.reply(sessionId, prompt);
    }, 2500);
    this.replies.set(sessionId, timer);
    (timer as { unref?: () => void }).unref?.();
  }
  private reply(sessionId: string, prompt: string) {
    const messageId = randomUUID();
    const text = `This is Turnwire's offline demo session. Received: ${prompt}\n\nSessions, output and approvals sync to every connected client. Connect DSH to run real development tasks.`;
    this.emit(sessionId, { type: 'message.delta', messageId, text: text.slice(0, 24) });
    this.emit(sessionId, { type: 'message.completed', messageId, text });
    // A prompt that asks the demo to ask something produces a real question request, so the
    // question surface can be driven end to end without a model behind it.
    if (/askme|问一下/i.test(prompt)) {
      const requestId = randomUUID(); this.asked.set(requestId, sessionId);
      this.emit(sessionId, { type: 'question.requested', requestId, questions: [{ id: 'demo-1', header: 'Demo question', question: 'Which database should the demo use?', detail: 'The demo asks so a client can show the answer flow.', options: [{ label: 'SQLite', description: 'A single file' }, { label: 'Postgres', description: 'A server' }] }] });
      return;
    }
    if (/approval|approve|审批|批准/i.test(prompt)) {
      const requestId = randomUUID(); this.pending.set(requestId, { sessionId, messageId });
      this.emit(sessionId, { type: 'approval.requested', requestId, tool: 'demo approval', reason: 'Verifies cross-client approval sync. This action runs no command.' });
    } else this.emit(sessionId, { type: 'status', status: 'idle' });
  }
  private emit(id: string, event: RuntimeEvent) { if (event.type === 'status') { const session = this.sessions.get(id); if (session) session.status = event.status; } for (const listener of this.listeners.get(id) ?? []) listener(event); }
  async dispose() { for (const timer of this.replies.values()) clearTimeout(timer); this.replies.clear(); this.listeners.clear(); this.pending.clear(); this.queues.clear(); }
}
