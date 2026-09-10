import { afterEach, expect, it } from 'vitest';
import { TurnwireCore, Store } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { LocalClient, RemoteClient, loadSubagentHistoryPage, randomSecret } from '@turnwire/sdk';
import { startDaemonServer } from '../apps/daemon/src/server.js';
import { startRelay } from '../apps/relay/src/server.js';
import { RemoteBridge } from '../apps/daemon/src/remote.js';
import { subagentHistoryPageSchema, type Session, type SubagentView } from '@turnwire/protocol';

const child: SubagentView = { id: 'child', parentId: 'nested-parent', depth: 2, label: 'Inspect execution', mode: 'continuable', activity: 'inactive', todos: [] };
it('returns the same scoped child records over local and paired encrypted transports', async () => {
  class Runtime extends DemoRuntime {
    async listSubagents() { return [child]; }
    async subagentHistory() { return { subagent: child, records: [{ id: 'tool', role: 'tool' as const, text: 'result', input: 'safe command', output: 'result', tool: 'bash', time: new Date(0).toISOString(), complete: true }], cursor: 2, hasMore: false, nextBefore: null }; }
  }
  const core = new TurnwireCore(new Store(':memory:'), [new Runtime()], { id: 'host', name: 'Host' });
  const token = randomSecret(); const server = await startDaemonServer({ core, token, port: 0 });
  const local = new LocalClient(`http://127.0.0.1:${server.port}`, token);
  const relayToken = randomSecret(); const relay = await startRelay({ token: relayToken, port: 0 });
  const pairing = { v: 2 as const, hostId: 'host', clientId: 'phone', name: 'Phone', relayUrl: `ws://127.0.0.1:${relay.port}`, token: randomSecret(), key: randomSecret() };
  core.store.addDevice(pairing); const bridge = new RemoteBridge(core, pairing.relayUrl, relayToken); bridge.start();
  const remote = new RemoteClient(pairing);
  try {
    await new Promise<void>((resolve, reject) => { let attempts = 0; const timer = setInterval(() => { if (bridge.connected) { clearInterval(timer); resolve(); } else if (++attempts > 200) { clearInterval(timer); reject(new Error('Relay connection timed out')); } }, 10); });
    const session = await local.request<Session>('session.create', { runtimeId: 'demo', title: 'Transport', cwd: process.cwd() });
    const params = { sessionId: session.id, subagentId: child.id, limit: 50 };
    expect(await loadSubagentHistoryPage(remote, params)).toEqual(await loadSubagentHistoryPage(local, params));
    await expect(loadSubagentHistoryPage(remote, { ...params, subagentId: 'unrelated' })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  } finally { remote.close(); local.close(); await bridge.close(); await relay.close(); await server.close(); await core.dispose(); }
});

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); });
it('scopes read-only child history to enumerated descendants and preserves runtime parent identity', async () => {
  class Runtime extends DemoRuntime {
    root = ''; calls = 0;
    async listSubagents(id: string) { return id === this.root ? [child] : []; }
    async subagentHistory(id: string, entry: SubagentView, options: { before?: number; cursor?: number; limit: number }) {
      this.calls++; expect(id).toBe(this.root); expect(entry).toEqual(child); expect(options.limit).toBe(50);
      return { subagent: entry, records: [{ id: 'answer', role: 'assistant' as const, text: 'Actual child output', time: new Date().toISOString(), complete: true }], cursor: 8, hasMore: false, nextBefore: null };
    }
  }
  const runtime = new Runtime(); const store = new Store(':memory:');
  const core = new TurnwireCore(store, [runtime], { id: 'host', name: 'Host' }); dispose = () => core.dispose();
  const call = (method: string, params: unknown, id = crypto.randomUUID()) => core.handle({ v: 1, id, method, params });
  const created = await call('session.create', { runtimeId: 'demo', title: 'Root', cwd: process.cwd() });
  if (!created.ok) throw new Error(created.error.message);
  const session = created.result as Session; runtime.root = session.runtimeSessionId;
  const before = store.cursor();
  const reply = await call('subagent.history', { sessionId: session.id, subagentId: child.id });
  expect(reply.ok).toBe(true);
  if (reply.ok) expect(subagentHistoryPageSchema.parse(reply.result).records[0]?.text).toBe('Actual child output');
  expect(store.cursor()).toBe(before);
  const denied = await call('subagent.history', { sessionId: session.id, subagentId: 'unrelated-runtime-session' });
  expect(denied).toMatchObject({ ok: false, error: { code: 'SESSION_NOT_FOUND' } });
  expect(runtime.calls).toBe(1);
  expect(await call('subagent.history', { sessionId: session.id, subagentId: child.id, limit: 101 })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  expect(await call('subagent.history', { sessionId: session.id, subagentId: child.id, parentSessionId: 'forged' })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
});

it('represents unavailable runtime history explicitly rather than an empty transcript', async () => {
  const core = new TurnwireCore(new Store(':memory:'), [new DemoRuntime()], { id: 'host', name: 'Host' }); dispose = () => core.dispose();
  const created = await core.handle({ v: 1, id: 'create', method: 'session.create', params: { runtimeId: 'demo', title: 'Root', cwd: process.cwd() } });
  if (!created.ok) throw new Error(created.error.message);
  const reply = await core.handle({ v: 1, id: 'read', method: 'subagent.history', params: { sessionId: (created.result as Session).id, subagentId: child.id } });
  expect(reply).toMatchObject({ ok: false, error: { code: 'RUNTIME_UNAVAILABLE' } });
  expect(subagentHistoryPageSchema.safeParse({ subagent: child, records: [], cursor: -1, hasMore: false, nextBefore: null }).success).toBe(true);
});
