import { expect, it } from 'vitest';
import { applyEvent } from '@turnwire/sdk';
import { eventSchema, type Snapshot, type Session } from '@turnwire/protocol';

const session: Session = { id: 's', runtimeId: 'demo', runtimeSessionId: 's', title: 'Session', cwd: '/tmp', status: 'idle', createdAt: 'now', updatedAt: 'now', archived: false, autoApprove: true };
it('projects explicit durable consent without preserving previous host state', () => {
  let snapshot: Snapshot = { device: { id: 'host', name: 'Host' }, cursor: 1, sessions: [session], approvals: [], questions: [], runtimes: [] };
  snapshot = applyEvent(snapshot, { seq: 2, time: 'now', data: { type: 'session.updated', session: { ...session, status: 'running' } } });
  expect(snapshot.sessions[0]?.autoApprove).toBe(true);
  snapshot = applyEvent(snapshot, { seq: 3, time: 'now', data: { type: 'session.updated', session: { ...session, autoApprove: false } } });
  expect(snapshot.sessions[0]?.autoApprove).toBe(false);
  snapshot = applyEvent(snapshot, { seq: 4, time: 'now', data: { type: 'session.autoApprove', sessionId: 's', auto: true } });
  expect(snapshot.sessions[0]?.autoApprove).toBe(true);
  snapshot = applyEvent(snapshot, { seq: 5, time: 'now', data: { type: 'session.updated', session: { ...session, archived: true, autoApprove: false } } });
  expect(snapshot.sessions[0]?.autoApprove).toBe(false);
});
it('rejects session updates missing explicit consent or archive state', () => {
  for (const field of ['autoApprove', 'archived'] as const) {
    const incomplete: Partial<Session> = { ...session }; delete incomplete[field];
    expect(() => eventSchema.parse({ seq: 2, time: 'now', data: { type: 'session.updated', session: incomplete } })).toThrow();
  }
});
