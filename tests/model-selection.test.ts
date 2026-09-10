import { describe, expect, it, vi } from 'vitest';
import { TurnwireCore, Store } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import type { ModelCatalog, ModelSelection, RpcResponse, Session } from '@turnwire/protocol';

/**
 * Models are runtime-owned: a client may only choose what the runtime's catalog lists. These
 * tests pin that boundary, because a stored-but-unregistered id is only rejected when the
 * runtime finally tries to run it, which is far away from the client that asked for it.
 */
const CATALOG: ModelCatalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  routableProviders: ['deepseek-official'],
  groups: [{
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
  }],
  failures: [],
};

class CatalogRuntime extends DemoRuntime {
  readonly selections = new Map<string, ModelSelection>();
  override capabilities() { return { ...super.capabilities(), modelSelection: true }; }
  async modelCatalog(): Promise<ModelCatalog> { return CATALOG; }
  /** Resolves the effort the way a real host does, so the session records the resolved value. */
  async setModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection> {
    const resolved = { ...selection, reasoningEffort: selection.reasoningEffort ?? 'high' };
    this.selections.set(sessionId, resolved);
    return resolved;
  }
}

/** A runtime that can select but publishes no catalog: there is nothing to validate against. */
class NoCatalogRuntime extends DemoRuntime {
  override capabilities() { return { ...super.capabilities(), modelSelection: true }; }
  async setModel(_sessionId: string, selection: ModelSelection): Promise<ModelSelection> { return selection; }
}

function value<T>(response: RpcResponse): T { if (!response.ok) throw new Error(response.error.message); return response.result as T; }
function setup<T extends DemoRuntime>(runtime: T): { core: TurnwireCore; runtime: T; store: Store } {
  const store = new Store(':memory:');
  return { core: new TurnwireCore(store, [runtime], { id: 'mac', name: 'Test Mac' }), runtime, store };
}
const catalogSetup = () => setup(new CatalogRuntime());
const call = (core: TurnwireCore, id: string, method: string, params: unknown = {}) => core.handle({ v: 1, id, method, params });
const create = (core: TurnwireCore, params: Record<string, unknown> = {}) => call(core, 'create', 'session.create', { title: 'Test', cwd: process.cwd(), runtimeId: 'demo', ...params });

describe('runtime-owned model selection', () => {
  it('accepts a listed model and records what the runtime resolved', async () => {
    const { core, runtime, store } = catalogSetup();
    const session = value<Session>(await create(core));
    const updated = value<Session>(await call(core, 'pick', 'session.setModel', { sessionId: session.id, provider: 'deepseek-official', model: 'deepseek-v4-pro' }));
    expect(updated.model).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' });
    expect(store.session(session.id)?.model?.model).toBe('deepseek-v4-pro');
    expect(runtime.selections.get(session.runtimeSessionId)?.model).toBe('deepseek-v4-pro');
  });

  it('rejects an unlisted model without ever reaching the runtime', async () => {
    const { core, runtime, store } = catalogSetup();
    const session = value<Session>(await create(core));
    const spy = vi.spyOn(runtime, 'setModel');
    const response = await call(core, 'ghost', 'session.setModel', { sessionId: session.id, provider: 'deepseek-official', model: 'deepseek-v4.1-flash' });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('MODEL_UNAVAILABLE');
    expect(spy).not.toHaveBeenCalled();
    expect(store.session(session.id)?.model).toBeUndefined();
  });

  it('matches provider and model together, not either one alone', async () => {
    const { core, runtime } = catalogSetup();
    const session = value<Session>(await create(core));
    const spy = vi.spyOn(runtime, 'setModel');
    // A listed model under a provider that does not offer it, and an unknown provider.
    for (const request of [{ provider: 'openai', model: 'deepseek-v4-pro' }, { provider: 'deepseek-official', model: 'gpt-5' }]) {
      const response = await call(core, JSON.stringify(request) + 'x', 'session.setModel', { sessionId: session.id, ...request });
      expect(response.ok).toBe(false);
      if (!response.ok) expect(response.error.code).toBe('MODEL_UNAVAILABLE');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses an unlisted model at creation instead of leaving a half-created session', async () => {
    const { core, runtime, store } = catalogSetup();
    const spy = vi.spyOn(runtime, 'createSession');
    const response = await create(core, { model: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash' } });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('MODEL_UNAVAILABLE');
    expect(spy).not.toHaveBeenCalled();
    expect(store.sessions()).toHaveLength(0);
  });

  it('creates a session with a listed model', async () => {
    const { core } = catalogSetup();
    const session = value<Session>(await create(core, { model: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }));
    expect(session.model).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' });
  });

  it('leaves the choice to a runtime that publishes no catalog', async () => {
    const { core } = setup(new NoCatalogRuntime());
    const session = value<Session>(await create(core));
    const updated = value<Session>(await call(core, 'nocat', 'session.setModel', { sessionId: session.id, provider: 'anything', model: 'anything' }));
    expect(updated.model).toEqual({ provider: 'anything', model: 'anything' });
  });
});
