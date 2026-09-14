import { afterEach, expect, it, vi } from 'vitest';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import type { TurnwireCore } from '@turnwire/core';
import type { SecureMessage, TurnwireEvent } from '@turnwire/protocol';
import { RemotePeer } from '../apps/daemon/src/remote-peer.js';
import type { DevicePresence } from '../apps/daemon/src/presence.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function event(seq: number): TurnwireEvent { return { seq, time: 'now', data: { type: 'message.delta', sessionId: 's', messageId: 'm', text: `chunk-${seq}` } }; }
function fixture(count = 0, write?: (message: SecureMessage) => Promise<void>) {
  const journal = Array.from({ length: count }, (_, i) => event(i + 1));
  let listener: (event: TurnwireEvent) => void = () => {};
  const unsubscribe = vi.fn(); const disconnect = vi.fn(); const sent: SecureMessage[] = [];
  const events = vi.fn((after: number, limit: number) => journal.filter(event => event.seq > after).slice(0, limit));
  const core = {
    device: { id: 'host' },
    runTask: <T>(work: () => Promise<T>) => work(),
    store: { devices: () => [{ v: 2, clientId: 'phone' }], cursor: () => journal.at(-1)?.seq ?? 0, events },
    subscribe: (callback: typeof listener) => { listener = callback; return unsubscribe; },
    handle: vi.fn(async () => ({ id: 'cancel', ok: true, result: {} })),
  };
  const peer = new RemotePeer(core as unknown as TurnwireCore, 'phone', async payload => {
    const message = payload as SecureMessage; sent.push(message); await write?.(message);
  }, disconnect, { confirm: vi.fn() } as unknown as DevicePresence);
  const internal = peer as unknown as {
    channel: { encrypt: (message: SecureMessage) => Promise<SecureMessage>; decrypt: (message: unknown) => Promise<SecureMessage> };
    send: (kind: SecureMessage['kind'], body: unknown) => Promise<void>;
    queue: Promise<void>; outgoing: Promise<void>;
    authenticatedDevice: ReturnType<typeof core.store.devices>[number];
  };
  internal.channel = { encrypt: async message => message, decrypt: async message => message as SecureMessage };
  internal.authenticatedDevice = core.store.devices()[0]!;
  cleanup.push(() => peer.close());
  return { peer, internal, core, sent, events, disconnect, unsubscribe,
    append: () => { const next = event(journal.length + 1); journal.push(next); listener(next); return next; } };
}

it('replays in batches of 32, awaits writes, yields to IO, and catches up concurrent live events exactly once', async () => {
  const gate = deferred(); cleanup.push(gate.resolve);
  let blocked = false;
  const f = fixture(100, async message => { if (message.kind === 'event' && !blocked) { blocked = true; await gate.promise; } });
  f.peer.receive({ kind: 'subscribe', body: { after: 0 } });
  await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  expect(f.events).toHaveBeenCalledTimes(1);
  expect(f.events.mock.calls[0]?.slice(0, 2)).toEqual([0, 32]);
  f.append();
  // Replay must not occupy the inbound queue even while the transport is blocked.
  f.peer.receive({ kind: 'request', body: { id: 'cancel', method: 'session.cancel', params: { sessionId: 's' } } });
  await f.internal.queue;
  expect(f.core.handle).toHaveBeenCalledTimes(1);
  expect(f.sent).toHaveLength(1);
  let atIO = -1;
  const io = yieldToIO().then(() => { atIO = f.sent.filter(message => message.kind === 'event').length; f.append(); });
  gate.resolve(); await io;
  expect(atIO).toBeGreaterThan(0); expect(atIO).toBeLessThanOrEqual(32);
  await vi.waitFor(() => expect(f.sent.some(message => message.kind === 'subscribed')).toBe(true));
  const replay = f.sent.filter(message => message.kind === 'event').map(message => (message.body as TurnwireEvent).seq);
  expect(replay).toEqual(Array.from({ length: 102 }, (_, i) => i + 1));
  expect(f.events.mock.calls.every(([, limit]) => limit === 32)).toBe(true);
  expect(f.sent.find(message => message.kind === 'subscribed')!.body).toMatchObject({ cursor: 102 });
  const live = f.append(); await f.internal.outgoing;
  expect(f.sent.filter(message => message.kind === 'event').map(message => (message.body as TurnwireEvent).seq)).toEqual([...replay, live.seq]);
  expect(f.disconnect).not.toHaveBeenCalled();
});

it.each(['items', 'bytes'] as const)('disconnects an inbound %s overload while decryption is blocked', async mode => {
  const gate = deferred(); cleanup.push(gate.resolve); const f = fixture();
  f.internal.channel.decrypt = async () => { await gate.promise; return { kind: 'subscribe', body: { after: 'latest' } } as SecureMessage; };
  const payload = mode === 'items' ? { ciphertext: 'x' } : { ciphertext: 'x'.repeat(1024 * 1024) };
  f.peer.receive(payload); await Promise.resolve();
  if (mode === 'items') for (let i = 1; i < 256; i++) f.peer.receive(payload);
  expect(f.disconnect).not.toHaveBeenCalled();
  f.peer.receive(payload);
  expect(f.disconnect).toHaveBeenCalledTimes(1); expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  f.peer.receive(payload); expect(f.disconnect).toHaveBeenCalledTimes(1);
  gate.resolve(); await f.internal.queue;
});

it.each(['items', 'bytes'] as const)('disconnects an outbound %s overload while writes are blocked', async mode => {
  const gate = deferred(); cleanup.push(gate.resolve); const f = fixture(0, () => gate.promise);
  const body = mode === 'items' ? {} : { result: 'x'.repeat(1024 * 1024) };
  void f.internal.send('response', body); await Promise.resolve();
  if (mode === 'items') for (let i = 1; i < 256; i++) void f.internal.send('response', body);
  expect(f.disconnect).not.toHaveBeenCalled();
  void f.internal.send('response', body);
  expect(f.disconnect).toHaveBeenCalledTimes(1); expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  gate.resolve(); await f.internal.outgoing;
  expect(f.sent.length).toBeLessThanOrEqual(1);
});
