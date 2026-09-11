import { afterEach, expect, it, vi } from 'vitest';
import { LocalClient, RemoteClient, sendImageMessage, type RpcClient } from '@turnwire/sdk';
import type { MethodResult } from '@turnwire/protocol';

function typedImageReceipt(client: RpcClient) {
  const receipt: Promise<MethodResult<'session.message'>> = sendImageMessage(client, { sessionId: 's', text: '', images: [] });
  // @ts-expect-error Image results follow session.message, not caller supplied expectations.
  const incorrect: Promise<string> = sendImageMessage(client, { sessionId: 's', text: '', images: [] });
  return [receipt, incorrect];
}
void typedImageReceipt;
import { createProgram } from '../apps/cli/src/program.js';
import { runTui, printRemote } from '../apps/cli/src/terminal.js';

const status = { state: 'draining' as const, scope: 'turnwire-managed' as const, inFlight: 1, busy: 2, token: 'owner-token' };
const dispatch = (args: string[], pairing?: string) => createProgram({ url: 'http://localhost:1', token: 'daemon-token', json: true, lang: 'en', pairing }).parseAsync(args, { from: 'user' });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('validates local maintenance GET/PUT contract and keeps authorization separate', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => status }); vi.stubGlobal('fetch', fetcher);
  const client = new LocalClient('http://localhost:1', 'daemon-token');
  await expect(client.maintenanceStatus()).resolves.toEqual(status);
  expect(fetcher.mock.calls[0]?.[0].pathname).toBe('/maintenance');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer daemon-token' }, redirect: 'error' });
  await client.configureMaintenance({ action: 'cancel', token: 'owner-token' });
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ action: 'cancel', token: 'owner-token' }) });
  await expect(client.configureMaintenance({ action: 'cancel', token: '' })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ ...status, busy: -1 }) });
  await expect(client.maintenanceStatus()).rejects.toThrow();
  expect('configureMaintenance' in RemoteClient.prototype).toBe(false);
});
it('prints owner token only for explicit local begin and forwards exact cancellation token', async () => {
  const configure = vi.spyOn(LocalClient.prototype, 'configureMaintenance').mockResolvedValue(status);
  vi.spyOn(LocalClient.prototype, 'maintenanceStatus').mockResolvedValue(status);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await dispatch(['maintenance', 'begin', '--lease-token', 'retry-owner']);
  expect(configure).toHaveBeenLastCalledWith({ action: 'begin', token: 'retry-owner' });
  expect(JSON.parse(String(log.mock.lastCall?.[0])).token).toBe('owner-token');
  log.mockClear(); await dispatch(['maintenance', 'status']);
  expect(JSON.parse(String(log.mock.lastCall?.[0])).token).toBeUndefined();
  log.mockClear(); await dispatch(['maintenance', 'cancel', '--lease-token', 'owner-token']);
  expect(configure).toHaveBeenLastCalledWith({ action: 'cancel', token: 'owner-token' });
  expect(JSON.parse(String(log.mock.lastCall?.[0])).token).toBeUndefined();
});
it('requires owner token for compaction and redacts it from the resulting status', async () => {
  const configure = vi.spyOn(LocalClient.prototype, 'configureMaintenance').mockResolvedValue(status);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await dispatch(['maintenance', 'compact', '--lease-token', 'owner-token']);
  expect(configure).toHaveBeenCalledWith({ action: 'compact', token: 'owner-token' });
  expect(JSON.parse(String(log.mock.lastCall?.[0])).token).toBeUndefined();
});
it('requires cancel owner token instead of inheriting daemon token and rejects paired clients before IO', async () => {
  const configure = vi.spyOn(LocalClient.prototype, 'configureMaintenance');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await expect(dispatch(['maintenance', 'cancel'])).rejects.toThrow('required option');
  for (const args of [['status'], ['begin'], ['cancel', '--lease-token', 'owner']]) await expect(dispatch(['maintenance', ...args], '/not-read')).rejects.toThrow();
  expect(configure).not.toHaveBeenCalled();
});
it('preserves global authorization and JSON flags after the maintenance command', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => status }); vi.stubGlobal('fetch', fetcher);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await dispatch(['maintenance', 'cancel', '--lease-token', 'owner', '--token', 'override-daemon', '--json']);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: 'Bearer override-daemon' }, body: JSON.stringify({ action: 'cancel', token: 'owner' }) });
});
it('TUI uses the same local maintenance dispatcher without recording token commands', async () => {
  const configure = vi.spyOn(LocalClient.prototype, 'configureMaintenance').mockResolvedValue(status);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const lines = ['maintenance begin', 'maintenance cancel --lease-token "owner token"', 'quit'];
  const write = vi.fn(); await runTui(dispatch, '', { ask: async () => lines.shift(), write });
  expect(configure).toHaveBeenNthCalledWith(1, { action: 'begin' });
  expect(configure).toHaveBeenNthCalledWith(2, { action: 'cancel', token: 'owner token' });
  expect(JSON.stringify(write.mock.calls)).not.toContain('owner token');
});
it('renders separate optional remote health stages without inventing verified status', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  printRemote({ mode: 'off', state: 'off', message: 'Off', notices: [], hasRelayToken: false, hasCpolarToken: false, providers: [], health: { relayRegistration: 'ready', tunnelProcess: 'off', publicReachability: 'unknown', deviceConfirmed: 'unknown' } });
  expect(log).toHaveBeenCalledWith('publicReachability: unknown');
  expect(log).toHaveBeenCalledWith('deviceConfirmed: unknown');
});
