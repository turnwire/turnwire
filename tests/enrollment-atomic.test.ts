import { afterEach, expect, it, vi } from 'vitest';
import { Store, TurnwireCore } from '@turnwire/core';
import type { Pairing, SecureMessage } from '@turnwire/protocol';
import { createClientHandshake, randomSecret, secureMessage, type SessionChannel } from '@turnwire/wire';
import { RemotePeer } from '../apps/daemon/src/remote-peer.js';
import { DevicePresence } from '../apps/daemon/src/presence.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const core = new TurnwireCore(new Store(':memory:'), [], { id: 'host', name: 'Host' }); cleanup.push(() => core.dispose());
  const invitation: Pairing = { v: 2, hostId: 'host', clientId: 'phone', name: 'Phone', relayUrl: 'ws://localhost:1', token: randomSecret(), key: randomSecret(), bootstrap: true, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  core.store.addDevice(invitation);
  return { core, invitation };
}
async function connect(core: TurnwireCore, invitation: Pairing, credentials = [invitation.key]) {
  const sent: unknown[] = []; const disconnect = vi.fn();
  const peer = new RemotePeer(core, invitation.clientId, payload => { sent.push(payload); }, disconnect, new DevicePresence()); cleanup.push(() => peer.close());
  const internal = peer as unknown as { queue: Promise<void>; outgoing: Promise<void>; channel: SessionChannel };
  const handshake = await createClientHandshake(credentials, `${invitation.hostId}:${invitation.clientId}`);
  peer.receive(handshake.hello); await internal.queue;
  const client = await handshake.complete(sent.shift());
  return { peer, internal, client, sent, disconnect, async send(kind: SecureMessage['kind'], body: unknown) { peer.receive(await client.encrypt(secureMessage(kind, body))); await internal.queue; await internal.outgoing; } };
}

it.each([false, true])('serializes two fully encrypted invitation peers (same key: %s)', async same => {
  const { core, invitation } = fixture(); const a = await connect(core, invitation); const b = await connect(core, invitation);
  const keyA = randomSecret(); const keyB = same ? keyA : randomSecret(); const blocked = gate(); cleanup.push(blocked.resolve);
  const decrypt = b.internal.channel.decrypt.bind(b.internal.channel); const entered = gate();
  vi.spyOn(b.internal.channel, 'decrypt').mockImplementation(async payload => { const result = await decrypt(payload); entered.resolve(); await blocked.promise; return result; });
  b.peer.receive(await b.client.encrypt(secureMessage('enroll', { key: keyB }))); await entered.promise;
  await a.send('enroll', { key: keyA }); blocked.resolve(); await b.internal.queue; await b.internal.outgoing;
  expect(core.store.devices()[0]).toMatchObject({ key: keyA, bootstrap: false });
  expect(await a.client.decrypt(a.sent[0])).toMatchObject({ kind: 'enrolled' });
  expect(b.disconnect).toHaveBeenCalledTimes(same ? 0 : 1);
  if (same) expect(await b.client.decrypt(b.sent[0])).toMatchObject({ kind: 'enrolled' });
  else expect(b.sent).toHaveLength(0);
  const recovery = await connect(core, invitation, [invitation.key, keyA]);
  await recovery.send('enroll', { key: keyA }); expect(await recovery.client.decrypt(recovery.sent[0])).toMatchObject({ kind: 'enrolled' });
});

it.each(['revoke', 'key', 'token', 'expiry'] as const)('rejects %s changed while real enrollment decrypt is suspended', async change => {
  const { core, invitation } = fixture(); const f = await connect(core, invitation); const entered = gate(); const blocked = gate(); cleanup.push(blocked.resolve);
  const decrypt = f.internal.channel.decrypt.bind(f.internal.channel);
  vi.spyOn(f.internal.channel, 'decrypt').mockImplementation(async payload => { const result = await decrypt(payload); entered.resolve(); await blocked.promise; return result; });
  f.peer.receive(await f.client.encrypt(secureMessage('enroll', { key: randomSecret() }))); await entered.promise;
  if (change === 'revoke') core.store.db.prepare('DELETE FROM devices').run();
  else core.store.updateDevice({ ...invitation, ...(change === 'expiry' ? { expiresAt: new Date(0).toISOString() } : { [change]: randomSecret() }) });
  blocked.resolve(); await f.internal.queue; await f.internal.outgoing;
  expect(f.disconnect).toHaveBeenCalledTimes(1); expect(f.sent).toHaveLength(0);
  expect(core.store.devices().every(device => device.bootstrap)).toBe(true);
  expect((await core.maintenanceStatus()).inFlight).toBe(0);
});

it('revalidates enrolled authorization after deferred decrypt before dispatch', async () => {
  const { core, invitation } = fixture(); const installed = { ...invitation, bootstrap: false, expiresAt: undefined }; core.store.updateDevice(installed);
  const f = await connect(core, installed); const entered = gate(); const blocked = gate(); cleanup.push(blocked.resolve); const handle = vi.spyOn(core, 'handle');
  const decrypt = f.internal.channel.decrypt.bind(f.internal.channel);
  vi.spyOn(f.internal.channel, 'decrypt').mockImplementation(async payload => { const result = await decrypt(payload); entered.resolve(); await blocked.promise; return result; });
  f.peer.receive(await f.client.encrypt(secureMessage('request', { v: 1, id: 'read', method: 'system.snapshot', params: {} }))); await entered.promise;
  core.store.updateDevice({ ...installed, key: randomSecret() }); blocked.resolve(); await f.internal.queue;
  expect(handle).not.toHaveBeenCalled(); expect(f.disconnect).toHaveBeenCalledTimes(1);
});

it.each(['revoke', 'key', 'token', 'expiry'] as const)('revalidates %s after actual handshake crypto', async change => {
  const { core, invitation } = fixture(); const handshake = await createClientHandshake([invitation.key], 'host:phone');
  const entered = gate(); const blocked = gate(); cleanup.push(blocked.resolve);
  const verify = crypto.subtle.verify.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => { const result = await verify(...args); entered.resolve(); await blocked.promise; return result; });
  const disconnect = vi.fn(); const write = vi.fn(); const peer = new RemotePeer(core, 'phone', write, disconnect, new DevicePresence()); cleanup.push(() => peer.close());
  peer.receive(handshake.hello); await entered.promise;
  if (change === 'revoke') core.store.db.prepare('DELETE FROM devices').run();
  else core.store.updateDevice({ ...invitation, ...(change === 'expiry' ? { expiresAt: new Date(0).toISOString() } : { [change]: randomSecret() }) });
  blocked.resolve();
  await (peer as unknown as { queue: Promise<void> }).queue; expect(disconnect).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled();
});

it('owns deferred crypto through disposal and rejects enrollment after sealing', async () => {
  const { core, invitation } = fixture(); const f = await connect(core, invitation); const entered = gate(); const blocked = gate(); cleanup.push(blocked.resolve);
  const decrypt = f.internal.channel.decrypt.bind(f.internal.channel);
  vi.spyOn(f.internal.channel, 'decrypt').mockImplementation(async payload => { const result = await decrypt(payload); entered.resolve(); await blocked.promise; return result; });
  f.peer.receive(await f.client.encrypt(secureMessage('enroll', { key: randomSecret() }))); await entered.promise;
  const update = vi.spyOn(core.store.db, 'prepare'); let disposed = false;
  const disposal = core.dispose().then(() => { disposed = true; }); await Promise.resolve(); expect(disposed).toBe(false);
  update.mockClear(); blocked.resolve(); await f.internal.queue; await disposal;
  expect(update.mock.calls.some(([sql]) => sql.startsWith('UPDATE devices'))).toBe(false);
  expect(f.disconnect).toHaveBeenCalledTimes(1);
});

it('rejects enrollment during maintenance without credential mutation', async () => {
  const { core, invitation } = fixture(); const f = await connect(core, invitation);
  await core.configureMaintenance({ action: 'begin' }); await f.send('enroll', { key: randomSecret() });
  expect(core.store.devices()[0]).toEqual(invitation); expect(f.disconnect).toHaveBeenCalledTimes(1);
  expect((await core.maintenanceStatus()).inFlight).toBe(0);
});
