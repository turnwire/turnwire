import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { LocalClient, RemoteClient, randomSecret } from '@turnwire/sdk';
import type { PairingResult, Session, Snapshot } from '@turnwire/protocol';
import { RemoteController } from '../apps/daemon/src/remote-control.js';
import { startDaemonServer } from '../apps/daemon/src/server.js';
import { startRelay } from '../apps/relay/src/server.js';
import { createProgram } from '../apps/cli/src/program.js';
import { runTui, remoteMenu, directMenu, notificationsMenu, type TerminalIO } from '../apps/cli/src/terminal.js';

import { hermeticEnv } from './helpers/hermetic-env.mjs';

const run = promisify(execFile);
let cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.reverse()) await close(); cleanup = []; });
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Remote did not become ready');
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'turnwire-parity-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'index.html'), '<title>Turnwire</title>');
  const core = new TurnwireCore(new Store(':memory:'), [new DemoRuntime()], { id: crypto.randomUUID(), name: 'Parity test Mac' });
  await core.start(); cleanup.push(() => core.dispose());
  let stopped = 0;
  const startTunnel = async ({ port }: { port: number }) => ({ url: 'http://127.0.0.1:' + port, close: async () => { stopped++; } });
  const remote = new RemoteController(core, { directory, webRoot: directory, notices: ['Test provider guidance shared by all clients'], startTunnel, providers: (['localhost-run', 'cpolar', 'cloudflare'] as const).map(id => ({ id, name: id, description: '', requiresToken: id === 'cpolar', start: startTunnel })) });
  remote.start(); cleanup.push(() => remote.close());
  const token = randomSecret();
  const server = await startDaemonServer({ core, token, port: 0, remoteAccess: remote }); cleanup.push(() => server.close());
  const url = 'http://127.0.0.1:' + server.port;
  await writeFile(join(directory, 'client.json'), JSON.stringify({ url, token }), { mode: 0o600 });
  const local = new LocalClient(url, token); cleanup.push(() => local.close());
  const cli = async (...args: string[]) => {
    const result = await run(process.execPath, ['--import', 'tsx', resolve('apps/cli/src/main.ts'), '--json', ...args], { env: hermeticEnv(directory, { TURNWIRE_HOME: directory, TURNWIRE_CONFIG_HOME: directory, TURNWIRE_DATA_HOME: directory, TURNWIRE_CACHE_HOME: directory }), timeout: 12000 });
    return JSON.parse(result.stdout) as unknown;
  };
  return { core, remote, local, cli, url, token, stopped: () => stopped };
}
function scripted(lines: string[]) {
  const prompts: Array<{ text: string; secret: boolean }> = []; const output: string[] = [];
  const io: TerminalIO = { ask: async (text, secret = false) => { prompts.push({ text, secret }); return lines.shift(); }, write: text => { output.push(text); } };
  return { io, prompts, output };
}

it('CLI, interactive terminal and SDK share session and remote state through the same daemon', async () => {
  const { remote, local, cli, url, token, stopped } = await setup();
  const session = await cli('new', '--runtime', 'demo', '--title', 'Cross-client session') as Session;
  await cli('remote', 'temporary'); await until(() => remote.status().state === 'online');
  const status = await local.remoteStatus();
  expect(status.notices).toEqual(['Test provider guidance shared by all clients']);
  const pair = await cli('devices', 'pair', '--name', 'Terminal phone') as PairingResult;
  await until(() => remote.status().state === 'online');
  const phone = new RemoteClient(pair.pairing); cleanup.push(() => phone.close());
  expect((await phone.request<Snapshot>('system.snapshot')).sessions[0]?.id).toBe(session.id);

  const lines = scripted([`send ${session.id} 'A literal $(command), with spaces'`, 'remote off', 'ls', 'quit']);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runTui(args => createProgram({ url, token, json: true }).parseAsync(args, { from: 'user' }), '', lines.io);
  // No command in the script may fail, in either locale, so the check covers both catalogues.
  expect(lines.output.filter(line => /无效|invalid/i.test(line))).toEqual([]);
  await until(() => stopped() === 1);
  expect((await cli('remote', 'status') as { state: string }).state).toBe('off');
  const events = await local.request<{ events: Array<{ data: { text?: string } }> }>('events.list', { sessionId: session.id });
  expect(events.events.some(event => event.data.text === 'A literal $(command), with spaces')).toBe(true);
  expect((await local.request<Snapshot>('system.snapshot')).sessions[0]?.id).toBe(session.id);
  expect(log.mock.calls.some(call => String(call[0]).includes(session.id))).toBe(true);
  await cli('devices', 'revoke', pair.pairing.clientId);
  expect(await local.devices()).toEqual([]);
});

it('interactive Relay configuration masks input and relies on the shared saved-key rules', async () => {
  const { local, remote, cli } = await setup();
  const secret = randomSecret(); const relay = await startRelay({ token: secret, port: 0 }); cleanup.push(() => relay.close());
  const server = 'http://127.0.0.1:' + relay.port;
  const first = scripted(['2', server, secret, '0']);
  await remoteMenu(local, first.io); await until(() => remote.status().state === 'online');
  // The key prompt is masked and named as such in either locale; the value itself never echoes.
  expect(first.prompts.some(prompt => /密钥|key/i.test(prompt.text) && prompt.secret)).toBe(true);
  expect(first.output.join('\n')).not.toContain(secret);
  const second = scripted(['2', '', '', '0']);
  await remoteMenu(local, second.io); await until(() => remote.status().state === 'online');
  const before = await local.remoteStatus();
  await expect(local.configureRemote({ mode: 'relay', serverUrl: 'https://new.example.com' })).rejects.toThrow('Relay connection key');
  expect((await local.remoteStatus()).relayUrl).toBe(before.relayUrl);
  expect(JSON.stringify(await cli('remote', 'status'))).not.toContain(secret);
});

it('local admin SDK reports authentication failures and preserves JSON-only CLI output', async () => {
  const { local, cli, url } = await setup();
  const unauthorized = new LocalClient(url, randomSecret()); cleanup.push(() => unauthorized.close());
  // The error code, not a message in one language, is the contract clients localise from.
  await expect(unauthorized.remoteStatus()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(cli('devices', 'pair', '--qr')).rejects.toThrow('--json');
  expect(await local.devices()).toEqual([]);
  await expect(local.configureRemote({ mode: 'relay', serverUrl: 'https://relay.example.com', token: 'x'.repeat(501) })).rejects.toThrow();
});

it('CLI and TUI select the same tunnel providers and keep cpolar token entry private', async () => {
  const { local, remote, cli } = await setup();
  const entry = scripted(['1', '2', 'test-cpolar-private-token', '0']);
  await remoteMenu(local, entry.io); await until(() => remote.status().state === 'online');
  expect(entry.prompts.some(prompt => prompt.text.includes('cpolar Auth Token') && prompt.secret)).toBe(true);
  expect(entry.output.join('\n')).not.toContain('test-cpolar-private-token');
  expect((await local.remoteStatus()).provider).toBe('cpolar');
  await cli('remote', 'temporary', '--provider', 'localhost-run'); await until(() => remote.status().state === 'online');
  expect((await local.remoteStatus()).provider).toBe('localhost-run');
  const selected = scripted(['1', '2', '', '0']); await remoteMenu(local, selected.io); await until(() => remote.status().state === 'online');
  expect((await cli('remote', 'status') as { provider: string }).provider).toBe('cpolar');
  expect((await cli('connection') as { phase: string }).phase).toBe('connected');
});

it('CLI and TUI share bounded history pages and explicit full export', async () => {
  const { core, local, cli, url, token } = await setup();
  const session = await local.request<Session>('session.create', { runtimeId: 'demo', title: 'Pages', cwd: process.cwd() });
  for (let i = 0; i < 85; i++) core.store.append({ type: 'message.user', sessionId: session.id, messageId: `m-${i}`, text: `record ${i}` });
  const first = await cli('history', session.id) as { events: unknown[]; nextBefore: number };
  expect(first.events).toHaveLength(40);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const lines = scripted([`history ${session.id} --before ${first.nextBefore} --limit 20`, 'quit']);
  await runTui(args => createProgram({ url, token, json: true }).parseAsync(args, { from: 'user' }), '', lines.io);
  const page = JSON.parse(String(log.mock.calls[0]?.[0])) as { events: unknown[] };
  expect(page.events).toHaveLength(20);
  expect(await cli('history', session.id, '--all')).toMatchObject({ hasMore: false, nextBefore: null });
  expect((await cli('history', session.id, '--all') as { events: unknown[] }).events).toHaveLength(85);
});

it('shares inbox, receipts, direct settings and notification preferences through CLI, TUI and SDK', async () => {
  const { local, cli } = await setup();
  const session = await local.request<Session>('session.create', { title: 'Inbox parity', cwd: process.cwd(), runtimeId: 'demo' });
  const requestId = crypto.randomUUID(); await local.request('session.message', { sessionId: session.id, text: 'approval' }, requestId);
  expect(await cli('result', requestId)).toMatchObject({ state: 'completed', response: { ok: true } });
  expect(await cli('inbox')).toMatchObject({ items: [{ approval: { status: 'pending', sessionId: session.id } }] });
  await cli('notifications', 'off'); expect((await local.notificationStatus()).enabled).toBe(false);
  await notificationsMenu(local, scripted(['1']).io); expect(await cli('notifications', 'status')).toMatchObject({ enabled: true });
  await directMenu(local, scripted(['2']).io); expect(await cli('remote', 'direct', 'status')).toMatchObject({ enabled: false, state: 'off' });
});
