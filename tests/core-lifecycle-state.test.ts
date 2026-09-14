import { afterEach, expect, it, vi } from 'vitest';
import { request, IncomingMessage } from 'node:http';
import { TurnwireCore, Store } from '@turnwire/core';
import { DemoRuntime, type RuntimeEvent, type AgentRuntime } from '@turnwire/runtime';
import type { Session } from '@turnwire/protocol';
import { startDaemonServer } from '../apps/daemon/src/server.js';
import { HostActivity } from '../apps/daemon/src/host-activity.js';

function barrier<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const rpc = (core: TurnwireCore, id: string, method: string, params = {}) => core.handle({ v: 1, id, method, params });
async function fixture() {
  const runtime = new DemoRuntime(); const store = new Store(':memory:');
  let emit!: (event: RuntimeEvent) => void;
  vi.spyOn(runtime, 'subscribe').mockImplementation((_id, listener) => { emit = listener; return () => {}; });
  const core = new TurnwireCore(store, [runtime], { id: 'test', name: 'test' }); cleanups.push(() => core.dispose());
  const response = await rpc(core, 'create', 'session.create', { runtimeId: runtime.id, title: 'test', cwd: process.cwd() });
  if (!response.ok) throw new Error(response.error.message);
  return { core, runtime, store, session: response.result as Session, emit: (event: RuntimeEvent) => emit(event) };
}

it.each(['direct snapshot', 'RPC snapshot', 'child read', 'maintenance status', 'maintenance configure'])('owns %s through disposal and seals all admission', async kind => {
  const { core, runtime, store, session } = await fixture(); const entered = barrier(); const release = barrier();
  (runtime as AgentRuntime).busy = async () => 0;
  const health = runtime.health.bind(runtime);
  vi.spyOn(runtime, 'health').mockImplementation(async () => { entered.resolve(); await release.promise; return health(); });
  (runtime as AgentRuntime).listSubagents = async () => { entered.resolve(); await release.promise; return []; };
  const work = kind === 'direct snapshot' ? core.snapshot() : kind === 'RPC snapshot' ? rpc(core, 'read', 'system.snapshot') : kind === 'child read' ? rpc(core, 'read', 'subagent.list', { sessionId: session.id }) : kind === 'maintenance status' ? core.maintenanceStatus() : core.configureMaintenance({ action: 'begin' });
  await entered.promise;
  const close = vi.spyOn(store, 'close'); const runtimeClose = vi.spyOn(runtime, 'dispose');
  const disposal = core.dispose(); expect(core.dispose()).toBe(disposal);
  expect(await rpc(core, 'late', 'system.snapshot')).toMatchObject({ ok: false, error: { code: 'CORE_CLOSING' } });
  await expect(core.snapshot()).rejects.toMatchObject({ code: 'CORE_CLOSING' });
  expect(() => core.enterHostActivity(true)).toThrow();
  expect(close).not.toHaveBeenCalled(); expect(runtimeClose).not.toHaveBeenCalled();
  release.resolve(); await work; await disposal; expect(close).toHaveBeenCalledTimes(1); expect(runtimeClose).toHaveBeenCalledTimes(1);
});

it('main shutdown sequence permits owned host teardown after seal but never after disposal begins', async () => {
  const { core, store } = await fixture(); const activity = new HostActivity(recovery => core.enterHostActivity(recovery));
  core.seal(); activity.stopIntake();
  expect(() => activity.run(() => {})).toThrow();
  const release = barrier(); const closed = vi.spyOn(store, 'close');
  const teardown = activity.run(async () => { await release.promise; store.cursor(); }, true);
  const disposal = core.dispose(); expect(() => activity.run(() => {}, true)).toThrow(); expect(closed).not.toHaveBeenCalled();
  release.resolve(); await teardown; await activity.drain(); await disposal;
});

it('owns a deferred image read and late mutation subscription through drain', async () => {
  const { core, runtime, store, session } = await fixture(); const entered = barrier(); const release = barrier();
  const attachment = { attachmentId: 'image', mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 };
  store.append({ type: 'message.user', sessionId: session.id, messageId: 'image-message', text: '', images: [attachment] });
  (runtime as AgentRuntime).readImage = async () => { entered.resolve(); await release.promise; return { attachment, data: 'YQ==' }; };
  const read = rpc(core, 'read-image', 'session.image', { sessionId: session.id, attachmentId: 'image' }); await entered.promise;
  const close = vi.spyOn(store, 'close'); const disposal = core.dispose(); expect(close).not.toHaveBeenCalled(); release.resolve(); expect(await read).toMatchObject({ ok: true }); await disposal;
});

it('drains queued commands and subscriptions bound by a creation admitted before seal', async () => {
  const { core, runtime, store } = await fixture(); const entered = barrier(); const release = barrier(); const unsubscribe = vi.fn();
  vi.spyOn(runtime, 'subscribe').mockReturnValue(unsubscribe);
  const create = runtime.createSession.bind(runtime);
  vi.spyOn(runtime, 'createSession').mockImplementation(async options => { entered.resolve(); await release.promise; return create(options); });
  const creation = rpc(core, 'new-create', 'session.create', { runtimeId: runtime.id, title: 'late bind', cwd: process.cwd() }); await entered.promise;
  const pending = store.sessions().find(session => session.title === 'late bind')!;
  const rename = rpc(core, 'rename-late', 'session.rename', { sessionId: pending.id, title: 'renamed' });
  const disposal = core.dispose(); expect(unsubscribe).not.toHaveBeenCalled(); release.resolve();
  expect(await creation).toMatchObject({ ok: true }); expect(await rename).toMatchObject({ ok: true }); await disposal; expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('pending creation cannot send or change model even after a runtime idle echo', async () => {
  const { core, runtime, store, session, emit } = await fixture();
  store.setSetting(`session.creation:${session.id}`, { phase: 'configuring' });
  store.append({ type: 'session.updated', session: { ...session, status: 'error' } });
  emit({ type: 'status', status: 'idle' }); expect(store.session(session.id)?.status).toBe('error');
  const send = vi.spyOn(runtime, 'sendMessage');
  expect(await rpc(core, 'incomplete-message', 'session.message', { sessionId: session.id, text: 'hello' })).toMatchObject({ ok: false, error: { code: 'RESUME_REQUIRED' } });
  expect(await rpc(core, 'incomplete-model', 'session.setModel', { sessionId: session.id, provider: 'demo', model: 'demo' })).toMatchObject({ ok: false, error: { code: 'RESUME_REQUIRED' } }); expect(send).not.toHaveBeenCalled();
});

it('drains automatic grants including their post-runtime journal continuation', async () => {
  const { core, runtime, store, session, emit } = await fixture();
  await rpc(core, 'auto', 'session.autoApprove', { sessionId: session.id, enabled: true });
  const entered = barrier(); const release = barrier();
  vi.spyOn(runtime, 'approve').mockImplementation(async () => { entered.resolve(); await release.promise; });
  emit({ type: 'approval.requested', requestId: 'grant', tool: 'tool', reason: 'reason' }); await entered.promise;
  const append = vi.spyOn(store, 'append'); const close = vi.spyOn(store, 'close'); const disposal = core.dispose();
  expect(close).not.toHaveBeenCalled(); release.resolve(); await disposal;
  expect(append.mock.calls.some(([data]) => data.type === 'approval.resolved')).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
});

it('checks queue action active state inside the queued session lock', async () => {
  const { core, runtime, session } = await fixture(); const action = vi.spyOn(runtime, 'queueAction');
  const archive = rpc(core, 'archive', 'session.archive', { sessionId: session.id, archived: true });
  const edit = rpc(core, 'edit', 'session.queueAction', { sessionId: session.id, messageId: 'queued', action: { kind: 'remove' } });
  expect(await archive).toMatchObject({ ok: true }); expect(await edit).toMatchObject({ ok: false, error: { code: 'SESSION_ARCHIVED' } }); expect(action).not.toHaveBeenCalled();
});

it.each([false, true])('arbitrates competing question answers and cancellation=%s', async cancel => {
  const { core, runtime, store, session, emit } = await fixture(); const entered = barrier(); const release = barrier();
  runtime.answerQuestion = vi.fn(async () => { entered.resolve(); emit({ type: 'question.resolved', requestId: 'q', decision: 'answered' }); await release.promise; });
  emit({ type: 'question.requested', requestId: 'q', questions: [] });
  const answers: [] = []; const params = { questionId: `${session.id}:q`, answers };
  const first = rpc(core, 'a1', 'question.answer', params); await entered.promise;
  const second = rpc(core, 'a2', 'question.answer', params);
  if (cancel) emit({ type: 'question.resolved', requestId: 'q', decision: 'cancelled' });
  release.resolve(); expect(await first).toMatchObject({ ok: !cancel }); expect(await second).toMatchObject({ ok: false });
  const events = store.events(0, 100).filter(event => event.data.type === 'question.resolved'); expect(events).toHaveLength(1);
  expect(events[0]!.data).toMatchObject({ question: cancel ? { status: 'cancelled' } : { status: 'answered', answers } });
  expect(runtime.answerQuestion).toHaveBeenCalledTimes(1);
});

it.each(['running', 'idle', 'waiting_approval'] as const)('does not overwrite newer %s status with a stale reconcile response', async status => {
  const { core, runtime, store, session, emit } = await fixture();
  store.append({ type: 'session.updated', session: { ...session, status: 'running', updatedAt: new Date(0).toISOString() } });
  const entered = barrier(); const release = barrier();
  vi.spyOn(runtime, 'listSessions').mockImplementation(async () => { entered.resolve(); await release.promise; return []; });
  const snapshot = core.snapshot(); await entered.promise; emit({ type: 'status', status }); release.resolve(); await snapshot;
  expect(store.session(session.id)?.status).toBe(status);
});

it('a known resolution removes only the approval overlay on an authoritative running turn', async () => {
  const { store, session, emit } = await fixture();
  emit({ type: 'status', status: 'running' }); emit({ type: 'approval.requested', requestId: 'normal', tool: 'tool', reason: 'reason' });
  expect(store.session(session.id)?.status).toBe('waiting_approval');
  emit({ type: 'approval.resolved', requestId: 'normal', decision: 'approved' }); expect(store.session(session.id)?.status).toBe('running');
});

it('unknown duplicate and late approval resolutions never resurrect an ended turn', async () => {
  const { store, session, emit } = await fixture();
  emit({ type: 'approval.resolved', requestId: 'unknown', decision: 'cancelled' }); expect(store.session(session.id)?.status).toBe('idle');
  emit({ type: 'approval.requested', requestId: 'known', tool: 'tool', reason: 'reason' }); emit({ type: 'status', status: 'idle' });
  emit({ type: 'approval.resolved', requestId: 'known', decision: 'cancelled' }); emit({ type: 'approval.resolved', requestId: 'known', decision: 'approved' }); expect(store.session(session.id)?.status).toBe('idle');
});

it('real isolated HTTP rejects a body completed after server closing without dispatching Core', async () => {
  const { core } = await fixture(); const server = await startDaemonServer({ core, token: 'test', port: 0 }); cleanups.push(() => server.close());
  const handle = vi.spyOn(core, 'handle');
  const text = JSON.stringify({ v: 1, id: 'half', method: 'system.snapshot', params: {} });
  const sent = barrier();
  const originalIterator = IncomingMessage.prototype[Symbol.asyncIterator];
  const iterator = vi.spyOn(IncomingMessage.prototype, Symbol.asyncIterator).mockImplementation(function (this: IncomingMessage) { sent.resolve(); return originalIterator.call(this); });
  const response = new Promise<string>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.port, path: '/rpc', method: 'POST', headers: { authorization: 'Bearer test', 'content-length': Buffer.byteLength(text), 'content-type': 'application/json' } }, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve(body)); });
    req.on('error', reject);
    req.write(text.slice(0, 10));
    void sent.promise.then(async () => { const closing = server.close(); req.end(text.slice(10)); await closing; });
  });
  try { expect(JSON.parse(await response)).toMatchObject({ ok: false, id: 'half', error: { code: 'CORE_CLOSING' } }); expect(handle).not.toHaveBeenCalled(); }
  finally { iterator.mockRestore(); }
});
