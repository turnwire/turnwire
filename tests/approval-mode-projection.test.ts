import { expect, it } from 'vitest';
import { applyEvent } from '@turnwire/sdk';
import type { Snapshot, Session } from '@turnwire/protocol';

it('uses explicit durable consent while preserving old-host transient status updates', () => {
  const session = { id: 's', title: 'Session', autoApprove: true } as Session;
  let snapshot = { cursor: 1, sessions: [session], approvals: [], questions: [], runtimes: [] } as unknown as Snapshot;
  snapshot = applyEvent(snapshot, { seq: 2, time: '', data: { type: 'session.updated', session: { ...session, status: 'running' } } });
  expect(snapshot.sessions[0]?.autoApprove).toBe(true);
  const { autoApprove: _, ...legacy } = session;
  snapshot = applyEvent(snapshot, { seq: 3, time: '', data: { type: 'session.updated', session: legacy } });
  expect(snapshot.sessions[0]?.autoApprove).toBe(true);
  snapshot = applyEvent(snapshot, { seq: 4, time: '', data: { type: 'session.updated', session: { ...session, autoApprove: false } } });
  expect(snapshot.sessions[0]?.autoApprove).toBe(false);
  snapshot = applyEvent(snapshot, { seq: 5, time: '', data: { type: 'session.autoApprove', sessionId: 's', auto: true } });
  expect(snapshot.sessions[0]?.autoApprove).toBe(true);
  snapshot = applyEvent(snapshot, { seq: 6, time: '', data: { type: 'session.updated', session: { ...legacy, archived: true } } });
  expect(snapshot.sessions[0]?.autoApprove).toBe(false);
  snapshot = applyEvent(snapshot, { seq: 7, time: '', data: { type: 'session.autoApprove', sessionId: 's', auto: false } });
  expect(snapshot.sessions[0]?.autoApprove).toBe(false);
});
