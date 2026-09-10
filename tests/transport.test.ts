import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { LocalClient, RemoteClient, randomSecret, loadHistory, conversation } from '@turnwire/sdk';
import type { TurnwireEvent, Pairing, Session, Snapshot } from '@turnwire/protocol';
import { startDaemonServer } from '../apps/daemon/src/server.js';
import { startRelay } from '../apps/relay/src/server.js';
import { RemoteBridge } from '../apps/daemon/src/remote.js';

let cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup = []; });
async function until(check: () => boolean, timeout = 7000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 15)); } }
async function setup() {
  const core = new TurnwireCore(new Store(':memory:'), [new DemoRuntime()], { id: 'mac', name: 'Test Mac' }); cleanup.push(() => core.dispose());
  const token = randomSecret(); const server = await startDaemonServer({ core, token, port: 0 }); cleanup.push(() => server.close());
  const url = `http://127.0.0.1:${server.port}`; const local = new LocalClient(url, token); cleanup.push(() => local.close());
  return { core, token, server, url, local };
}
it('authenticates local RPC and blocks untrusted browser origins', async () => {
  const { url, token, local } = await setup(); expect((await local.request<Snapshot>('system.snapshot')).device.id).toBe('mac');
  const req = { v: 1, id: randomUUID(), method: 'system.snapshot', params: {} };
  expect((await fetch(`${url}/rpc`, { method: 'POST', body: JSON.stringify(req) })).status).toBe(401);
  expect((await fetch(`${url}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' }, body: JSON.stringify(req) })).status).toBe(403);
  const reboundStatus = await new Promise<number | undefined>((resolve, reject) => { const req = httpRequest(`${url}/health`, { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  expect(reboundStatus).toBe(403);
});
it('replays events after disconnection with no missing or duplicate client messages', async () => {
  const { local, url, token } = await setup(); const s = await local.request<Session>('session.create', { cwd: process.cwd(), title: 'Replay', runtimeId: 'demo' });
  const events: TurnwireEvent[] = []; let online = false;
  local.subscribe(event => events.push(event), state => { online = state === 'connected'; }); await until(() => online);
  await local.request('session.message', { sessionId: s.id, text: 'one' }); await until(() => events.some(e => e.data.type === 'message.completed'));
  const cursor = events.at(-1)!.seq; local.close();
  const second = new LocalClient(url, token); cleanup.push(() => second.close()); await second.request('session.message', { sessionId: s.id, text: 'two' });
  const replay: TurnwireEvent[] = []; second.subscribe(event => replay.push(event), undefined, cursor); await until(() => replay.some(e => e.data.type === 'message.completed'));
  expect(replay.every(e => e.seq > cursor)).toBe(true); expect(new Set(replay.map(e => e.seq)).size).toBe(replay.length);
  expect(conversation(await loadHistory(second, s.id), s.id).filter(m => m.role === 'user').map(m => m.text)).toEqual(['one', 'two']);
});
it('shares sessions and one-shot approvals over the encrypted relay and enforces revocation', async () => {
  const { core, local } = await setup(); const relayToken = randomSecret(); const relay = await startRelay({ token: relayToken, port: 0 }); cleanup.push(() => relay.close());
  const pairing: Pairing = { v: 1, hostId: 'mac', clientId: 'phone', relayUrl: `ws://127.0.0.1:${relay.port}`, token: randomSecret(), key: randomSecret(), name: 'Phone' }; core.store.addDevice(pairing);
  const bridge = new RemoteBridge(core, pairing.relayUrl, relayToken); bridge.start(); cleanup.push(() => bridge.close());
  await until(() => bridge.connected);
  const remote = new RemoteClient(pairing); cleanup.push(() => remote.close());
  const received: TurnwireEvent[] = []; let online = false; remote.subscribe(e => received.push(e), s => { online = s === 'connected'; }); await until(() => online);
  expect((await remote.request<Snapshot>('system.snapshot')).device.id).toBe('mac');
  const s = await remote.request<Session>('session.create', { cwd: process.cwd(), title: 'Remote', runtimeId: 'demo' });
  await remote.request('session.message', { sessionId: s.id, text: 'approval' });
  await until(() => received.some(e => e.data.type === 'approval.requested'));
  const approval = (await local.request<Snapshot>('system.snapshot')).approvals[0]!;
  await remote.request('approval.decide', { approvalId: approval.id, decision: 'approved' });
  expect((await local.request<Snapshot>('system.snapshot')).approvals).toHaveLength(0);
  expect(core.store.approval(approval.id)?.status).toBe('approved');
  bridge.refreshDevices(); await until(() => !online); await until(() => online);
  expect((await remote.request<Snapshot>('system.snapshot')).sessions.some(row => row.id === s.id)).toBe(true);
  core.store.removeDevice(pairing.clientId); bridge.refreshDevices(); await until(() => !online && !bridge.connected); await until(() => bridge.connected);
  const revoked = new RemoteClient(pairing); cleanup.push(() => revoked.close());
  await expect(revoked.request('system.snapshot')).rejects.toThrow();
});
