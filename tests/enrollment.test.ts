import { afterEach, expect, it, vi } from 'vitest';
import { TurnwireCore, Store } from '@turnwire/core';
import { RemoteClient, LocalClient, randomSecret } from '@turnwire/sdk';
import type { Pairing, Snapshot } from '@turnwire/protocol';
import { startRelay } from '../apps/relay/src/server.js';
import { RemoteBridge } from '../apps/daemon/src/remote.js';
import { startDaemonServer } from '../apps/daemon/src/server.js';
let cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup = []; });
it('consumes an invitation once, persists the replacement credential and reconnects with a fresh session', async () => {
  const core = new TurnwireCore(new Store(':memory:'), [], { id: 'host', name: 'Host' }); cleanup.push(() => core.dispose());
  const token = randomSecret(); const relay = await startRelay({ token, port: 0 }); cleanup.push(() => relay.close());
  const relayUrl = `ws://127.0.0.1:${relay.port}`;
  const bridge = new RemoteBridge(core, relayUrl, token); cleanup.push(() => bridge.close()); bridge.start();
  const admin = await startDaemonServer({ core, token, port: 0, relayUrl, onPairingChanged: () => bridge.refreshDevices() }); cleanup.push(() => admin.close());
  const local = new LocalClient(`http://127.0.0.1:${admin.port}`, token); cleanup.push(() => local.close());
  const invitation = (await local.pairDevice('Phone')).pairing; expect(invitation.v).toBe(2);
  // Relay registration is a real WebSocket handshake; the 1s default budget is too tight on a
  // shared runner, where this liveness wait expired while the same suite passed on a faster host.
  await vi.waitFor(() => expect(bridge.connected).toBe(true), { timeout: 15_000 });
  const writes: Pairing[] = [];
  const phone = new RemoteClient(invitation, { persistPairing: value => { writes.push(structuredClone(value)); } }); cleanup.push(() => phone.close());
  expect((await phone.request<Snapshot>('system.snapshot')).device.id).toBe('host');
  expect(writes[0]).toMatchObject({ bootstrap: true, pendingKey: expect.any(String) });
  expect(phone.currentPairing).toMatchObject({ v: 2, bootstrap: false });
  expect(phone.currentPairing.key).not.toBe(invitation.key);
  phone.close();
  const resumed = new RemoteClient(phone.currentPairing); cleanup.push(() => resumed.close());
  expect((await resumed.checkConnection()).protocol).toBe(2); resumed.close();
  // A lost final enrollment response can recover with the pre-persisted candidate credential.
  const recovery = new RemoteClient(writes[0]!); cleanup.push(() => recovery.close());
  expect((await recovery.request<Snapshot>('system.snapshot')).device.id).toBe('host'); recovery.close();
  const copiedQR = new RemoteClient(invitation); cleanup.push(() => copiedQR.close());
  await expect(copiedQR.checkConnection()).rejects.toThrow('验证失败');
});
