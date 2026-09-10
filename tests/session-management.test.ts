import { afterEach, expect, it } from 'vitest';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { LocalClient, RemoteClient, randomSecret, conversation, transcriptMarkdown } from '@turnwire/sdk';
import type { Session, TurnwireEvent, Snapshot } from '@turnwire/protocol';
import { startDaemonServer } from '../apps/daemon/src/server.js';
import { startRelay } from '../apps/relay/src/server.js';
import { RemoteBridge } from '../apps/daemon/src/remote.js';

let cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup = []; });
async function setup() {
  const core = new TurnwireCore(new Store(':memory:'), [new DemoRuntime()], { id: crypto.randomUUID(), name: 'Management test' }); await core.start(); cleanup.push(() => core.dispose());
  const token = randomSecret(); const relay = await startRelay({ token, port: 0 }); cleanup.push(() => relay.close());
  const relayUrl = 'ws://127.0.0.1:' + relay.port;
  const bridge = new RemoteBridge(core, relayUrl, token); cleanup.push(() => bridge.close());
  const device = { v: 1 as const, hostId: core.device.id, relayUrl, clientId: crypto.randomUUID(), token: randomSecret(), key: randomSecret(), name: 'Phone' }; core.store.addDevice(device); bridge.start();
  for (let i = 0; !bridge.connected && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const server = await startDaemonServer({ core, token, port: 0 }); cleanup.push(() => server.close());
  const local = new LocalClient('http://127.0.0.1:' + server.port, token); cleanup.push(() => local.close());
  const phone = new RemoteClient(device); cleanup.push(() => phone.close());
  const session = await local.request<Session>('session.create', { runtimeId: 'demo', cwd: process.cwd(), title: 'Original title' });
  return { local, phone, core, session };
}

it('renames, archives and restores the same session across local and encrypted clients without losing history', async () => {
  const { local, phone, core, session } = await setup();
  await local.request('session.message', { sessionId: session.id, text: 'Keep this history' });
  const count = conversation(core.store.events(0, 100), session.id).length;
  await phone.request('session.rename', { sessionId: session.id, title: ' Shared new title ' });
  expect((await local.request<Snapshot>('system.snapshot')).sessions[0]?.title).toBe('Shared new title');
  await local.request('session.archive', { sessionId: session.id, archived: true });
  expect((await phone.request<Snapshot>('system.snapshot')).sessions[0]?.archived).toBe(true);
  await expect(phone.request('session.message', { sessionId: session.id, text: 'Too early' })).rejects.toThrow('Unarchive this session');
  await expect(local.request('session.resume', { sessionId: session.id })).rejects.toThrow('Unarchive this session');
  await phone.request('session.archive', { sessionId: session.id, archived: false });
  expect(conversation(core.store.events(0, 100), session.id)).toHaveLength(count);
  await local.request('session.message', { sessionId: session.id, text: 'Continue' });
  expect(core.store.sessions()).toHaveLength(1);
  await expect(local.request('session.rename', { sessionId: session.id, title: '  ' })).rejects.toThrow();
});

it('refuses to archive a task that still needs an approval', async () => {
  const { local, session, core } = await setup();
  await local.request('session.message', { sessionId: session.id, text: '审批' });
  await expect(local.request('session.archive', { sessionId: session.id, archived: true })).rejects.toThrow('Stop the task');
  expect(core.store.session(session.id)?.archived).not.toBe(true);
  expect(core.store.approvals().some(a => a.status === 'pending')).toBe(true);
  await local.request('session.cancel', { sessionId: session.id });
  await local.request('session.archive', { sessionId: session.id, archived: true });
  expect(core.store.session(session.id)?.archived).toBe(true);
});

it('keeps tool input, error output, elapsed timestamps and safe Markdown fences on replay', () => {
  const events: TurnwireEvent[] = [
    { seq: 2, time: '2026-09-09T00:00:02Z', data: { type: 'tool.finished', sessionId: 's', callId: 'c', tool: 'result', detail: '```\nfailed\n```', isError: true } },
    { seq: 1, time: '2026-09-09T00:00:00Z', data: { type: 'tool.started', sessionId: 's', callId: 'c', tool: 'shell', detail: '{"command":"npm test"}' } },
    { seq: 3, time: '2026-09-09T00:00:03Z', data: { type: 'session.error', sessionId: 's', message: 'Execution interrupted' } },
  ];
  const messages = conversation(events, 's');
  expect(messages[0]).toMatchObject({ tool: 'shell', input: '{"command":"npm test"}', output: '```\nfailed\n```', isError: true, complete: true, endedAt: events[0]!.time });
  expect(messages[1]?.role).toBe('error');
  const markdown = transcriptMarkdown({ id: 's', title: 'Test', cwd: '/tmp', runtimeId: 'demo', runtimeSessionId: 's', status: 'idle', createdAt: '', updatedAt: '' }, messages);
  expect(markdown).toContain('````\n```\nfailed\n```\n````');
  expect(markdown).toContain('npm test');
});
