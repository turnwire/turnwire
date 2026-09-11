import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TurnwireCore } from '@turnwire/core';
import type { TunnelOptions } from '../apps/daemon/src/tunnel.js';

const mocks = vi.hoisted(() => ({ relayClose: vi.fn(async () => {}), bridgeClose: vi.fn(async () => {}), connected: true }));
vi.mock('node:fs/promises', () => ({ access: vi.fn(async () => {}) }));
vi.mock('../apps/relay/src/server.js', () => ({ startRelay: vi.fn(async () => ({ port: 1234, close: mocks.relayClose })) }));
vi.mock('../apps/daemon/src/remote.js', () => ({ RemoteBridge: class {
  constructor(_core: unknown, _url: string, _token: string, presence: { confirm(id: string, latency: number): void }) { confirmPhone = () => presence.confirm('phone', 4); }
  get connected() { return mocks.connected; }
  start() {} close = mocks.bridgeClose; refreshDevices() {}
} }));
vi.mock('../apps/daemon/src/direct.js', () => ({ DirectController: class {
  start() {} async close() {} endpoints() { return []; }
} }));
vi.mock('../apps/daemon/src/notifications.js', () => ({ NotificationController: class {
  attach() {} detach() {} async close() {}
} }));
import { RemoteController } from '../apps/daemon/src/remote-control.js';

const named = { mode: 'temporary', provider: 'cloudflare-named', namedTunnel: { name: 'fixture', hostname: 'phone.example.com', credentialsFile: '/mock/credentials.json', protocol: 'http2' } } as const;
let controllers: RemoteController[];
let confirmPhone: () => void;
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.connected = true; controllers = []; });
afterEach(async () => { for (const controller of controllers) await controller.close(); vi.useRealTimers(); });
async function flush() { await vi.advanceTimersByTimeAsync(0); }
function fixture() {
  const starts: TunnelOptions[] = [];
  const close = vi.fn(async () => {});
  const start = vi.fn(async (options: TunnelOptions) => { starts.push(options); return { url: options.namedTunnel ? 'https://phone.example.com' : `https://temporary-${starts.length}.example.com`, close }; });
  const core = { store: { setting: vi.fn(), setSetting: vi.fn(), devices: () => [{ clientId: 'phone' }] } } as unknown as TurnwireCore;
  const controller = new RemoteController(core, { directory: '/mock', webRoot: '/mock/web', providers: [
    { id: 'cloudflare-named', name: 'Named', description: 'Mock', requiresToken: false, start },
    { id: 'cloudflare', name: 'Temporary', description: 'Mock', requiresToken: false, start },
  ] });
  controllers.push(controller);
  return { controller, starts, start, close };
}
it('retries named exits with bounded exponential backoff and preserves the pairing hostname', async () => {
  const { controller, starts, start } = fixture();
  controller.configure(named); await flush();
  expect(controller.status().message).toContain('public tunnel reachability is unverified');
  for (const [index, delay] of [1000, 2000, 4000].entries()) {
    starts[index]!.exited();
    expect(controller.status().state).toBe('starting');
    expect(controller.status().message).toContain('existing pairings remain valid');
    expect(controller.endpoints()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(start).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(index + 2);
    expect(controller.endpoints()?.remoteUrl).toBe('https://phone.example.com');
  }
  starts[3]!.exited(); await flush();
  expect(controller.status().state).toBe('error');
  expect(controller.status().message).toContain('retry limit');
  await vi.advanceTimersByTimeAsync(60_000); expect(start).toHaveBeenCalledTimes(4);
  controller.configure(named); await flush(); expect(start).toHaveBeenCalledTimes(5);
});
it('keeps identical effective configuration running or starting, but permits explicit offline retry', async () => {
  const { controller, starts, start, close } = fixture();
  controller.configure(named); controller.configure({ mode: 'temporary', provider: 'cloudflare-named' });
  await flush();
  controller.configure(named); await flush();
  expect(start).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled();
  starts[0]!.exited(); controller.configure(named); await flush();
  expect(start).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000); expect(start).toHaveBeenCalledTimes(2);
  mocks.connected = false; controller.configure(named); await flush();
  expect(start).toHaveBeenCalledTimes(3);
});
it('cancels queued recovery on off, ignores stale callbacks, and cancels on disposal', async () => {
  const { controller, starts, start } = fixture();
  controller.configure(named); await flush(); starts[0]!.exited();
  controller.configure({ mode: 'off' }); await flush();
  starts[0]!.exited(); starts[0]!.progress('stale'); starts[0]!.changed?.('https://stale.example.com');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(controller.status().state).toBe('off'); expect(start).toHaveBeenCalledTimes(1);
  controller.configure(named); await flush(); starts[1]!.exited(); await controller.close();
  await vi.advanceTimersByTimeAsync(10_000); expect(start).toHaveBeenCalledTimes(2);
});
it('normalizes relay configuration and does not restart an active channel for the same preferences', async () => {
  const { controller, start } = fixture();
  controller.configure({ mode: 'relay', serverUrl: 'https://relay.example.com/', token: 'x'.repeat(32) }); await flush();
  controller.configure({ mode: 'relay', serverUrl: 'https://relay.example.com' }); await flush();
  expect(mocks.bridgeClose).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
});
it('replaces pending recovery with newly configured preferences', async () => {
  const { controller, starts, start } = fixture(); controller.configure(named); await flush();
  starts[0]!.exited(); controller.configure({ mode: 'temporary', provider: 'cloudflare' }); await flush();
  expect(start).toHaveBeenCalledTimes(2); expect(controller.endpoints()?.remoteUrl).toContain('temporary-2');
  await vi.advanceTimersByTimeAsync(10_000); expect(start).toHaveBeenCalledTimes(2);
});
it('warns honestly about temporary address rotation and retries startup failures only to the cap', async () => {
  const { controller, starts, start } = fixture();
  controller.configure({ mode: 'temporary' }); await flush(); starts[0]!.exited();
  expect(controller.status().message).toContain('address may change');
  start.mockRejectedValue(new Error('mock startup failure'));
  await vi.advanceTimersByTimeAsync(7000);
  expect(start).toHaveBeenCalledTimes(4); expect(controller.status().state).toBe('error');
  expect(controller.status().message).toContain('mock startup failure');
});
it('distinguishes local readiness from fresh device confirmation and expires confirmation', async () => {
  const { controller } = fixture(); controller.configure(named); await flush();
  expect(controller.status().message).toContain('unverified');
  confirmPhone(); expect(controller.status().message).toContain('paired device confirmed');
  await vi.advanceTimersByTimeAsync(25_000);
  expect(controller.status().message).toContain('unverified');
});
it('fences an exit arriving before the provider start promise resolves', async () => {
  const { controller, start, close } = fixture();
  start.mockImplementationOnce(async options => { options.exited(); return { url: 'https://phone.example.com', close }; });
  controller.configure(named); await flush();
  expect(controller.endpoints()).toBeUndefined(); expect(controller.status().state).toBe('starting');
  await vi.advanceTimersByTimeAsync(1000);
  expect(start).toHaveBeenCalledTimes(2); expect(controller.status().state).toBe('online');
});
