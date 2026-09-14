import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/core/src/store.js';
import { TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { SessionCreation } from '../packages/core/src/session-creation.js';
import type { AgentRuntime, RuntimeSession } from '@turnwire/runtime';
import type { ModelSelection } from '@turnwire/protocol';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const model: ModelSelection = { provider: 'fixture', model: 'fixture-model' };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'turnwire-creation-test-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'store.db'); let store = new Store(path); cleanup.push(() => store.close());
  const helper = () => new SessionCreation(store, (event, settings) => store.append(event, undefined, settings));
  return { get store() { return store; }, helper, async restart() { await store.close(); store = new Store(path); } };
}
function runtimeFixture() {
  const roots = new Map<string, RuntimeSession>();
  const createSession = vi.fn(async ({ id, cwd }: { id: string; cwd: string }) => { const root = roots.get(id) ?? { id, cwd, status: 'idle' as const }; roots.set(id, root); return root; });
  const resumeSession = vi.fn(async ({ id }: { id: string; cwd: string }) => { const root = roots.get(id); if (!root) throw new Error('root missing'); return root; });
  const setModel = vi.fn(async (_id: string, selected: ModelSelection) => selected);
  return { roots, createSession, resumeSession, setModel, runtime: { id: 'fixture', createSession, resumeSession, setModel } as unknown as AgentRuntime };
}
it('persists mapping and intent before allocation; rejected model remains recoverable after restart', async () => {
  const state = setup(); const fixture = runtimeFixture();
  fixture.createSession.mockImplementationOnce(async ({ id, cwd }) => {
    expect(state.store.session(id)).toMatchObject({ runtimeSessionId: id, status: 'interrupted' });
    expect(state.store.setting(`session.creation:${id}`)).toMatchObject({ phase: 'allocating' });
    const root = { id, cwd, status: 'idle' as const }; fixture.roots.set(id, root); return root;
  });
  fixture.setModel.mockRejectedValueOnce(new Error('model rejected'));
  const partial = await state.helper().create(fixture.runtime, { cwd: '/tmp', title: 'partial', model });
  expect(partial.status).toBe('error'); expect(state.store.sessions()).toHaveLength(1);
  expect(state.store.setting(`session.creation:${partial.id}`)).toMatchObject({ phase: 'configuring', error: 'model rejected' });
  await state.restart();
  const recovered = await state.helper().resume(state.store.session(partial.id)!, fixture.runtime);
  expect(recovered).toMatchObject({ id: partial.id, status: 'idle', model });
  expect(fixture.createSession).toHaveBeenCalledTimes(1); expect(fixture.roots.size).toBe(1);
});
it('allocation timeout after side effect retries the durable identity across restart', async () => {
  const state = setup(); const fixture = runtimeFixture();
  fixture.createSession.mockImplementationOnce(async ({ id, cwd }) => { fixture.roots.set(id, { id, cwd, status: 'idle' }); throw new Error('allocation timed out'); });
  const partial = await state.helper().create(fixture.runtime, { cwd: '/tmp', title: 'timeout' });
  expect(partial.status).toBe('error'); await state.restart();
  expect(await state.helper().resume(state.store.session(partial.id)!, fixture.runtime)).toMatchObject({ id: partial.id, status: 'idle' });
  expect(fixture.createSession.mock.calls.map(([options]) => options.id)).toEqual([partial.id, partial.id]); expect(fixture.roots.size).toBe(1);
});
it('configured intent never recreates a root that disappears before recovery', async () => {
  const state = setup(); const fixture = runtimeFixture(); fixture.setModel.mockRejectedValueOnce(new Error('timeout'));
  const partial = await state.helper().create(fixture.runtime, { cwd: '/tmp', title: 'lost', model });
  fixture.roots.clear(); await state.restart();
  expect(await state.helper().resume(state.store.session(partial.id)!, fixture.runtime)).toMatchObject({ id: partial.id, status: 'error' });
  expect(fixture.createSession).toHaveBeenCalledTimes(1); expect(fixture.roots.size).toBe(0);
});
it('Core create receipt exposes stable partial session and explicit resume recovers it', async () => {
  const store = new Store(':memory:'); const runtime = new DemoRuntime(); const core = new TurnwireCore(store, [runtime], { id: 'test', name: 'test' }); cleanup.push(() => core.dispose());
  const allocate = runtime.createSession.bind(runtime);
  const create = vi.spyOn(runtime, 'createSession').mockImplementationOnce(async options => { await allocate(options); throw new Error('allocation timeout'); });
  const request = { v: 1, id: 'logical-create', method: 'session.create', params: { runtimeId: 'demo', cwd: process.cwd(), title: 'partial' } };
  const response = await core.handle(request); expect(response).toMatchObject({ ok: true, result: { status: 'error' } });
  const partial = store.sessions()[0]!; expect(partial.id).toBe(partial.runtimeSessionId);
  expect(await core.handle(request)).toEqual(response); expect(create).toHaveBeenCalledTimes(1);
  expect(await core.handle({ v: 1, id: 'recover', method: 'session.resume', params: { sessionId: partial.id } })).toMatchObject({ ok: true, result: { id: partial.id, status: 'idle' } });
  expect(store.sessions()).toHaveLength(1); expect((await runtime.listSessions())).toHaveLength(1);
  expect(store.events(0, 100).some(event => event.data.type === 'session.error' && event.data.message.includes('allocating'))).toBe(true);
});
it('failure to commit initial mapping causes no runtime side effect', async () => {
  const state = setup(); const fixture = runtimeFixture();
  const helper = new SessionCreation(state.store, () => { throw new Error('commit rejected'); });
  await expect(helper.create(fixture.runtime, { cwd: '/tmp', title: 'failed' })).rejects.toThrow('commit rejected');
  expect(fixture.createSession).not.toHaveBeenCalled();
});
