import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hermeticEnv } from './helpers/hermetic-env.mjs';
import WebSocket from 'ws';
import { request } from 'node:https';
import { TurnwireCore, Store } from '@turnwire/core';
import { RemoteClient } from '@turnwire/sdk';
import { randomSecret } from '@turnwire/wire';
import type { Pairing, Snapshot } from '@turnwire/protocol';
import { startRelay } from '../apps/relay/src/server.js';
import { RemoteBridge } from '../apps/daemon/src/remote.js';
import { DirectController } from '../apps/daemon/src/direct.js';
let cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup = []; vi.unstubAllGlobals(); });
it('authenticates an isolated TLS bridge and fails over to Relay without exposing management endpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'turnwire-direct-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const cert = join(directory, 'cert.pem'), key = join(directory, 'key.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { env: hermeticEnv(directory), timeout: 10000 });
  const ca = await readFile(cert);
  // Explicit test CA trust, with normal hostname/certificate verification still enabled.
  vi.stubGlobal('WebSocket', class extends WebSocket { constructor(url: string | URL) { super(url, { ca }); } });
  const core = new TurnwireCore(new Store(':memory:'), [], { id: 'host', name: 'Host' }); cleanup.push(() => core.dispose());
  const token = randomSecret(); const relay = await startRelay({ token, port: 0 }); cleanup.push(() => relay.close());
  const pairing: Pairing = { v: 2, hostId: 'host', clientId: 'phone', name: 'Phone', token: randomSecret(), key: randomSecret(), relayUrl: `ws://127.0.0.1:${relay.port}` }; core.store.addDevice(pairing);
  const configuration = { enabled: true, url: 'wss://localhost:0/remote', listenHost: '127.0.0.1', port: 0, certificatePath: cert, privateKeyPath: key };
  core.store.setSetting('direct-preferences', configuration);
  const direct = new DirectController(core, () => 'https://phone.example', () => true); cleanup.push(() => direct.close());
  const hold = await core.configureMaintenance({ action: 'begin' });
  expect(() => direct.start()).toThrow('Maintenance'); expect(direct.status().state).toBe('off');
  await core.configureMaintenance({ action: 'cancel', token: hold.token });
  direct.configure(configuration);
  direct.configure(configuration); void direct.start();
  await vi.waitFor(() => expect(direct.status().state).toBe('online'), { timeout: 15_000 });
  const url = direct.endpoints()[0]!;
  direct.configure(configuration); await direct.start();
  expect(direct.endpoints()).toEqual([url]);
  for (const path of ['/rpc', '/events', '/devices', '/remote']) {
    const target = new URL(url.replace('wss:', 'https:')); target.pathname = path;
    const status = await new Promise(resolve => { const req = request(target, { ca }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', error => { throw error; }); req.end(); }); expect(status).toBe(404);
  }
  const bridge = new RemoteBridge(core, pairing.relayUrl, token, undefined, () => direct.endpoints()); cleanup.push(() => bridge.close());
  // First connect while Relay is unavailable: only TLS LAN can win.
  const phone = new RemoteClient({ ...pairing, directUrls: [url] }); cleanup.push(() => phone.close());
  const initialHealth = await phone.checkConnection(); expect(initialHealth.route).toBe('direct');
  expect((await phone.call('system.snapshot')).device.id).toBe('host');
  bridge.start(); await vi.waitFor(() => expect(bridge.connected).toBe(true), { timeout: 15_000 });
  let health = initialHealth; const stop = phone.observeConnection(value => { health = value; });
  const closingHold = await core.configureMaintenance({ action: 'begin' });
  const closing = direct.close();
  await closing;
  expect(await core.maintenanceStatus()).toMatchObject({ state: 'ready', inFlight: 0 });
  await core.configureMaintenance({ action: 'cancel', token: closingHold.token });
  await vi.waitFor(() => { expect(health.phase).toBe('connected'); expect(health.route).toBe('relay'); }, { timeout: 7000 }); stop();
  expect((await phone.call('system.snapshot')).device.id).toBe('host');
});
