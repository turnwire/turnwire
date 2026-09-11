import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnwireCore, Store } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { methodSchemas } from '@turnwire/protocol';
import { LocalClient, RemoteClient, randomSecret } from '@turnwire/sdk';
import { startDaemonServer } from '../apps/daemon/src/server.js';
import { startRelay } from '../apps/relay/src/server.js';
import { RemoteBridge } from '../apps/daemon/src/remote.js';

it('shares newly created directories between paired remote and local clients', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'turnwire-mkdir-wire-'));
  const core = new TurnwireCore(new Store(':memory:'), [new DemoRuntime()], { id: 'host', name: 'Host' });
  const token = randomSecret(); const server = await startDaemonServer({ core, token, port: 0 });
  const local = new LocalClient(`http://127.0.0.1:${server.port}`, token);
  const relayToken = randomSecret(); const relay = await startRelay({ token: relayToken, port: 0 });
  const pairing = { v: 2 as const, hostId: 'host', clientId: 'phone', name: 'Phone', relayUrl: `ws://127.0.0.1:${relay.port}`, token: randomSecret(), key: randomSecret() };
  core.store.addDevice(pairing); const bridge = new RemoteBridge(core, pairing.relayUrl, relayToken); bridge.start();
  const remote = new RemoteClient(pairing);
  try {
    await new Promise<void>((resolve, reject) => { let attempts = 0; const timer = setInterval(() => { if (bridge.connected) { clearInterval(timer); resolve(); } else if (++attempts > 200) { clearInterval(timer); reject(new Error('Relay connection timed out')); } }, 10); });
    expect(await remote.request('workspace.mkdir', { parent, name: 'From phone' })).toMatchObject({ path: join(parent, 'From phone'), entries: [] });
    expect(await local.request('workspace.list', { path: parent })).toMatchObject({ entries: [{ name: 'From phone', path: join(parent, 'From phone') }] });
    await expect(remote.request('workspace.mkdir', { parent, name: '../escape' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(local.request('workspace.mkdir', { parent, name: 'From phone' })).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' });
  } finally { remote.close(); local.close(); await bridge.close(); await relay.close(); await server.close(); await core.dispose(); await rm(parent, { recursive: true, force: true }); }
});

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it('creates one child and replays its mutation receipt without creating twice', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'turnwire-mkdir-')); cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const core = new TurnwireCore(new Store(':memory:'), [new DemoRuntime()], { id: 'host', name: 'Host' }); cleanup.push(() => core.dispose());
  const request = { v: 1, id: 'mkdir', method: 'workspace.mkdir', params: { parent, name: 'New folder' } };
  const result = await core.handle(request);
  expect(result).toMatchObject({ ok: true, result: { path: join(parent, 'New folder'), parent, total: 0, entries: [] } });
  expect((await stat(join(parent, 'New folder'))).isDirectory()).toBe(true);
  expect(await core.handle(request)).toEqual(result);
  expect(await core.handle({ ...request, id: 'duplicate' })).toMatchObject({ ok: false, error: { code: 'INVALID_WORKSPACE' } });
  await writeFile(join(parent, 'file'), 'existing');
  expect(await core.handle({ ...request, id: 'file', params: { parent, name: 'file' } })).toMatchObject({ ok: false });
  expect(await core.handle({ ...request, id: 'missing', params: { parent: join(parent, 'missing'), name: 'child' } })).toMatchObject({ ok: false });
  expect(await core.handle({ ...request, id: 'relative', params: { parent: '.', name: 'child' } })).toMatchObject({ ok: false });
});
it.each(['', ' ', '.', '..', '../escape', 'a/b', 'a\\b', '/absolute', 'line\nname', 'nul\0name'])('rejects unsafe child name %j', name => {
  expect(methodSchemas['workspace.mkdir'].safeParse({ parent: '/tmp', name }).success).toBe(false);
});
