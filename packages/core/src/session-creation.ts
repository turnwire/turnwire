import { randomUUID } from 'node:crypto';
import { TurnwireError, type EventData, type ModelSelection, type Session } from '@turnwire/protocol';
import type { AgentRuntime } from '@turnwire/runtime';
import type { Store } from './store.js';

type Phase = 'allocating' | 'configuring' | 'ready';
interface CreationIntent { phase: Phase; model?: ModelSelection; error?: string }
/** Durable mapping precedes allocation. A partial result is a real, resumable session, not an orphan. */
export class SessionCreation {
  constructor(private store: Store, private publish: (event: EventData, settings?: Record<string, unknown>) => unknown) {}
  private key(id: string) { return `session.creation:${id}`; }
  pending(id: string): boolean { const intent = this.store.setting<CreationIntent>(this.key(id)); return !!intent && intent.phase !== 'ready'; }
  async create(runtime: AgentRuntime, options: { cwd: string; title: string; model?: ModelSelection }): Promise<Session> {
    const now = new Date().toISOString(); const id = randomUUID();
    const session: Session = { id, runtimeId: runtime.id, runtimeSessionId: id, title: options.title, cwd: options.cwd, status: 'interrupted', archived: false, autoApprove: false, createdAt: now, updatedAt: now };
    // The publisher commits mapping, journal entry and intent in one Store transaction.
    // No await or runtime side effect may move above that durable boundary.
    this.publish({ type: 'session.created', session }, { [this.key(id)]: { phase: 'allocating', ...(options.model ? { model: options.model } : {}) } satisfies CreationIntent });
    return this.resume(session, runtime);
  }
  async resume(session: Session, runtime: AgentRuntime): Promise<Session> {
    const intent = this.store.setting<CreationIntent>(this.key(session.id));
    if (!intent || intent.phase === 'ready') {
      const resumed = await runtime.resumeSession({ id: session.runtimeSessionId, cwd: session.cwd });
      return this.update(session, { status: resumed.status });
    }
    try {
      const options = { id: session.runtimeSessionId, cwd: session.cwd };
      const root = intent.phase === 'allocating' ? await runtime.createSession(options) : await runtime.resumeSession(options);
      if (root.id !== session.runtimeSessionId) throw new TurnwireError('RUNTIME_IDENTITY_MISMATCH', 'Runtime did not preserve the durable creation identity');
      intent.phase = 'configuring'; delete intent.error;
      this.store.setSetting(this.key(session.id), intent);
      if (intent.model && !runtime.setModel) throw new TurnwireError('MODEL_UNAVAILABLE', 'Runtime no longer supports the requested creation model');
      const model = intent.model ? await runtime.setModel!(root.id, intent.model) : undefined;
      // Public readiness and intent completion share the same durable commit.
      return this.update(session, { status: root.status, ...(model ? { model } : {}) }, { [this.key(session.id)]: { ...intent, phase: 'ready' } satisfies CreationIntent });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      intent.error = message;
      this.store.setSetting(this.key(session.id), intent);
      const partial = this.update(session, { status: 'error' });
      this.publish({ type: 'session.error', sessionId: session.id, message: `Session creation incomplete (${intent.phase}); resume this same session to recover: ${message}` });
      return partial;
    }
  }
  private update(session: Session, patch: Partial<Session>, settings?: Record<string, unknown>): Session {
    const current = this.store.session(session.id) ?? session;
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.publish({ type: 'session.updated', session: updated }, settings);
    return updated;
  }
}
