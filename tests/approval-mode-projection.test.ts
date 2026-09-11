import { expect, it } from 'vitest';
import { applyEvent } from '@turnwire/sdk';
import type { Snapshot, Session } from '@turnwire/protocol';

it('keeps delegation through status updates until its explicit off event', () => {
  const session = { id: 's', title: 'Session', autoApprove: true } as Session;
  let snapshot = { cursor: 1, sessions: [session], approvals: [], questions: [], runtimes: [] } as unknown as Snapshot;
  const { autoApprove: _, ...persisted } = session;
  snapshot = applyEvent(snapshot, { seq: 2, time: new Date().toISOString(), data: { type: 'session.updated', session: { ...persisted, status: 'running' } as Session } });
  expect(snapshot.sessions[0]?.autoApprove).toBe(true);
  snapshot = applyEvent(snapshot, { seq: 3, time: new Date().toISOString(), data: { type: 'session.autoApprove', sessionId: 's', auto: false } });
  expect(snapshot.sessions[0]?.autoApprove).toBeUndefined();
  snapshot = applyEvent(snapshot, { seq: 4, time: new Date().toISOString(), data: { type: 'session.updated', session: { ...persisted, status: 'idle' } as Session } });
  expect(snapshot.sessions[0]?.autoApprove).toBeUndefined();
});
