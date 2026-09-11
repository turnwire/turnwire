import type { ImageInput, ImageAttachment, ApprovalDecision, ModelCatalog, ModelSelection, QueueAction, QueueItemView, QuestionAnswerItem, QuestionItem, RuntimeCapabilities, SessionStatus, SubagentView, SubagentHistoryPage } from '@turnwire/protocol';
export type Unsubscribe = () => void;
export interface RuntimeSession { id: string; cwd: string; status: SessionStatus; model?: ModelSelection }
export type RuntimeEvent =
  | { type: 'status'; status: SessionStatus }
  | { type: 'message.delta' | 'message.completed'; messageId: string; text: string }
  | { type: 'message.user'; messageId: string; text: string; images?: ImageAttachment[] }
  | { type: 'tool.started' | 'tool.finished'; callId: string; tool: string; detail: string; isError?: boolean }
  | { type: 'approval.requested'; requestId: string; tool: string; reason: string }
  | { type: 'approval.resolved'; requestId: string; decision: ApprovalDecision | 'cancelled' }
  /** The runtime is blocked on a question; an answer goes back through `answerQuestion`. */
  | { type: 'question.requested'; requestId: string; questions: QuestionItem[] }
  | { type: 'question.resolved'; requestId: string; decision: 'answered' | 'cancelled' }
  | { type: 'model.selected'; selection: ModelSelection }
  | { type: 'error'; message: string };
export interface AgentRuntime {
  readonly id: string;
  readonly name: string;
  capabilities(): RuntimeCapabilities;
  health(): Promise<{ online: boolean; message: string }>;
  createSession(options: { id: string; cwd: string }): Promise<RuntimeSession>;
  resumeSession(session: { id: string; cwd: string }): Promise<RuntimeSession>;
  listSessions(): Promise<RuntimeSession[]>;
  /** Present when `capabilities().modelSelection` is true. */
  modelCatalog?(): Promise<ModelCatalog>;
  /**
   * Background agents this runtime still owns. A non-zero count means a restart is not a safe
   * point: those agents live inside the runtime process and would be killed with it. This is a
   * live query rather than a cached counter, so a missed or replayed lifecycle frame cannot
   * leave it stale, and it must resolve 0 instead of throwing when the runtime cannot answer.
   */
  busy?(): Promise<number>;
  /**
   * Background agents under one session, direct children first, for a progress view. A runtime that
   * cannot enumerate them leaves this out, and clients then render no agents at all.
   */
  listSubagents?(sessionId: string): Promise<SubagentView[]>;
  /** Core supplies a verified descendant; adapters must use the runtime's child-scoped read API. */
  subagentHistory?(sessionId: string, subagent: SubagentView, options: { before?: number; cursor?: number; limit: number }): Promise<SubagentHistoryPage>;
  /**
   * Change a prompt that has not run yet. `messageId` is the id the client was given for that
   * prompt; the runtime resolves it against its own queue. Runtimes without a queue leave this out.
   */
  queueAction?(sessionId: string, messageId: string, action: QueueAction): Promise<void>;
  /**
   * The prompts still waiting behind the running turn, in the order the runtime will run them. A
   * client that has just loaded the page has seen no events, so this — not its own history — is how
   * it knows what is queued. Runtimes without a queue leave this out and report nothing queued.
   */
  listQueue?(sessionId: string): Promise<QueueItemView[]>;
  /**
   * Apply a selection and return what the runtime accepted. A runtime resolves defaults
   * (for example a reasoning effort) and may reject an unknown route, so callers render
   * the returned selection rather than assuming the requested one.
   */
  setModel?(sessionId: string, selection: ModelSelection): Promise<ModelSelection>;
  /** Image sends resolve only after durable native user refs are available; never return inline bytes. */
  sendMessage(sessionId: string, input: { id: string; text: string; steer?: boolean; images?: ImageInput[] }): Promise<void | ImageAttachment[]>;
  /** Core verifies the reference in the public session before invoking this native scoped read. */
  readImage?(sessionId: string, attachmentId: string): Promise<{ attachment: ImageAttachment; data: string }>;
  cancel(sessionId: string): Promise<void>;
  approve(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  /** Answer a runtime's pending question batch. Present only when the runtime asks questions. */
  answerQuestion?(sessionId: string, requestId: string, answers: QuestionAnswerItem[]): Promise<void>;
  subscribe(sessionId: string, listener: (event: RuntimeEvent) => void): Unsubscribe;
  dispose(): Promise<void>;
}
export { DemoRuntime } from './demo.js';
