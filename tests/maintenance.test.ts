import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { startDaemonServer } from '../apps/daemon/src/server.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function setup(path = ':memory:') {
  const runtime = Object.assign(new DemoRuntime(), { busy: vi.fn(async (_roots?: string[]) => 0) });
  const store = new Store(path); const core = new TurnwireCore(store, [runtime], { id: 'test', name: 'Test' });
  cleanup.push(() => core.dispose()); return { core, runtime, store };
}
const command = (core: TurnwireCore, id: string, method: string, params: unknown) => core.handle({ v: 1, id, method, params });
const create = (core: TurnwireCore, id: string) => command(core, id, 'session.create', { runtimeId: 'demo', cwd: process.cwd(), title: 'test' });

it('atomically holds intake while an admitted command finishes and permits replay', async () => {
  const { core, runtime } = setup();
  let release!: () => void; let entered!: () => void;
  const seen = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const original = runtime.createSession.bind(runtime);
  vi.spyOn(runtime, 'createSession').mockImplementation(async input => { entered(); await barrier; return original(input); });
  const pending = create(core, 'first'); await seen;
  const hold = await core.configureMaintenance({ action: 'begin' });
  expect(hold).toMatchObject({ state: 'draining', inFlight: 1 });
  const rejected = await Promise.all(Array.from({ length: 20 }, (_, i) => create(core, `blocked-${i}`)));
  expect(rejected.every(result => !result.ok && result.error.code === 'MAINTENANCE')).toBe(true);
  release(); const result = await pending;
  expect(await create(core, 'first')).toEqual(result);
  expect(await core.maintenanceStatus()).toMatchObject({ state: 'ready', scope: 'turnwire-managed' });
  await expect(core.configureMaintenance({ action: 'cancel', token: 'wrong' })).rejects.toThrow('token');
  await core.configureMaintenance({ action: 'cancel', token: hold.token });
  expect((await create(core, 'after')).ok).toBe(true);
});

it('blocks message resume and queue actions but allows cancellation', async () => {
  const { core } = setup(); const created = await create(core, 'root');
  if (!created.ok) throw new Error('create failed'); const sessionId = (created.result as { id: string }).id;
  await core.configureMaintenance({ action: 'begin' });
  for (const [method, params] of [
    ['session.message', { sessionId, text: 'new' }], ['session.resume', { sessionId }],
    ['session.queueAction', { sessionId, messageId: 'q', action: { kind: 'remove' } }],
  ] as const) expect(await command(core, method, method, params)).toMatchObject({ ok: false, error: { code: 'MAINTENANCE' } });
  expect(await command(core, 'cancel', 'session.cancel', { sessionId })).toMatchObject({ ok: true });
});

it('fails closed for failed busy probes', async () => {
  const { core, runtime } = setup();
  runtime.busy.mockRejectedValueOnce(new Error('offline'));
  expect(await core.configureMaintenance({ action: 'begin' })).toMatchObject({ state: 'draining', busy: null });
  runtime.busy.mockResolvedValueOnce(2);
  expect(await core.maintenanceStatus()).toMatchObject({ state: 'draining', busy: 2 });
  expect(await core.maintenanceStatus()).toMatchObject({ state: 'ready', busy: 0 });
});

it('rejects readiness if a permitted drain command overlaps the runtime check', async () => {
  const { core, runtime } = setup(); const created = await create(core, 'root');
  if (!created.ok) throw new Error('create failed'); const sessionId = (created.result as { id: string }).id;
  const hold = await core.configureMaintenance({ action: 'begin' });
  let release!: () => void; let entered!: () => void;
  const seen = new Promise<void>(resolve => { entered = resolve; });
  runtime.busy.mockImplementationOnce(async () => { entered(); return new Promise<number>(resolve => { release = () => resolve(0); }); });
  const check = core.maintenanceStatus(); await seen;
  await command(core, 'stop', 'session.cancel', { sessionId });
  release(); expect(await check).toMatchObject({ state: 'draining', busy: null });
  expect(await core.configureMaintenance({ action: 'begin', token: hold.token })).toMatchObject({ state: 'ready' });
});

it('persists the bound hold through a fresh daemon core and never resumes on startup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turnwire-maintenance-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const first = setup(join(dir, 'state.db')); await create(first.core, 'root');
  const hold = await first.core.configureMaintenance({ action: 'begin' });
  const second = setup(join(dir, 'state.db'));
  const resume = vi.spyOn(second.runtime, 'resumeSession'); await second.core.start();
  expect(resume).not.toHaveBeenCalled();
  expect(await second.core.maintenanceStatus()).toMatchObject({ token: hold.token, state: 'draining', busy: null });
  expect(await create(second.core, 'blocked')).toMatchObject({ ok: false, error: { code: 'MAINTENANCE' } });
  await second.core.configureMaintenance({ action: 'cancel', token: hold.token });
  expect(await create(second.core, 'new')).toMatchObject({ ok: true });
});

it('requires local bearer authentication and rejects remote/proxied administration', async () => {
  const { core } = setup(); const server = await startDaemonServer({ core, token: 'secret', port: 0 }); cleanup.push(server.close);
  const url = `http://127.0.0.1:${server.port}/maintenance`;
  expect((await fetch(url)).status).toBe(401);
  const remoteStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { headers: { authorization: 'Bearer secret', host: 'remote.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end();
  });
  expect(remoteStatus).toBe(403);
  expect((await fetch(url, { headers: { authorization: 'Bearer secret', 'x-forwarded-for': '203.0.113.1' } })).status).toBe(403);
  const response = await fetch(url, { method: 'PUT', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'begin' }) });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: 'ready', scope: 'turnwire-managed' });
  expect((await command(core, 'remote', 'maintenance.begin', {})).ok).toBe(false);
});
