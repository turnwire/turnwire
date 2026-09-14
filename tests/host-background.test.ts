import { afterEach, expect, it, vi } from 'vitest';
import { Store, TurnwireCore } from '@turnwire/core';
import { HostActivity } from '../apps/daemon/src/host-activity.js';
import { DirectController } from '../apps/daemon/src/direct.js';
import { NotificationController } from '../apps/daemon/src/notifications.js';
import type { RemoteBridge } from '../apps/daemon/src/remote.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });
function setup() {
  const core = new TurnwireCore(new Store(':memory:'), [], { id: 'host', name: 'Host' });
  cleanup.push(() => core.dispose());
  const activity = new HostActivity(recovery => core.enterHostActivity(recovery));
  const notifications = new NotificationController(core, activity);
  cleanup.push(() => notifications.close());
  return { core, activity, notifications };
}
function bridgeFixture(notifications: NotificationController) {
  const frames: Array<Record<string, unknown>> = [];
  const bridge = { connected: true, onControl: undefined as ((frame: Record<string, unknown>) => void) | undefined,
    sendControl(frame: Record<string, unknown>) { frames.push(frame); } };
  notifications.attach(bridge as unknown as RemoteBridge, 'test');
  const ready = () => bridge.onControl!({ type: 'ready', push: { publicKey: 'test-key' } });
  const respond = () => bridge.onControl!({ type: 'push.response', id: frames.at(-1)!.id, ok: true, result: {} });
  return { frames, ready, respond };
}

it('keeps a configured asynchronous restore admitted until its RPC and store writes settle', async () => {
  const { core, activity, notifications } = setup();
  const bridge = bridgeFixture(notifications);
  bridge.ready(); bridge.respond(); await activity.drain();
  notifications.configure(true);
  expect(bridge.frames.at(-1)).toMatchObject({ action: 'configure', enabled: true });
  expect(await core.configureMaintenance({ action: 'begin' })).toMatchObject({ state: 'draining', inFlight: 1 });
  bridge.respond(); await activity.drain();
  expect(await core.maintenanceStatus()).toMatchObject({ state: 'ready', inFlight: 0 });
});

it('skips idle notification timers under a maintenance hold without persistent writes or new leases', async () => {
  vi.useFakeTimers();
  const { core, notifications } = setup();
  const bridge = bridgeFixture(notifications);
  await core.configureMaintenance({ action: 'begin' });
  const writes = vi.spyOn(core.store, 'setSetting');
  const admission = vi.spyOn(core, 'enterHostActivity');
  await vi.advanceTimersByTimeAsync(3000);
  await notifications.flush(); bridge.ready(); await Promise.resolve();
  expect(writes).not.toHaveBeenCalled();
  expect(admission.mock.results.every(result => result.type === 'throw')).toBe(true);
  expect(bridge.frames).toEqual([]);
  expect(await core.maintenanceStatus()).toMatchObject({ state: 'ready', inFlight: 0 });
});

it('drains pending notification restore locally on close without waiting for unrelated shared activity', async () => {
  const { core, activity, notifications } = setup();
  const bridge = bridgeFixture(notifications); bridge.ready();
  let release!: () => void;
  const unrelated = activity.run(() => new Promise<void>(resolve => { release = resolve; }));
  await notifications.close();
  expect(await core.maintenanceStatus()).toMatchObject({ inFlight: 1 });
  const writes = vi.spyOn(core.store, 'setSetting');
  expect(() => notifications.configure(true)).toThrow('closed');
  await notifications.flush(); bridge.ready();
  expect(writes).not.toHaveBeenCalled();
  release(); await unrelated;
});

it('resumes notification restore explicitly after hold cancellation and drains disable under hold', async () => {
  const { core, activity, notifications } = setup();
  const bridge = bridgeFixture(notifications);
  const hold = await core.configureMaintenance({ action: 'begin' });
  bridge.ready(); await Promise.resolve(); expect(bridge.frames).toEqual([]);
  expect(() => notifications.configure(true)).toThrow('Maintenance');
  await core.configureMaintenance({ action: 'cancel', token: hold.token });
  notifications.configure(true); expect(bridge.frames.at(-1)).toMatchObject({ action: 'configure', enabled: true });
  bridge.respond(); await activity.drain();
  await core.configureMaintenance({ action: 'begin' });
  notifications.configure(false); expect(bridge.frames.at(-1)).toMatchObject({ action: 'configure', enabled: false });
  expect(await core.maintenanceStatus()).toMatchObject({ state: 'draining', inFlight: 1 });
  await notifications.close(); await activity.drain();
  expect(await core.maintenanceStatus()).toMatchObject({ state: 'ready', inFlight: 0 });
});

it('gates direct configuration before writes, permits disable recovery, and drains the start lifecycle', async () => {
  const { core, activity } = setup();
  const direct = new DirectController(core, () => undefined, () => true, activity);
  cleanup.push(() => direct.close());
  const hold = await core.configureMaintenance({ action: 'begin' });
  const writes = vi.spyOn(core.store, 'setSetting');
  expect(() => direct.configure({ enabled: true, url: 'wss://localhost/', certificatePath: '/unused', privateKeyPath: '/unused' })).toThrow();
  expect(writes).not.toHaveBeenCalled();
  direct.configure({ enabled: false });
  await direct.close();
  expect(await core.maintenanceStatus()).toMatchObject({ state: 'ready', inFlight: 0 });
  expect(() => direct.configure({ enabled: false })).toThrow('closed');
  await core.configureMaintenance({ action: 'cancel', token: hold.token });
});
