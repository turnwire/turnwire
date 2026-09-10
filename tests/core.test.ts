import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TurnwireCore, Store } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import type { RpcResponse, Session } from '@turnwire/protocol';
import { conversation } from '@turnwire/sdk';

function value<T>(response: RpcResponse): T { if (!response.ok) throw new Error(response.error.message); return response.result as T; }
let cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup = []; });
function setup(store = new Store(':memory:')) { const runtime = new DemoRuntime(); const core = new TurnwireCore(store, [runtime], { id: 'mac', name: 'Test Mac' }); cleanup.push(() => core.dispose()); return { core, runtime, store }; }
const call = (core: TurnwireCore, id: string, method: string, params: unknown = {}) => core.handle({ v: 1, id, method, params });
async function session(core: TurnwireCore) { return value<Session>(await call(core, 'create', 'session.create', { title: 'Test', cwd: process.cwd(), runtimeId: 'demo' })); }
describe('durable daemon ownership', () => {
  it('deduplicates concurrent commands and rejects reused ids with changed content', async () => {
    const { core, runtime, store } = setup(); const s = await session(core); const spy = vi.spyOn(runtime, 'sendMessage');
    const request = { sessionId: s.id, text: 'hello' };
    const [a, b] = await Promise.all([call(core, 'prompt', 'session.message', request), call(core, 'prompt', 'session.message', request)]);
    expect(a).toEqual(b); expect(a.ok).toBe(true); expect(spy).toHaveBeenCalledTimes(1);
    const conflict = await call(core, 'prompt', 'session.message', { ...request, text: 'different' }); expect(conflict.ok).toBe(false);
    expect(conversation(store.events(0, 100), s.id).map(m => m.role)).toEqual(['user', 'assistant']);
  });
  it('records that a prompt sent during a turn waits behind it instead of interrupting', async () => {
    const { core, store } = setup(); const s = await session(core);
    await call(core, 'first', 'session.message', { sessionId: s.id, text: 'approval' });
    expect(['running', 'waiting_approval']).toContain(store.session(s.id)?.status);
    await call(core, 'second', 'session.message', { sessionId: s.id, text: '排队的那一条' });
    const sent = store.events(0, 100).filter(e => e.data.type === 'message.user');
    expect(sent[0]?.data).not.toHaveProperty('queued');
    expect(sent.at(-1)?.data).toMatchObject({ text: '排队的那一条', queued: true });
  });
  it('steers a running turn when asked instead of queueing behind it', async () => {
    const { core, store } = setup(); const s = await session(core);
    await call(core, 'first', 'session.message', { sessionId: s.id, text: 'approval' });
    await call(core, 'steer', 'session.message', { sessionId: s.id, text: '插话', steer: true });
    const sent = store.events(0, 100).filter(e => e.data.type === 'message.user');
    expect(sent.at(-1)?.data).toMatchObject({ text: '插话', steer: true });
    expect(sent.at(-1)?.data).not.toHaveProperty('queued');
  });
  it('makes approvals one-shot across competing clients', async () => {
    const { core, runtime, store } = setup(); const s = await session(core); await call(core, 'message', 'session.message', { sessionId: s.id, text: 'approval' });
    const approval = store.approvals()[0]!; const spy = vi.spyOn(runtime, 'approve');
    const results = await Promise.all([call(core, 'approve', 'approval.decide', { approvalId: approval.id, decision: 'approved' }), call(core, 'reject', 'approval.decide', { approvalId: approval.id, decision: 'rejected' })]);
    expect(results.filter(r => r.ok)).toHaveLength(1); expect(spy).toHaveBeenCalledTimes(1); expect(store.approval(approval.id)?.status).toBe('approved');
    expect(store.session(s.id)?.status).toBe('idle');
  });
  it('cancellation invalidates outstanding approvals', async () => {
    const { core, store } = setup(); const s = await session(core); await call(core, 'message', 'session.message', { sessionId: s.id, text: '审批' });
    const approval = store.approvals()[0]!; await call(core, 'stop', 'session.cancel', { sessionId: s.id });
    expect(store.approval(approval.id)?.status).toBe('cancelled'); expect(store.session(s.id)?.status).toBe('idle');
    expect((await call(core, 'late', 'approval.decide', { approvalId: approval.id, decision: 'approved' })).ok).toBe(false);
  });
  it('retains event order, session mappings and command receipts across restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'turnwire-store-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'state.db'); const first = setup(new Store(path)); const s = await session(first.core);
    const request = { sessionId: s.id, text: 'hello' }; const result = await call(first.core, 'message', 'session.message', request); const cursor = first.store.cursor();
    await first.core.dispose(); cleanup.pop();
    const second = setup(new Store(path)); await second.core.start();
    expect(second.store.session(s.id)?.runtimeSessionId).toBe(s.runtimeSessionId);
    expect(await call(second.core, 'message', 'session.message', request)).toEqual(result);
    expect(second.store.events(cursor, 100).every(e => e.seq > cursor)).toBe(true);
    expect(conversation(second.store.events(0, 100), s.id)).toHaveLength(2);
  });
  it('reports background agents the runtime still owns', async () => {
    class BusyRuntime extends DemoRuntime { async busy() { return 2; } }
    // A runtime that cannot answer must not break the snapshot; it reports none.
    class UnreachableRuntime extends DemoRuntime { async busy(): Promise<number> { throw new Error('The runtime host is unreachable'); } }
    const device = { id: 'mac', name: 'Test Mac' };
    expect((await new TurnwireCore(new Store(':memory:'), [new BusyRuntime()], device).snapshot()).runtimes[0]?.busy).toBe(2);
    expect((await new TurnwireCore(new Store(':memory:'), [new UnreachableRuntime()], device).snapshot()).runtimes[0]?.busy).toBe(0);
  });
  it('does not replay a command whose result was interrupted by a crash', async () => {
    const { core, store } = setup(); const params = { cwd: process.cwd(), runtimeId: 'demo' };
    const fingerprint = createHash('sha256').update(JSON.stringify({ method: 'session.create', params })).digest('hex');
    store.reserveRequest('pending', fingerprint);
    const response = await call(core, 'pending', 'session.create', params); expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('OUTCOME_UNKNOWN');
    expect(store.sessions()).toHaveLength(0);
  });
  it('validates unknown methods, protocol version, empty prompts and workspace paths', async () => {
    const { core } = setup(); const s = await session(core);
    expect((await core.handle({ v: 2, id: 'x', method: 'system.snapshot', params: {} })).ok).toBe(false);
    expect((await call(core, 'x', 'shell.execute', {})).ok).toBe(false);
    expect((await call(core, 'y', 'session.message', { sessionId: s.id, text: '  ' })).ok).toBe(false);
    expect((await call(core, 'z', 'session.create', { runtimeId: 'demo', cwd: 'relative/path' })).ok).toBe(false);
  });
});
