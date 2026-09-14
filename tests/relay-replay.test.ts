import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { RemoteClient } from '@turnwire/sdk';
import { randomSecret } from '@turnwire/wire';
import type { TurnwireEvent, Pairing, Snapshot } from '@turnwire/protocol';
import { startRelay } from '../apps/relay/src/server.js';
import { RemoteBridge } from '../apps/daemon/src/remote.js';

let cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup = []; });

it('finishes encrypted initial replay and health verification with thousands of stored events', async () => {
  const core = new TurnwireCore(new Store(':memory:'), [new DemoRuntime()], { id: 'mac', name: 'Replay Mac' }); cleanup.push(() => core.dispose());
  for (let i = 0; i < 4000; i++) core.store.append({ type: 'message.delta', sessionId: 'history', messageId: 'message', text: `chunk ${i}` });
  const token = randomSecret(); const relay = await startRelay({ token, port: 0 }); cleanup.push(() => relay.close());
  const pairing: Pairing = { v: 2, hostId: 'mac', clientId: 'phone', name: 'Phone', relayUrl: `ws://127.0.0.1:${relay.port}/relay`, token: randomSecret(), key: randomSecret() };
  core.store.addDevice(pairing);
  const bridge = new RemoteBridge(core, pairing.relayUrl, token); bridge.start(); cleanup.push(() => bridge.close());
  await expect.poll(() => bridge.connected).toBe(true);
  const phone = new RemoteClient(pairing); cleanup.push(() => phone.close());
  const received: TurnwireEvent[] = []; phone.subscribe(event => received.push(event));
  expect((await phone.checkConnection()).phase).toBe('connected');
  // Replay can exceed waitFor's default one-second deadline on slower CI runners.
  await vi.waitFor(() => expect(received).toHaveLength(4000), { timeout: 15_000 });
  expect(new Set(received.map(event => event.seq)).size).toBe(4000);
  expect((await phone.call('system.snapshot')).cursor).toBe(4000);
  expect(bridge.connected).toBe(true);
}, 20000);

it('still disconnects an authenticated phone that floods the relay', async () => {
  const token = randomSecret(), phoneToken = randomSecret();
  const relay = await startRelay({ token, port: 0 }); cleanup.push(() => relay.close());
  const connect = async (auth: unknown) => {
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/relay`); cleanup.push(() => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject); socket.once('open', () => socket.send(JSON.stringify(auth)));
      socket.once('message', data => { expect(JSON.parse(String(data)).type).toBe('ready'); resolve(); });
    });
    return socket;
  };
  await connect({ kind: 'host', protocol: 2, hostId: 'mac', token, clients: [{ id: 'phone', token: phoneToken }] });
  const phone = await connect({ kind: 'client', hostId: 'mac', clientId: 'phone', token: phoneToken });
  const closed = new Promise<number>(resolve => phone.once('close', code => resolve(code)));
  for (let i = 0; i < 1100; i++) phone.send(JSON.stringify({ type: 'payload', payload: { v: 2, session: 'a'.repeat(64), sequence: String(i), ciphertext: 'opaque' } }));
  expect(await closed).toBe(4429);
});

it.each(['payload', 'client.close'])('requires host connectionId and fences stale IDs for %s', async type => {
  const token = randomSecret(), phoneToken = randomSecret();
  const relay = await startRelay({ token, port: 0 }); cleanup.push(() => relay.close());
  const connect = async (auth: unknown) => {
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/relay`); cleanup.push(() => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject); socket.once('open', () => socket.send(JSON.stringify(auth)));
      socket.once('message', data => { expect(JSON.parse(String(data)).type).toBe('ready'); resolve(); });
    });
    return socket;
  };
  const host = await connect({ kind: 'host', protocol: 2, hostId: 'mac', token, clients: [{ id: 'phone', token: phoneToken }] });
  const connected = new Promise<string>(resolve => host.once('message', data => resolve(JSON.parse(String(data)).connectionId)));
  await connect({ kind: 'client', hostId: 'mac', clientId: 'phone', token: phoneToken });
  const staleConnectionId = await connected;
  const replacementConnected = new Promise<string>(resolve => host.once('message', data => resolve(JSON.parse(String(data)).connectionId)));
  const phone = await connect({ kind: 'client', hostId: 'mac', clientId: 'phone', token: phoneToken });
  const connectionId = await replacementConnected;
  expect(connectionId).toEqual(expect.any(String));
  expect(connectionId).not.toBe(staleConnectionId);
  const received: unknown[] = []; phone.on('message', data => received.push(JSON.parse(String(data))));
  const payload = { v: 2, session: 'a'.repeat(64), sequence: '0', ciphertext: 'opaque' };
  host.send(JSON.stringify({ type, clientId: 'phone', connectionId: staleConnectionId, payload }));
  // Ordered sentinel proves the preceding stale frame was processed but not delivered.
  host.send(JSON.stringify({ type: 'payload', clientId: 'phone', connectionId, payload }));
  await vi.waitFor(() => expect(received).toHaveLength(1));
  expect(received).toEqual([{ type: 'payload', payload }]);
  expect(phone.readyState).toBe(WebSocket.OPEN);
  const closed = new Promise<number>(resolve => host.once('close', code => resolve(code)));
  host.send(JSON.stringify({ type, clientId: 'phone', payload }));
  expect(await closed).toBe(4002);
});
