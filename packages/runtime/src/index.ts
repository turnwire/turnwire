import type { ApprovalDecision, RuntimeCapabilities, SessionStatus } from '@turnwire/protocol';
export type Unsubscribe = () => void;
export interface RuntimeSession { id: string; cwd: string; status: SessionStatus }
export type RuntimeEvent =
  | { type: 'status'; status: SessionStatus }
  | { type: 'message.delta' | 'message.completed'; messageId: string; text: string }
  | { type: 'message.user'; messageId: string; text: string }
  | { type: 'tool.started' | 'tool.finished'; callId: string; tool: string; detail: string; isError?: boolean }
  | { type: 'approval.requested'; requestId: string; tool: string; reason: string }
  | { type: 'approval.resolved'; requestId: string; decision: ApprovalDecision | 'cancelled' }
  | { type: 'error'; message: string };
export interface AgentRuntime {
  readonly id: string;
  readonly name: string;
  capabilities(): RuntimeCapabilities;
  health(): Promise<{ online: boolean; message: string }>;
  createSession(options: { id: string; cwd: string }): Promise<RuntimeSession>;
  resumeSession(session: { id: string; cwd: string }): Promise<RuntimeSession>;
  listSessions(): Promise<RuntimeSession[]>;
  sendMessage(sessionId: string, input: { id: string; text: string }): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  approve(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  subscribe(sessionId: string, listener: (event: RuntimeEvent) => void): Unsubscribe;
  dispose(): Promise<void>;
}
export { DemoRuntime } from './demo.js';
