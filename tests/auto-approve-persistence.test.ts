import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { applyEvent } from '@turnwire/sdk';
import type { Session } from '@turnwire/protocol';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function database() {
  const dir = await mkdtemp(join(tmpdir(), 'turnwire-consent-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'state.db');
}
function open(path: string) {
  const store = new Store(path), runtime = new DemoRuntime();
  const core = new TurnwireCore(store, [runtime], { id: 'host', name: 'Host' });
  cleanup.push(() => core.dispose());
  return { core, store, runtime };
}
async function call(core: TurnwireCore, method: string, params: unknown) {
  const response = await core.handle({ v: 1, id: randomUUID(), method, params });
  if (!response.ok) throw new Error(response.error.code);
  return response.result;
}
async function create(core: TurnwireCore) {
  return await call(core, 'session.create', { title: 'Consent', cwd: process.cwd(), runtimeId: 'demo' }) as Session;
}

it.each([true, false])('retains explicit %s across real Store reopen and resume', async enabled => {
  const path = await database(); const first = open(path); const session = await create(first.core);
  expect(session.autoApprove).toBe(false);
  await call(first.core, 'session.autoApprove', { sessionId: session.id, enabled: true });
  if (!enabled) await call(first.core, 'session.autoApprove', { sessionId: session.id, enabled: false });
  await first.core.dispose();
  const second = open(path);
  expect(second.store.session(session.id)?.autoApprove).toBe(enabled);
  await second.core.start();
  await call(second.core, 'session.resume', { sessionId: session.id });
  expect((await second.core.snapshot()).sessions[0]?.autoApprove).toBe(enabled);
  await call(second.core, 'session.message', { sessionId: session.id, text: 'approval' });
  await vi.waitFor(() => expect(second.store.approvals()[0]?.status).toBe(enabled ? 'approved' : 'pending'));
  expect(second.store.session(session.id)?.autoApprove).toBe(enabled);
});

it('clears archive durably and never restores consent on unarchive', async () => {
  const path = await database(); const first = open(path); const session = await create(first.core);
  await call(first.core, 'session.autoApprove', { sessionId: session.id, enabled: true });
  await call(first.core, 'session.archive', { sessionId: session.id, archived: true });
  await first.core.dispose();
  const second = open(path); await second.core.start();
  expect(second.store.session(session.id)).toMatchObject({ archived: true, autoApprove: false });
  await expect(call(second.core, 'session.autoApprove', { sessionId: session.id, enabled: true })).rejects.toThrow('SESSION_ARCHIVED');
  await call(second.core, 'session.archive', { sessionId: session.id, archived: false });
  await second.core.dispose();
  const third = open(path);
  expect(third.store.session(session.id)).toMatchObject({ archived: false, autoApprove: false });
});

it('migrates missing consent off even when an old journal explicitly enabled it', async () => {
  const path = await database(); const first = open(path); const session = await create(first.core);
  const { autoApprove: _, ...legacy } = session;
  first.store.db.prepare('UPDATE sessions SET body=? WHERE id=?').run(JSON.stringify(legacy), session.id);
  first.store.append({ type: 'session.autoApprove', sessionId: session.id, auto: true });
  await first.core.dispose();
  const second = open(path); await second.core.start();
  expect(second.store.session(session.id)?.autoApprove).toBe(false);
  await call(second.core, 'session.message', { sessionId: session.id, text: 'approval' });
  expect(second.store.approvals()[0]?.status).toBe('pending');
});

it('expires pre-restart requests without replay while retaining consent for future requests', async () => {
  const path = await database(); const first = open(path); const session = await create(first.core);
  await call(first.core, 'session.autoApprove', { sessionId: session.id, enabled: true });
  first.store.append({ type: 'approval.requested', approval: { id: `${session.id}:expired`, sessionId: session.id, tool: 'shell', reason: 'old', status: 'pending', createdAt: new Date().toISOString() } });
  await first.core.dispose();
  const second = open(path); const spy = vi.spyOn(second.runtime, 'approve');
  await second.core.start();
  expect(spy).not.toHaveBeenCalled();
  expect(second.store.approval(`${session.id}:expired`)?.status).toBe('cancelled');
  expect(second.store.session(session.id)?.autoApprove).toBe(true);
  await call(second.core, 'session.message', { sessionId: session.id, text: 'approval' });
  await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
});

it('persists before granting pending work and keeps two client projections coherent', async () => {
  const path = await database(); const { core, store, runtime } = open(path); const session = await create(core);
  let clientA = await core.snapshot(), clientB = await core.snapshot();
  core.subscribe(event => { clientA = applyEvent(clientA, event); clientB = applyEvent(clientB, event); });
  await call(core, 'session.message', { sessionId: session.id, text: 'approval' });
  const approve = runtime.approve.bind(runtime);
  vi.spyOn(runtime, 'approve').mockImplementation(async (...args) => {
    const reopened = new Store(path);
    try { expect(reopened.session(session.id)?.autoApprove).toBe(true); } finally { reopened.close(); }
    expect(clientA.sessions[0]?.autoApprove).toBe(true);
    expect(clientB.sessions[0]?.autoApprove).toBe(true);
    return approve(...args);
  });
  await call(core, 'session.autoApprove', { sessionId: session.id, enabled: true });
  expect(store.approvals()[0]).toMatchObject({ status: 'approved', auto: true });
  expect(clientA).toEqual(await core.snapshot()); expect(clientB).toEqual(clientA);
  await call(core, 'session.archive', { sessionId: session.id, archived: true });
  expect(clientA.sessions[0]?.autoApprove).toBe(false);
  expect(clientA).toEqual(await core.snapshot()); expect(clientB).toEqual(clientA);
});

it.each([true, false])('serializes archive/enable races (archive first: %s)', async archiveFirst => {
  const { core, store } = open(await database()); const session = await create(core);
  const archive = () => call(core, 'session.archive', { sessionId: session.id, archived: true });
  const enable = () => call(core, 'session.autoApprove', { sessionId: session.id, enabled: true });
  const results = await Promise.allSettled(archiveFirst ? [archive(), enable()] : [enable(), archive()]);
  expect(results[0]?.status).toBe('fulfilled');
  expect(results[1]?.status).toBe(archiveFirst ? 'rejected' : 'fulfilled');
  expect(store.session(session.id)).toMatchObject({ archived: true, autoApprove: false });
});
