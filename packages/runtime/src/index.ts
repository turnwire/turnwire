import type { ApprovalDecision, ModelCatalog, ModelSelection, RuntimeCapabilities, SessionStatus, SubagentView } from '@turnwire/protocol';
export type Unsubscribe = () => void;
export interface RuntimeSession { id: string; cwd: string; status: SessionStatus; model?: ModelSelection }
export type RuntimeEvent =
  | { type: 'status'; status: SessionStatus }
  | { type: 'message.delta' | 'message.completed'; messageId: string; text: string }
  | { type: 'message.user'; messageId: string; text: string }
  | { type: 'tool.started' | 'tool.finished'; callId: string; tool: string; detail: string; isError?: boolean }
  | { type: 'approval.requested'; requestId: string; tool: string; reason: string }
  | { type: 'approval.resolved'; requestId: string; decision: ApprovalDecision | 'cancelled' }
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
  /**
   * Apply a selection and return what the runtime accepted. A runtime resolves defaults
   * (for example a reasoning effort) and may reject an unknown route, so callers render
   * the returned selection rather than assuming the requested one.
   */
  setModel?(sessionId: string, selection: ModelSelection): Promise<ModelSelection>;
  sendMessage(sessionId: string, input: { id: string; text: string; steer?: boolean }): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  approve(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  subscribe(sessionId: string, listener: (event: RuntimeEvent) => void): Unsubscribe;
  dispose(): Promise<void>;
}
export { DemoRuntime } from './demo.js';
