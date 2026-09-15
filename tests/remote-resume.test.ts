import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteClient } from '@turnwire/sdk';
import type { ConnectionHealth } from '@turnwire/sdk';
import type { SecureMessage } from '@turnwire/protocol';

// Isolate browser scheduling/transport lifecycle. Real encrypted proof validation is
// covered separately by connection-health.test.ts (including wrong host and nonce).
vi.mock('@turnwire/wire', async importOriginal => ({
  ...await importOriginal<typeof import('@turnwire/wire')>(),
  createClientHandshake: async () => ({ hello: { type: 'hello' }, complete: async () => ({
    encrypt: async (value: SecureMessage) => value,
    decrypt: async (value: SecureMessage) => value,
  }) }),
  retryDelay: () => 1000,
}));

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: (event: { code: number }) => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  responding = true;
  sent: Array<{ kind?: string; payload?: SecureMessage & { type?: string } }> = [];
  constructor(readonly url: string) { Socket.instances.push(this); }
  frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  message(kind: string, body: unknown) { this.frame({ type: 'payload', payload: { kind, body } }); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; }
  fail(code: number) { this.close(); this.onclose?.({ code }); }
  send(raw: string) {
    const value = JSON.parse(raw); this.sent.push(value);
    if (value.kind === 'client') this.frame({ type: 'ready', online: true });
    else if (value.payload?.type === 'hello') this.frame({ type: 'payload', payload: { type: 'hello.reply' } });
    else if (value.payload?.kind === 'subscribe') this.message('subscribed', { heartbeat: true });
    else if (value.payload?.kind === 'ping' && this.responding) this.message('pong', { nonce: value.payload.body.nonce, hostId: 'host', challenge: 'challenge' });
    else if (value.payload?.kind === 'ack' && this.responding) this.message('confirmed', { challenge: 'challenge' });
  }
  count(kind: string) { return this.sent.filter(frame => frame.payload?.kind === kind).length; }
}
const clients: RemoteClient[] = [];
// Drain the bounded async handshake/encryption queues without running browser timers.
async function flush() { for (let i = 0; i < 100; ++i) await Promise.resolve(); }
function setup(options = {}) {
  const client = new RemoteClient({ v: 2, hostId: 'host', clientId: 'phone', name: 'Phone', relayUrl: 'wss://relay.example', token: 't'.repeat(43), key: 'a'.repeat(64) }, options);
  clients.push(client);
  const health: ConnectionHealth[] = []; client.observeConnection(value => health.push(value));
  client.subscribe(() => {});
  return { client, health };
}
async function connected(options = {}) {
  const fixture = setup(options); Socket.instances[0]!.open(); await flush();
  expect(fixture.health.at(-1)?.phase).toBe('connected');
  return { ...fixture, socket: Socket.instances[0]! };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); Socket.instances = []; vi.stubGlobal('WebSocket', Socket); });
afterEach(async () => { for (const client of clients.splice(0)) client.close(); await flush(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('reuses a recently verified socket and deduplicates pageshow/visibilitychange probes', async () => {
  const { client, socket } = await connected();
  client.suspend(); client.suspend(); client.resume(); client.resume(); await flush();
  expect(Socket.instances).toHaveLength(1); expect(socket.count('ping')).toBe(2);
  client.resume(); await flush(); expect(socket.count('ping')).toBe(2);
});

it('replaces an OPEN zombie immediately after a full missed health window, without waiting 5s plus backoff', async () => {
  const { client, socket, health } = await connected();
  socket.responding = false; client.suspend();
  vi.setSystemTime(Date.now() + 20_001); // Mobile sleep: no interval/deadline callbacks execute.
  client.resume(); client.resume(); await flush();
  expect(socket.readyState).toBe(3); expect(Socket.instances).toHaveLength(2);
  expect(socket.count('ping')).toBe(1);
  expect(health.at(-1)?.phase).not.toBe('connected');
  Socket.instances[1]!.open(); await flush(); expect(health.at(-1)?.phase).toBe('connected');
});

it('preserves a socket with a recent background proof even after a long hidden period', async () => {
  const { client, socket } = await connected(); client.suspend();
  await vi.advanceTimersByTimeAsync(60_000);
  client.resume(); await flush();
  expect(Socket.instances).toHaveLength(1); expect(socket.readyState).toBe(1);
});

it('replaces an expired in-flight probe after frozen timers, even before the full health window', async () => {
  const { client, socket } = await connected(); socket.responding = false;
  client.suspend(); client.resume(); await flush(); expect(socket.count('ping')).toBe(2);
  client.suspend(); vi.setSystemTime(Date.now() + 5001);
  client.resume(); await flush(); expect(Socket.instances).toHaveLength(2);
});

it('keeps the normal slow-network probe budget but reconnects without backoff on foreground failure only', async () => {
  const { client, socket, health } = await connected({ heartbeatTimeoutMs: 8000 });
  socket.responding = false; client.suspend(); client.resume(); await flush();
  await vi.advanceTimersByTimeAsync(7999); expect(Socket.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2); expect(Socket.instances).toHaveLength(2);
  expect(health.some(value => value.code === 'PROBE_TIMEOUT' && value.retryInMs === 0)).toBe(true);
  Socket.instances[1]!.fail(1006); await flush();
  expect(health.at(-1)?.retryInMs).toBe(1000);
  client.resume(); await vi.advanceTimersByTimeAsync(999); expect(Socket.instances).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1); expect(Socket.instances).toHaveLength(3);
});

it('restarts expired connecting candidates but preserves unexpired stage budgets', async () => {
  const { client } = setup({ connectTimeoutMs: 9000 });
  client.suspend(); vi.setSystemTime(Date.now() + 8999); client.resume(); await flush();
  expect(Socket.instances).toHaveLength(1);
  client.suspend(); vi.setSystemTime(Date.now() + 2); client.resume(); client.resume(); await flush();
  expect(Socket.instances).toHaveLength(2); expect(Socket.instances[0]!.readyState).toBe(3);
  Socket.instances[1]!.open(); await flush();
  expect(Socket.instances[1]!.count('ping')).toBe(1);
});

it.each([4401, 4002, 4003])('does not automatically loop terminal authentication close %s on foreground', async code => {
  const { client, socket, health } = await connected();
  client.suspend(); client.resume(); socket.fail(code); await flush();
  expect(health.at(-1)?.phase).toBe('error');
  client.suspend(); client.resume(); client.resume(); await vi.advanceTimersByTimeAsync(60_000);
  expect(Socket.instances).toHaveLength(1);
  const manual = client.checkConnection(); Socket.instances[1]!.open(); await flush();
  await expect(manual).resolves.toMatchObject({ phase: 'connected' });
});

it('rejects an uncertain mutation instead of replaying it on stale foreground recovery', async () => {
  const { client, socket } = await connected();
  const mutation = client.call('session.message', { sessionId: 'session', text: 'exactly once' });
  const rejected = expect(mutation).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' }); await flush();
  expect(socket.count('request')).toBe(1);
  client.suspend(); vi.setSystemTime(Date.now() + 20_001); client.resume(); await flush(); await rejected;
  Socket.instances[1]!.open(); await flush(); expect(Socket.instances[1]!.count('request')).toBe(0);
});

it('keeps normal backoff for heartbeat failure outside foreground recovery', async () => {
  const { socket, health } = await connected(); socket.responding = false;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(Socket.instances).toHaveLength(1); expect(health.at(-1)?.retryInMs).toBe(1000);
  await vi.advanceTimersByTimeAsync(1000); expect(Socket.instances).toHaveLength(2);
});

it('reconnects once when offline returns online without waiting for the stale threshold', async () => {
  const { client, socket } = await connected(); client.suspend('offline');
  expect(socket.readyState).toBe(3);
  client.resume(); client.resume(); await flush(); expect(Socket.instances).toHaveLength(2);
});

it('does not let lifecycle signals reopen an explicitly closed client', async () => {
  const { client } = await connected(); client.close(); client.suspend(); client.resume(); await flush();
  expect(Socket.instances).toHaveLength(1);
});
