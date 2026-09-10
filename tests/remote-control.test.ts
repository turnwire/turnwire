import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { LocalClient, RemoteClient, randomSecret } from '@turnwire/sdk';
import type { Pairing, Session, Snapshot } from '@turnwire/protocol';
import { RemoteController } from '../apps/daemon/src/remote-control.js';
import { startDaemonServer } from '../apps/daemon/src/server.js';
import { startRelay } from '../apps/relay/src/server.js';
import type { TunnelOptions, TunnelHandle } from '../apps/daemon/src/tunnel.js';

let cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup = []; });
async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Remote state timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function setup(startTunnel?: (options: TunnelOptions) => Promise<TunnelHandle>, providers?: ConstructorParameters<typeof RemoteController>[1]['providers']) {
  const directory = await mkdtemp(join(tmpdir(), 'turnwire-control-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const webRoot = join(directory, 'web'); await mkdir(webRoot); await writeFile(join(webRoot, 'index.html'), '<title>Turnwire</title>');
  const core = new TurnwireCore(new Store(':memory:'), [new DemoRuntime()], { id: randomUUID(), name: 'Mac' });
  await core.start(); cleanup.push(() => core.dispose());
  const controller = new RemoteController(core, { directory, webRoot, startTunnel, providers }); cleanup.push(() => controller.close()); controller.start();
  const token = randomSecret();
  const server = await startDaemonServer({ core, token, port: 0, remoteAccess: controller }); cleanup.push(() => server.close());
  const url = 'http://127.0.0.1:' + server.port;
  const local = new LocalClient(url, token); cleanup.push(() => local.close());
  const admin = (path: string, method = 'GET', body?: unknown) => fetch(url + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { directory, webRoot, core, controller, local, admin, url, token };
}

it('switches both remote modes and off without restarting sessions or sharing the host secret', async () => {
  let tunnelClosed = 0;
  const { controller, local, admin, core } = await setup(async ({ port }) => ({ url: 'http://127.0.0.1:' + port, close: async () => { tunnelClosed++; } }));
  const session = await local.request<Session>('session.create', { cwd: process.cwd(), title: 'Keep this session', runtimeId: 'demo' });
  controller.configure({ mode: 'temporary' }); await until(() => controller.status().state === 'online');
  const paired = await (await admin('/devices', 'POST', { name: 'Phone' })).json() as { pairing: Pairing; url: string };
  await until(() => controller.status().state === 'online');
  const phone = new RemoteClient(paired.pairing); cleanup.push(() => phone.close());
  expect((await phone.request<Snapshot>('system.snapshot')).sessions[0]?.id).toBe(session.id);
  await phone.request('session.message', { sessionId: session.id, text: 'From my phone' });

  const secret = randomSecret(); const relay = await startRelay({ token: secret, port: 0 }); cleanup.push(() => relay.close());
  const serverUrl = 'http://127.0.0.1:' + relay.port;
  controller.configure({ mode: 'relay', serverUrl, token: secret }); await until(() => controller.status().state === 'online');
  expect(tunnelClosed).toBe(1);
  expect((await local.request<Snapshot>('system.snapshot')).sessions[0]?.id).toBe(session.id);
  expect(JSON.stringify(controller.status())).not.toContain(secret);
  expect(controller.status().hasRelayToken).toBe(true);
  const secondPair = await (await admin('/devices', 'POST', { name: 'Phone at fixed server' })).json() as { pairing: Pairing };
  expect(secondPair.pairing.relayUrl).toBe(serverUrl.replace('http:', 'ws:') + '/relay');
  await until(() => controller.status().state === 'online');
  const second = new RemoteClient(secondPair.pairing); cleanup.push(() => second.close());
  expect((await second.request<Snapshot>('system.snapshot')).sessions[0]?.id).toBe(session.id);

  controller.configure({ mode: 'off' }); await until(() => !controller.endpoints());
  expect(controller.status().state).toBe('off');
  expect((await admin('/devices', 'POST', { name: 'Too early' })).status).toBe(409);
  await local.request('session.message', { sessionId: session.id, text: 'Local still works' });
  expect(core.store.sessions()).toHaveLength(1);
  controller.configure({ mode: 'relay', serverUrl }); await until(() => controller.status().state === 'online');
  expect(controller.status().hasRelayToken).toBe(true);
});

it('selects shared providers, protects stored cpolar credentials and reflects verified phone presence', async () => {
  const starts: Array<{ id: string; token?: string }> = []; let change: TunnelOptions['changed'];
  const providers = (['localhost-run', 'cpolar', 'cloudflare'] as const).map(id => ({ id, name: id, description: id, requiresToken: id === 'cpolar', start: async (options: TunnelOptions) => {
    starts.push({ id, token: options.token }); change = options.changed;
    return { url: 'http://127.0.0.1:' + options.port, close: async () => {} };
  } }));
  const { controller, local, core, directory, webRoot } = await setup(undefined, providers);
  await local.configureRemote({ mode: 'temporary', provider: 'localhost-run' }); await until(() => controller.status().state === 'online');
  expect((await local.remoteStatus()).providers.map(p => p.id)).toEqual(['localhost-run', 'cpolar', 'cloudflare']);
  await expect(local.configureRemote({ mode: 'temporary', provider: 'cpolar' })).rejects.toThrow('Auth Token');
  expect(controller.status().state).toBe('online'); expect(controller.status().provider).toBe('localhost-run');
  await local.configureRemote({ mode: 'temporary', provider: 'cpolar', cpolarToken: 'private-test-token' }); await until(() => controller.status().state === 'online');
  expect(starts.at(-1)).toEqual({ id: 'cpolar', token: 'private-test-token' });
  expect(JSON.stringify(await local.remoteStatus())).not.toContain('private-test-token');
  const result = await local.pairDevice('Phone'); await until(() => controller.status().state === 'online');
  expect((await local.devices())[0]?.connection).toBe('unconfirmed');
  const phone = new RemoteClient(result.pairing); cleanup.push(() => phone.close());
  const health = await phone.checkConnection(); expect(health.phase).toBe('connected'); expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  await until(() => controller.deviceStatus(result.pairing.clientId).connection === 'connected');
  const confirmed = (await local.devices())[0]!; expect(confirmed.lastConfirmedAt).toBeTruthy();
  phone.close(); await until(() => controller.deviceStatus(result.pairing.clientId).connection === 'offline');
  change?.('https://renewed.cpolar.cn'); expect(controller.endpoints()?.remoteUrl).toBe('https://renewed.cpolar.cn');
  await local.configureRemote({ mode: 'off' }); await controller.close();
  const restored = new RemoteController(core, { directory, webRoot, providers }); cleanup.push(() => restored.close());
  expect(restored.status().hasCpolarToken).toBe(true);
  restored.configure({ mode: 'temporary', provider: 'cpolar' }); await until(() => restored.status().state === 'online');
  expect(starts.at(-1)?.token).toBe('private-test-token');
  restored.configure({ mode: 'temporary', provider: 'localhost-run' }); await until(() => restored.status().state === 'online');
  expect(starts.at(-1)).toEqual({ id: 'localhost-run', token: undefined });
});

it('keeps configuration local-only and validates changes before disconnecting', async () => {
  const { admin, url, controller } = await setup();
  expect((await fetch(url + '/remote')).status).toBe(401);
  const remoteRPC = await admin('/rpc', 'POST', { v: 1, id: randomUUID(), method: 'remote.configure', params: { mode: 'temporary' } });
  expect((await remoteRPC.json()).ok).toBe(false);
  for (const serverUrl of ['http://remote.example.com', 'https://user:pass@example.com', 'https://example.com/#secret']) {
    expect((await admin('/remote', 'PUT', { mode: 'relay', serverUrl, token: 'x'.repeat(32) })).status).toBe(400);
  }
  expect(controller.status().mode).toBe('off');
  const secret = randomSecret(); const relay = await startRelay({ token: secret, port: 0 }); cleanup.push(() => relay.close());
  controller.configure({ mode: 'relay', serverUrl: 'http://127.0.0.1:' + relay.port, token: secret });
  await until(() => controller.status().state === 'online');
  expect(() => controller.configure({ mode: 'relay', serverUrl: 'https://different.example.com' })).toThrow('Relay connection key');
  expect(controller.status().state).toBe('online');
  expect(JSON.stringify(await (await admin('/remote')).json())).not.toContain(secret);
});

it('cancels a pending temporary start and retains an explicit off preference across restarts', async () => {
  let entered = false; let cancelled = false;
  const { controller, core, directory, webRoot } = await setup(({ signal }) => new Promise((_resolve, reject) => {
    entered = true; signal.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true });
  }));
  controller.configure({ mode: 'temporary' }); await until(() => entered);
  controller.configure({ mode: 'off' }); await until(() => cancelled);
  await controller.close();
  const restored = new RemoteController(core, { directory, webRoot, initialRelay: { relayUrl: 'ws://127.0.0.1:12345', token: '' } });
  cleanup.push(() => restored.close()); restored.start();
  expect(restored.status().mode).toBe('off');
  expect(restored.endpoints()).toBeUndefined();
});

it('surfaces temporary process failure and can retry without leaving a stale pairing endpoint', async () => {
  let stopped = 0; let crash: () => void = () => {};
  const { controller } = await setup(async ({ port, exited }) => {
    crash = exited; return { url: 'http://127.0.0.1:' + port, close: async () => { stopped++; } };
  });
  controller.configure({ mode: 'temporary' }); await until(() => controller.status().state === 'online');
  crash(); await until(() => stopped === 1);
  expect(controller.status().state).toBe('error');
  expect(controller.endpoints()).toBeUndefined();
  controller.configure({ mode: 'temporary' }); await until(() => controller.status().state === 'online');
});
