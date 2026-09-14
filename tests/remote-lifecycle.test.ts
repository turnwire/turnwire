import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, TurnwireCore } from '@turnwire/core';
import { randomSecret } from '@turnwire/wire';
import { RemoteController } from '../apps/daemon/src/remote-control.js';
import { RemoteBridge } from '../apps/daemon/src/remote.js';
import { startRelay } from '../apps/relay/src/server.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const online = (remote: RemoteController) => vi.waitFor(() => expect(remote.status().state).toBe('online'), { timeout: 5000 });

it.each(['relay', 'temporary'] as const)('resumes identical saved %s intent after durable hold restart and cancel, without restarting busy or active work', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'turnwire-lifecycle-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const webRoot = join(directory, 'web'); await mkdir(webRoot); await writeFile(join(webRoot, 'index.html'), '<title>isolated</title>');
  const token = randomSecret(); const relay = await startRelay({ token, port: 0 }); cleanup.push(() => relay.close());
  const serverUrl = `http://127.0.0.1:${relay.port}`;
  const database = join(directory, 'state.sqlite');
  const first = new TurnwireCore(new Store(database), [], { id: 'host', name: 'Host' });
  first.store.setSetting('remote-preferences', mode === 'relay' ? { mode, relay: { serverUrl, remoteUrl: serverUrl, relayUrl: serverUrl.replace('http:', 'ws:') + '/relay', token } } : { mode, provider: 'cloudflare' });
  const hold = await first.configureMaintenance({ action: 'begin' }); await first.dispose();
  const core = new TurnwireCore(new Store(database), [], { id: 'host', name: 'Host' }); cleanup.push(() => core.dispose());
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const startTunnel = vi.fn(async ({ port }: { port: number }) => { await barrier; return { url: `http://127.0.0.1:${port}`, close: async () => {} }; });
  const remote = new RemoteController(core, { directory, webRoot, startTunnel }); cleanup.push(() => remote.close());
  const starts = vi.spyOn(RemoteBridge.prototype, 'start');
  remote.start(); expect(remote.status().state).toBe('off');
  const configuration = mode === 'relay' ? { mode, serverUrl } : { mode };
  expect(() => remote.configure(configuration)).toThrow('Maintenance'); expect(starts).not.toHaveBeenCalled();
  await core.configureMaintenance({ action: 'cancel', token: hold.token });
  remote.configure(configuration); expect(remote.status().state).toBe('starting');
  remote.configure(configuration); remote.start();
  if (mode === 'temporary') { await vi.waitFor(() => expect(startTunnel).toHaveBeenCalledTimes(1)); remote.configure(configuration); }
  release(); await online(remote);
  const endpoint = remote.endpoints(); remote.configure(configuration); remote.start(); await remote.activity.drain();
  expect(remote.endpoints()).toEqual(endpoint); expect(starts).toHaveBeenCalledTimes(1);
  const nextHold = await core.configureMaintenance({ action: 'begin' });
  remote.configure({ mode: 'off' }); remote.configure({ mode: 'off' }); await remote.activity.drain();
  expect(remote.status().state).toBe('off'); expect(starts).toHaveBeenCalledTimes(1);
  expect(await core.maintenanceStatus()).toMatchObject({ state: 'ready', inFlight: 0 });
  await core.configureMaintenance({ action: 'cancel', token: nextHold.token });
  remote.configure({ mode: 'off' }); await remote.close(); await remote.activity.drain();
  expect(starts).toHaveBeenCalledTimes(1);
});

it('does not replace a connecting or automatically reconnecting relay on identical configure', async () => {
  const core = new TurnwireCore(new Store(':memory:'), [], { id: 'host', name: 'Host' }); cleanup.push(() => core.dispose());
  const token = randomSecret(); const relay = await startRelay({ token, port: 0 });
  let relayClosed = false; cleanup.push(() => relayClosed ? undefined : relay.close());
  const remote = new RemoteController(core, { directory: '', webRoot: '' }); cleanup.push(() => remote.close());
  const configuration = { mode: 'relay', serverUrl: `http://127.0.0.1:${relay.port}`, token };
  const closing = vi.spyOn(RemoteBridge.prototype, 'close');
  remote.configure(configuration); await remote.activity.drain();
  expect(remote.status().state).toBe('offline'); remote.configure(configuration);
  await online(remote); expect(closing).not.toHaveBeenCalled();
  await relay.close(); relayClosed = true; await vi.waitFor(() => expect(remote.status().state).toBe('offline'));
  remote.configure(configuration); await remote.activity.drain(); expect(closing).not.toHaveBeenCalled();
});
