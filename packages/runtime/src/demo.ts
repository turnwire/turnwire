import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, RuntimeCapabilities } from '@turnwire/protocol';
import { TurnwireError } from '@turnwire/protocol';
import type { AgentRuntime, RuntimeEvent, RuntimeSession } from './index.js';

/** Explicit development simulator. It never executes tools or calls an LLM. */
export class DemoRuntime implements AgentRuntime {
  readonly id = 'demo';
  readonly name = 'Demo · 离线演示';
  private sessions = new Map<string, RuntimeSession>();
  private listeners = new Map<string, Set<(event: RuntimeEvent) => void>>();
  private pending = new Map<string, { sessionId: string; messageId: string }>();
  capabilities(): RuntimeCapabilities { return { approvals: true, streaming: true, resume: true, shell: false, diff: false, fileEdits: false, toolCalls: false, backgroundTasks: false }; }
  async health() { return { online: true, message: '离线演示，不会执行代码或调用模型' }; }
  async createSession(options: { id: string; cwd: string }) { const session: RuntimeSession = { ...options, status: 'idle' }; this.sessions.set(session.id, session); return session; }
  async resumeSession(options: { id: string; cwd: string }) { return this.sessions.get(options.id) ?? this.createSession(options); }
  async listSessions() { return [...this.sessions.values()]; }
  async sendMessage(sessionId: string, input: { id: string; text: string }) {
    this.emit(sessionId, { type: 'message.user', messageId: input.id, text: input.text });
    this.emit(sessionId, { type: 'status', status: 'running' });
    const messageId = randomUUID();
    const text = `这是 Turnwire 的离线演示会话。已收到：${input.text}\n\n会话、输出和审批会同步到所有连接的客户端。连接 DSH 后可运行真实的开发任务。`;
    this.emit(sessionId, { type: 'message.delta', messageId, text: text.slice(0, 24) });
    this.emit(sessionId, { type: 'message.completed', messageId, text });
    if (/approval|approve|审批|批准/i.test(input.text)) {
      const requestId = randomUUID(); this.pending.set(requestId, { sessionId, messageId });
      this.emit(sessionId, { type: 'approval.requested', requestId, tool: '演示审批', reason: '验证跨端审批同步。此操作不会运行任何命令。' });
    } else this.emit(sessionId, { type: 'status', status: 'idle' });
  }
  async cancel(sessionId: string) {
    for (const [id, pending] of this.pending) if (pending.sessionId === sessionId) { this.pending.delete(id); this.emit(sessionId, { type: 'approval.resolved', requestId: id, decision: 'cancelled' }); }
    this.emit(sessionId, { type: 'status', status: 'idle' });
  }
  async approve(sessionId: string, requestId: string, decision: ApprovalDecision) {
    if (this.pending.get(requestId)?.sessionId !== sessionId) throw new TurnwireError('APPROVAL_EXPIRED', '审批已失效');
    this.pending.delete(requestId); this.emit(sessionId, { type: 'approval.resolved', requestId, decision });
    this.emit(sessionId, { type: 'status', status: 'idle' });
  }
  subscribe(id: string, listener: (event: RuntimeEvent) => void) { const listeners = this.listeners.get(id) ?? new Set(); listeners.add(listener); this.listeners.set(id, listeners); return () => { listeners.delete(listener); }; }
  private emit(id: string, event: RuntimeEvent) { if (event.type === 'status') { const session = this.sessions.get(id); if (session) session.status = event.status; } for (const listener of this.listeners.get(id) ?? []) listener(event); }
  async dispose() { this.listeners.clear(); this.pending.clear(); }
}
