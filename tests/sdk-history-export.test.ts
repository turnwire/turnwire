import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { LocalClient, RemoteClient, loadHistory, loadHistoryPage, transcriptMarkdown, conversation } from '@turnwire/sdk';
import { randomSecret } from '@turnwire/wire';
import { RemoteController } from '../apps/daemon/src/remote-control.js';
import { startDaemonServer } from '../apps/daemon/src/server.js';
import { startRelay } from '../apps/relay/src/server.js';
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it('exports full multi-megabyte tool output over local HTTP and encrypted v2 relay with bounded previews', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'turnwire-export-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const webRoot = join(directory, 'web'); await mkdir(webRoot); await writeFile(join(webRoot, 'index.html'), '<title>Test</title>');
  const core = new TurnwireCore(new Store(':memory:'), [new DemoRuntime()], { id: 'host', name: 'Test' }); await core.start(); cleanup.push(() => core.dispose());
  const controller = new RemoteController(core, { directory, webRoot }); controller.start(); cleanup.push(() => controller.close());
  const token = randomSecret(); const server = await startDaemonServer({ core, token, port: 0, remoteAccess: controller }); cleanup.push(() => server.close());
  const local = new LocalClient(`http://127.0.0.1:${server.port}`, token); cleanup.push(() => local.close());
  const secret = randomSecret(); const relay = await startRelay({ token: secret, port: 0 }); cleanup.push(() => relay.close());
  controller.configure({ mode: 'relay', serverUrl: `http://127.0.0.1:${relay.port}`, token: secret });
  await vi.waitFor(() => expect(controller.status().state).toBe('online'), { timeout: 8000 });
  const pairing = await local.pairDevice('Test'); expect(pairing.pairing.v).toBe(2);
  await vi.waitFor(() => expect(controller.status().state).toBe('online'), { timeout: 8000 });
  const remote = new RemoteClient(pairing.pairing); cleanup.push(() => remote.close()); await remote.checkConnection();
  const session = await local.call('session.create', { cwd: directory, runtimeId: 'demo', title: 'Full export' });
  const input = 'input'; const output = 'a😀\\\"\n'.repeat(700_000);
  core.store.append({ type: 'tool.started', sessionId: session.id, callId: 'tool', tool: 'read', detail: input });
  core.store.append({ type: 'tool.finished', sessionId: session.id, callId: 'tool', tool: 'read', detail: output });
  for (const client of [local, remote]) {
    const page = await loadHistoryPage(client, session.id); expect(JSON.stringify(page).length).toBeLessThan(512_000); expect(page.events.some(event => event.truncation)).toBe(true);
    const events = await loadHistory(client, session.id); expect(events.some(event => event.truncation)).toBe(false);
    const messages = conversation(events, session.id); expect(messages.find(message => message.role === 'tool')).toMatchObject({ input, output });
    expect(transcriptMarkdown(session, messages)).toContain(output);
  }
}, 30_000);
