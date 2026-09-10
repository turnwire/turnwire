import { afterEach, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { RemoteClient, SecureChannel, randomSecret, secureMessage } from '@turnwire/sdk';
import type { ConnectionHealth } from '@turnwire/sdk';
import type { Pairing } from '@turnwire/protocol';
import { DevicePresence } from '../apps/daemon/src/presence.js';

let cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.reverse()) await close(); cleanup = []; });
async function peer(mode: 'silent' | 'valid' | 'wrong-host' | 'wrong-nonce') {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.clients.forEach(client => client.terminate()); server.close(() => resolve()); }));
  const address = server.address(); if (typeof address === 'string' || !address) throw new Error('Missing address');
  const pairing: Pairing = { v: 1, hostId: 'mac', clientId: 'phone', name: 'Phone', relayUrl: `ws://127.0.0.1:${address.port}`, token: randomSecret(), key: randomSecret() };
  const channel = new SecureChannel(pairing.key, 'mac:phone', 'host'); let respond = true; let connections = 0;
  server.on('connection', socket => {
    ++connections;
    let queue = Promise.resolve();
    const send = async (kind: 'subscribed' | 'pong', body: unknown) => socket.send(JSON.stringify({ type: 'payload', payload: await channel.encrypt(secureMessage(kind, body)) }));
    socket.on('message', raw => { queue = queue.then(async () => {
      const frame = JSON.parse(String(raw));
      if (frame.kind === 'client') { socket.send(JSON.stringify({ type: 'ready', online: true })); return; }
      const value = await channel.decrypt(frame.payload);
      if (value.kind === 'subscribe') await send('subscribed', { cursor: 0, heartbeat: true });
      if (value.kind === 'ping' && mode !== 'silent' && respond) await send('pong', { nonce: mode === 'wrong-nonce' ? 'old-probe' : (value.body as { nonce: string }).nonce, challenge: crypto.randomUUID(), hostId: mode === 'wrong-host' ? 'other-mac' : 'mac' });
    }).catch(() => socket.close()); });
  });
  const phone = new RemoteClient(pairing, { heartbeatIntervalMs: 80, heartbeatTimeoutMs: 150, connectTimeoutMs: 800 }); cleanup.push(() => phone.close());
  const health: ConnectionHealth[] = []; phone.observeConnection(value => health.push(value));
  return { phone, health, connections: () => connections, kill: () => server.clients.forEach(client => client.terminate()), blackhole: () => { respond = false; } };
}
it('does not equate relay readiness or subscription with a verified Mac connection', async () => {
  const { phone, health } = await peer('silent');
  await expect(phone.checkConnection()).rejects.toMatchObject({ code: 'PROBE_TIMEOUT' });
  expect(health.some(value => value.phase === 'verifying')).toBe(true);
  expect(health.some(value => value.phase === 'connected')).toBe(false);
  expect(health.at(-1)?.phase).toBe('offline');
});
it('expires a previously verified connection when the Mac stops replying while the relay remains open', async () => {
  const { phone, health, blackhole } = await peer('valid');
  const result = await phone.checkConnection(); expect(result.phase).toBe('connected'); expect(result.lastVerifiedAt).toBeTruthy();
  blackhole(); await vi.waitFor(() => expect(health.at(-1)?.phase).toBe('offline'), { timeout: 15_000 });
  expect(health.at(-1)?.lastVerifiedAt).toBe(result.lastVerifiedAt);
});
it.each(['wrong-host', 'wrong-nonce'] as const)('rejects an encrypted but mismatched %s proof', async mode => {
  const { phone, health } = await peer(mode);
  await expect(phone.checkConnection()).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  expect(health.some(value => value.phase === 'connected')).toBe(false);
  expect(health.at(-1)?.phase).toBe('error');
});
it('reuses the verified socket when the page is hidden and shown again', async () => {
  const { phone, health, connections } = await peer('valid');
  await phone.checkConnection(); expect(connections()).toBe(1);
  const settled = health.length;
  phone.suspend(); phone.resume();
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(connections()).toBe(1);
  expect(health.slice(settled).some(value => value.phase === 'offline')).toBe(false);
  expect(health.at(-1)?.phase).toBe('connected');
});
it('rebuilds only a socket that died while the page was hidden', async () => {
  const { phone, health, connections, kill } = await peer('valid');
  await phone.checkConnection(); expect(connections()).toBe(1);
  phone.suspend(); kill();
  await vi.waitFor(() => expect(health.at(-1)?.phase).toBe('offline'), { timeout: 4000 });
  phone.resume();
  await vi.waitFor(() => expect(connections()).toBe(2), { timeout: 4000 });
  await vi.waitFor(() => expect(health.at(-1)?.phase).toBe('connected'), { timeout: 4000 });
});
it('expires host device presence even when an older relay sends no disconnection notification', () => {
  let now = Date.now(); let elapsed = 0; vi.spyOn(Date, 'now').mockImplementation(() => now); vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  const presence = new DevicePresence(); expect(presence.get('phone').connection).toBe('unconfirmed');
  presence.confirm('phone', 32); expect(presence.get('phone').connection).toBe('connected');
  now += 86400_000; expect(presence.get('phone').connection).toBe('connected');
  elapsed += 25_001; expect(presence.get('phone').connection).toBe('offline');
  presence.confirm('phone', 40); presence.disconnect('phone'); expect(presence.get('phone').connection).toBe('offline');
  expect(presence.get('phone').lastConfirmedAt).toBeTruthy();
});
