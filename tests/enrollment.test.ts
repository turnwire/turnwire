import { afterEach, expect, it, vi } from 'vitest';
import { TurnwireCore, Store } from '@turnwire/core';
import { RemoteClient, LocalClient } from '@turnwire/sdk';
import { randomSecret } from '@turnwire/wire';
import type { PairedDevice, Pairing } from '@turnwire/protocol';
import type { RemoteAccess } from '../apps/daemon/src/remote-control.js';
import { startRelay } from '../apps/relay/src/server.js';
import { RemoteBridge } from '../apps/daemon/src/remote.js';
import { startDaemonServer } from '../apps/daemon/src/server.js';
type DeviceStatus = Pick<PairedDevice, 'connection' | 'lastConfirmedAt' | 'latencyMs'>;
let cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup = []; });
it.each([undefined, { connection: 'unconfirmed' }, { connection: 'offline', lastConfirmedAt: '2026-09-09T16:00:00Z' }, { connection: 'connected', lastConfirmedAt: '2026-09-09T16:00:00Z', latencyMs: 12 }] satisfies Array<DeviceStatus | undefined>)('returns a required connection without inventing presence: %j', async status => {
  const core = new TurnwireCore(new Store(':memory:'), [], { id: 'host', name: 'Host' }); cleanup.push(() => core.dispose());
  const token = randomSecret();
  const remoteAccess: RemoteAccess = {
    status: () => { throw new Error('Not needed'); }, configure: () => { throw new Error('Not needed'); },
    endpoints: () => ({ relayUrl: 'ws://127.0.0.1:1' }), refreshDevices: () => {},
    ...(status ? { deviceStatus: vi.fn(() => status) } : {}),
  };
  const admin = await startDaemonServer({ core, token, port: 0, remoteAccess }); cleanup.push(() => admin.close());
  const local = new LocalClient(`http://127.0.0.1:${admin.port}`, token); cleanup.push(() => local.close());
  expect(await local.devices()).toEqual([]);
  const { pairing } = await local.pairDevice('Phone');
  expect(await local.devices()).toEqual([{ id: pairing.clientId, name: 'Phone', protocol: 2, enrollment: 'pending', ...(status ?? { connection: 'unconfirmed' }) }]);
  if (remoteAccess.deviceStatus) expect(remoteAccess.deviceStatus).toHaveBeenCalledWith(pairing.clientId);
});
it('consumes an invitation once, persists the replacement credential and reconnects with a fresh session', async () => {
  const core = new TurnwireCore(new Store(':memory:'), [], { id: 'host', name: 'Host' }); cleanup.push(() => core.dispose());
  const token = randomSecret(); const relay = await startRelay({ token, port: 0 }); cleanup.push(() => relay.close());
  const relayUrl = `ws://127.0.0.1:${relay.port}`;
  const bridge = new RemoteBridge(core, relayUrl, token); cleanup.push(() => bridge.close()); bridge.start();
  const admin = await startDaemonServer({ core, token, port: 0, relayUrl, onPairingChanged: () => bridge.refreshDevices() }); cleanup.push(() => admin.close());
  const local = new LocalClient(`http://127.0.0.1:${admin.port}`, token); cleanup.push(() => local.close());
  const invitation = (await local.pairDevice('Phone')).pairing; expect(invitation.v).toBe(2);
  expect(await local.devices()).toEqual([{ id: invitation.clientId, name: 'Phone', protocol: 2, enrollment: 'pending', connection: 'unconfirmed' }]);
  // Relay registration is a real WebSocket handshake; the 1s default budget is too tight on a
  // shared runner, where this liveness wait expired while the same suite passed on a faster host.
  await vi.waitFor(() => expect(bridge.connected).toBe(true), { timeout: 15_000 });
  const writes: Pairing[] = [];
  const phone = new RemoteClient(invitation, { persistPairing: value => { writes.push(structuredClone(value)); } }); cleanup.push(() => phone.close());
  expect((await phone.call('system.snapshot')).device.id).toBe('host');
  expect(writes[0]).toMatchObject({ bootstrap: true, pendingKey: expect.any(String) });
  expect(phone.currentPairing).toMatchObject({ v: 2, bootstrap: false });
  expect(phone.currentPairing.key).not.toBe(invitation.key);
  // An enrolled, working Relay connection is not device-presence evidence for this server.
  expect(await local.devices()).toEqual([{ id: invitation.clientId, name: 'Phone', protocol: 2, enrollment: 'enrolled', connection: 'unconfirmed' }]);
  phone.close();
  const resumed = new RemoteClient(phone.currentPairing); cleanup.push(() => resumed.close());
  expect((await resumed.checkConnection()).protocol).toBe(2); resumed.close();
  // A lost final enrollment response can recover with the pre-persisted candidate credential.
  const recovery = new RemoteClient(writes[0]!); cleanup.push(() => recovery.close());
  expect((await recovery.call('system.snapshot')).device.id).toBe('host'); recovery.close();
  const copiedQR = new RemoteClient(invitation); cleanup.push(() => copiedQR.close());
  await expect(copiedQR.checkConnection()).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
});
