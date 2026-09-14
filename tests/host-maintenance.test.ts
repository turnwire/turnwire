import { afterEach, expect, it } from 'vitest';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteController } from '../apps/daemon/src/remote-control.js';
import { DeploymentController } from '../apps/daemon/src/deployment.js';
import { startDaemonServer } from '../apps/daemon/src/server.js';
import { startRelay } from '../apps/relay/src/server.js';
import { HostActivity } from '../apps/daemon/src/host-activity.js';
import { request } from 'node:http';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'host-maintenance-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const core = new TurnwireCore(new Store(':memory:'), [Object.assign(new DemoRuntime(), { busy: async () => 0 })], { id: 'host', name: 'Test' }); await core.start(); cleanups.push(() => core.dispose());
  const remote = new RemoteController(core, { directory, webRoot: directory }); cleanups.push(() => remote.close());
  return { core, remote };
}
const config = { host: '203.0.113.20', sshUser: 'deployer', publicAddress: 'relay.example.com', connectAfterDeploy: false };

it('counts the entire deployment including internal remote configuration after maintenance begins', async () => {
  const { core, remote } = await setup();
  const token = 't'.repeat(64); const relay = await startRelay({ token, host: '127.0.0.1', port: 0 }); cleanups.push(() => relay.close());
  const release = deferred();
  const deployment = new DeploymentController(core.store, async () => { await release.promise; return { publicUrl: `http://127.0.0.1:${relay.port}`, release: '/test', token }; }, remote, remote.activity);
  cleanups.push(() => deployment.close());
  deployment.start({ ...config, connectAfterDeploy: true });
  const held = await core.configureMaintenance({ action: 'begin' });
  expect(held.state).toBe('draining'); expect(held.inFlight).toBeGreaterThan(0);
  await expect(core.configureMaintenance({ action: 'compact', token: held.token })).rejects.toThrow('stable drained');
  expect(() => remote.configure({ mode: 'relay', serverUrl: `http://127.0.0.1:${relay.port}`, token })).toThrow('Maintenance');
  release.resolve();
  await expect.poll(() => deployment.status().state).toBe('succeeded');
  await expect.poll(async () => (await core.maintenanceStatus()).state).toBe('ready');
  expect(remote.status().mode).toBe('relay');
});

it('rejects every host write during hold but allows explicit transport/notification stops', async () => {
  const { core, remote } = await setup();
  const deployment = new DeploymentController(core.store, async () => { throw new Error('must not run'); }, remote, remote.activity); cleanups.push(() => deployment.close());
  const server = await startDaemonServer({ core, remoteAccess: remote, deployment, token: 'local', port: 0 }); cleanups.push(() => server.close());
  await core.configureMaintenance({ action: 'begin' });
  for (const [path, method, value] of [
    ['/deployment', 'POST', config], ['/remote', 'PUT', { mode: 'relay', serverUrl: 'https://relay.example.com', token: 't'.repeat(64) }],
    ['/direct', 'PUT', { enabled: true }], ['/notifications', 'PUT', { enabled: true }], ['/devices', 'POST', { name: 'New' }], ['/devices', 'DELETE', { id: 'old' }],
  ] as const) {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { authorization: 'Bearer local' }, body: JSON.stringify(value) });
    expect(response.status, path).toBe(409); expect(await response.json()).toMatchObject({ code: 'MAINTENANCE' });
  }
  for (const [path, value] of [['/remote', { mode: 'off' }], ['/direct', { enabled: false }], ['/notifications', { enabled: false }]] as const) {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'PUT', headers: { authorization: 'Bearer local' }, body: JSON.stringify(value) }); expect(response.status).toBe(200);
  }
  await expect.poll(async () => (await core.maintenanceStatus()).state).toBe('ready');
  expect(core.store.devices()).toEqual([]); expect(deployment.status().state).toBe('idle');
});

it('rechecks admission after a slow request body and drains an aborted deployment before store close', async () => {
  const { core, remote } = await setup(); const entered = deferred(); const finish = deferred();
  const deployment = new DeploymentController(core.store, async (_config, progress, signal) => {
    entered.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    await finish.promise; progress('Finishing abort cleanup'); signal.throwIfAborted(); throw new Error('unreachable');
  }, remote, remote.activity); cleanups.push(() => deployment.close());
  const server = await startDaemonServer({ core, remoteAccess: remote, deployment, token: 'local', port: 0 }); cleanups.push(() => server.close());
  deployment.start(config); await entered.promise;
  const response = deferred<number>();
  const slow = request(`http://127.0.0.1:${server.port}/devices`, { method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' } }, res => { res.resume(); response.resolve(res.statusCode!); });
  slow.write('{"name":');
  await core.configureMaintenance({ action: 'begin' }); slow.end('"Late"}');
  expect(await response.promise).toBe(409);
  remote.activity.stopIntake(); let closed = false; const closing = deployment.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); expect((await core.maintenanceStatus()).state).toBe('draining');
  expect(() => deployment.start(config)).toThrow(); finish.resolve(); await closing; await remote.activity.drain();
  expect(deployment.status()).toMatchObject({ state: 'interrupted', finishedAt: expect.any(String) });
  expect((await core.maintenanceStatus()).state).toBe('ready'); expect(core.store.devices()).toEqual([]);
});

it('drains rejected operations and blocks fresh work on shutdown while admitted nested work finishes', async () => {
  const { core } = await setup(); const activity = new HostActivity(recovery => core.enterHostActivity(recovery));
  const release = deferred(); let nested = false;
  const task = activity.run(async () => { await release.promise; await activity.run(async () => { nested = true; }); throw new Error('injected'); });
  const observed = task.catch(() => {}); activity.stopIntake();
  expect(() => activity.run(() => {})).toThrow('shutting down');
  let drained = false; const drain = activity.drain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  release.resolve(); await observed; await drain; expect(nested).toBe(true);
  expect((await core.configureMaintenance({ action: 'begin' })).state).toBe('ready');
});
