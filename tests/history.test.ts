import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { HistoryBuffer, LocalClient, RemoteClient, applyEvent, conversation, loadHistory, loadHistoryPage, randomSecret } from '@turnwire/sdk';
import type { TurnwireEvent, Session, Snapshot } from '@turnwire/protocol';
import { startDaemonServer } from '../apps/daemon/src/server.js';
import { startRelay } from '../apps/relay/src/server.js';
import { RemoteBridge } from '../apps/daemon/src/remote.js';

let cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup = []; });
const session: Session = { id: 'history', runtimeId: 'demo', runtimeSessionId: 'history', title: 'Long history', cwd: '/tmp', status: 'idle', createdAt: 'now', updatedAt: 'now' };
function fixture(store = new Store(':memory:')) {
  store.append({ type: 'session.created', session });
  for (let i = 0; i < 85; i++) store.append({ type: 'message.user', sessionId: session.id, messageId: `user-${i}`, text: `History ${i}` });
  for (let i = 0; i < 4000; i++) store.append({ type: 'message.delta', sessionId: session.id, messageId: 'answer', text: 'a' });
  store.append({ type: 'tool.started', sessionId: session.id, callId: 'question', tool: 'ask_user_question', detail: 'input' });
  store.append({ type: 'message.completed', sessionId: session.id, messageId: 'answer', text: 'Complete answer' });
  store.append({ type: 'tool.finished', sessionId: session.id, callId: 'question', tool: 'result', detail: 'Failed immediately', isError: true });
  return store;
}
it('pages complete records backwards, preserving chronology, tool pairs and live-page boundaries', () => {
  const store = fixture(); cleanup.push(() => store.close());
  const first = store.history(session.id, 40);
  expect(first.events.length).toBe(41); expect(first.hasMore).toBe(true);
  const latest = conversation(first.events, session.id);
  expect(latest.slice(-2).map(m => m.id)).toEqual(['answer', 'question']);
  expect(latest.at(-1)).toMatchObject({ tool: 'ask_user_question', complete: true, input: 'input', output: 'Failed immediately', isError: true });
  store.append({ type: 'message.user', sessionId: session.id, messageId: 'new', text: 'New since first page' });
  const middle = store.history(session.id, 40, first.nextBefore!);
  const last = store.history(session.id, 40, middle.nextBefore!);
  const messages = conversation([...last.events, ...middle.events, ...first.events], session.id);
  expect(messages).toHaveLength(87); expect(new Set(messages.map(m => m.id)).size).toBe(87);
  expect(last.hasMore).toBe(false); expect(last.nextBefore).toBeNull();
  expect(messages[0]?.id).toBe('user-0'); expect(messages.some(m => m.id === 'new')).toBe(false);
});
it('merges live deltas arriving during history fetch exactly once, retaining a complete baseline', () => {
  const store = new Store(':memory:'); cleanup.push(() => store.close());
  store.append({ type: 'message.delta', sessionId: session.id, messageId: 'stream', text: 'Hello' });
  const buffer = new HistoryBuffer(); buffer.begin();
  const page = store.history(session.id, 40);
  const delta = store.append({ type: 'message.delta', sessionId: session.id, messageId: 'stream', text: ' world' })!;
  buffer.apply(delta); buffer.apply(delta); buffer.merge(page, true);
  expect(conversation(buffer.events, session.id)[0]?.text).toBe('Hello world');
  buffer.begin(); const older = store.history(session.id, 40);
  buffer.apply(store.append({ type: 'message.completed', sessionId: session.id, messageId: 'stream', text: 'Hello world!' })!);
  buffer.merge(older);
  expect(buffer.events).toHaveLength(1);
  expect(conversation(buffer.events, session.id)[0]).toMatchObject({ text: 'Hello world!', complete: true });
});

it('leaves no assistant message for a turn that only calls tools', () => {
  const store = new Store(':memory:'); cleanup.push(() => store.close());
  const sessionId = 'tool-only';
  store.append({ type: 'message.completed', sessionId, messageId: 'm1', text: '' });
  store.append({ type: 'tool.started', sessionId, callId: 'call-1', tool: 'bash', detail: '{}' });
  store.append({ type: 'tool.finished', sessionId, callId: 'call-1', tool: 'bash', detail: 'ok', isError: false });
  expect(conversation(store.events(0, 50), sessionId).map(m => m.role)).toEqual(['tool']);
  // Whitespace is not text either, and a message that gains text later is kept.
  store.append({ type: 'message.completed', sessionId, messageId: 'm2', text: '   \n' });
  expect(conversation(store.events(0, 50), sessionId).map(m => m.role)).toEqual(['tool']);
  store.append({ type: 'message.delta', sessionId, messageId: 'm3', text: 'real answer' });
  const messages = conversation(store.events(0, 50), sessionId);
  expect(messages.map(m => m.role)).toEqual(['tool', 'assistant']);
  expect(messages[1]?.text).toBe('real answer');
});
it('never lets an old running event or approval regress a newer idle snapshot', () => {
  const snapshot: Snapshot = { device: { id: 'mac', name: 'Mac' }, sessions: [session], approvals: [], runtimes: [], cursor: 90 };
  expect(applyEvent(snapshot, { seq: 20, time: 'now', data: { type: 'session.updated', session: { ...session, status: 'running' } } })).toBe(snapshot);
  expect(applyEvent(snapshot, { seq: 21, time: 'now', data: { type: 'approval.requested', approval: { id: 'approval', sessionId: session.id, status: 'pending', tool: 'shell', reason: '', createdAt: 'now' } } })).toBe(snapshot);
});
it('backfills an existing journal once and persists its projection across reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'turnwire-history-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.db'); let store = fixture(new Store(path)); const expected = store.history(session.id, 40);
  store.db.exec("DROP TABLE history; DELETE FROM settings WHERE key='history-projection-v1'"); store.close();
  store = new Store(path); expect(store.history(session.id, 40)).toEqual(expected); store.close();
  store = new Store(path); expect(store.history(session.id, 40)).toEqual(expected); store.close();
  // Reopening the file-backed journal re-projects the whole 4088-event fixture twice, so a loaded
  // CI runner can exceed the default budget even though this takes milliseconds on an idle machine.
}, 60_000);
it('keeps the queued marker on a prompt that was sent during a turn', () => {
  const store = new Store(':memory:'); cleanup.push(() => store.close());
  store.append({ type: 'message.user', sessionId: 's', messageId: 'queued', text: 'later', queued: true });
  expect(conversation(store.events(0, 50), 's')[0]).toMatchObject({ text: 'later', queued: true });
});
it('local and encrypted clients fetch the same bounded history without unsolicited full replay', async () => {
  const core = new TurnwireCore(fixture(), [new DemoRuntime()], { id: 'mac', name: 'History Mac' }); cleanup.push(() => core.dispose());
  const token = randomSecret(); const server = await startDaemonServer({ core, token, port: 0 }); cleanup.push(() => server.close());
  const relay = await startRelay({ token, port: 0 }); cleanup.push(() => relay.close());
  const pairing = { v: 1 as const, hostId: 'mac', clientId: 'phone', name: 'Phone', relayUrl: `ws://127.0.0.1:${relay.port}/relay`, key: randomSecret(), token: randomSecret() };
  core.store.addDevice(pairing); const bridge = new RemoteBridge(core, pairing.relayUrl, token); bridge.start(); cleanup.push(() => bridge.close());
  await expect.poll(() => bridge.connected).toBe(true);
  const phone = new RemoteClient(pairing); cleanup.push(() => phone.close());
  const local = new LocalClient(`http://127.0.0.1:${server.port}`, token); cleanup.push(() => local.close());
  const spy: number[] = []; const readEvents = core.store.events.bind(core.store); core.store.events = (after, ...args) => { spy.push(after); return readEvents(after, ...args); };
  const snapshot = await phone.request<Snapshot>('system.snapshot');
  expect(spy.every(after => after >= snapshot.cursor)).toBe(true);
  // Events between snapshot and listener registration must still be delivered.
  await local.request('session.rename', { sessionId: session.id, title: 'Race window' });
  const received: TurnwireEvent[] = []; phone.subscribe(e => received.push(e), undefined, snapshot.cursor);
  await expect.poll(() => received.some(e => e.data.type === 'session.updated' && e.data.session.title === 'Race window')).toBe(true);
  const [a, b] = await Promise.all([loadHistoryPage(local, session.id), loadHistoryPage(phone, session.id)]);
  expect(a).toEqual(b); expect(a.events).toHaveLength(41);
  expect(conversation(await loadHistory(phone, session.id), session.id)).toHaveLength(87);
  await expect(phone.request('history.page', { sessionId: session.id, before: -1 })).rejects.toThrow();
  await expect(local.request('history.page', { sessionId: 'missing' })).rejects.toThrow('会话不存在');
}, 20000);

it('bounds multi-record page size without cutting a tool input away from its result', () => {
  const store = new Store(':memory:'); cleanup.push(() => store.close());
  for (let i = 0; i < 3; i++) {
    store.append({ type: 'tool.started', sessionId: 's', callId: `tool-${i}`, tool: 'read', detail: 'input' });
    store.append({ type: 'tool.finished', sessionId: 's', callId: `tool-${i}`, tool: 'read', detail: 'x'.repeat(300_000), isError: false });
  }
  const page = store.history('s', 40);
  expect(page.events).toHaveLength(2); expect(page.hasMore).toBe(true);
  expect(conversation(page.events, 's')[0]).toMatchObject({ id: 'tool-2', complete: true, input: 'input' });
  expect(conversation(store.history('s', 40, page.nextBefore!).events, 's')[0]?.id).toBe('tool-1');
});
