import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, chmod, readFile, rm, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localhostAddress, startLocalhostTunnel } from '../apps/daemon/src/providers/localhost-run.js';
import { cpolarAddress, startCpolarTunnel } from '../apps/daemon/src/providers/cpolar.js';
import type { TunnelHandle, TunnelOptions } from '../apps/daemon/src/tunnel.js';

let cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup = []; vi.unstubAllEnvs(); });
async function fixture(source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'turnwire-provider-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'component'); await writeFile(binary, '#!' + process.execPath + '\n' + source); await chmod(binary, 0o700);
  const options: TunnelOptions = { directory, port: 12345, signal: new AbortController().signal, progress: () => {}, exited: () => {} };
  return { directory, binary, options };
}
it('recognizes actual localhost.run JSON announcements and excludes banners and failed forwards', () => {
  expect(localhostAddress('https://admin.localhost.run https://localhost.run/docs')).toBeUndefined();
  expect(localhostAddress(JSON.stringify({ event: 'authn', message: 'https://example.lhr.life' }))).toBeUndefined();
  const event = { address: '0845972b75588d.lhr.life', event: 'tcpip-forward', status: 'success', type: 'opened', tls_termination: true };
  expect(localhostAddress(JSON.stringify(event))).toBe('https://0845972b75588d.lhr.life');
  expect(localhostAddress(JSON.stringify({ ...event, status: 'error' }))).toBeUndefined();
  expect(localhostAddress(JSON.stringify({ ...event, tls_termination: false }))).toBeUndefined();
});
it('runs anonymous SSH without user credentials, handles address rotation and aborts its child', async () => {
  const { directory, binary, options } = await fixture(`const fs = require('node:fs'); fs.writeFileSync('args.json', JSON.stringify({args:process.argv.slice(2), secret:process.env.NOVE_HARNESS_DEEPSEEK_API_KEY,agent:process.env.SSH_AUTH_SOCK}));
    const emit = address => console.log(JSON.stringify({address,event:'tcpip-forward',status:'success',type:'opened',tls_termination:true})); emit('first.lhr.life'); setTimeout(()=>emit('second.lhr.life'),100); setInterval(()=>{},1000);`);
  vi.stubEnv('TURNWIRE_SSH_PATH', binary); vi.stubEnv('NOVE_HARNESS_DEEPSEEK_API_KEY', 'never-pass-this'); vi.stubEnv('SSH_AUTH_SOCK', '/private/test-agent');
  let rotated = ''; const aborter = new AbortController();
  const handle = await startLocalhostTunnel({ ...options, signal: aborter.signal, changed: value => { rotated = value; } }); cleanup.push(() => handle.close());
  expect(handle.url).toBe('https://first.lhr.life');
  await vi.waitFor(() => expect(rotated).toBe('https://second.lhr.life'), { timeout: 15_000 });
  const argv = JSON.parse(await readFile(join(directory, 'args.json'), 'utf8'));
  expect(argv.secret).toBeUndefined(); expect(argv.agent).toBeUndefined();
  expect(argv.args).toContain('StrictHostKeyChecking=accept-new'); expect(argv.args).toContain('IdentityAgent=none'); expect(argv.args).toContain('nokey@localhost.run');
  aborter.abort(); await handle.close();
});
it('keeps cpolar token in a private per-process file and removes it on close', async () => {
  const { directory, binary, options } = await fixture(`const fs=require('node:fs'); fs.writeFileSync('args.json', JSON.stringify({args:process.argv.slice(2), secret:process.env.TURNWIRE_CPOLAR_AUTH_TOKEN})); console.log('tunnel url=https://test.vip.cpolar.cn');setInterval(()=>{},1000);`);
  vi.stubEnv('TURNWIRE_CPOLAR_PATH', binary); vi.stubEnv('TURNWIRE_CPOLAR_AUTH_TOKEN', 'private-test-token');
  const handle = await startCpolarTunnel({ ...options, token: 'private-test-token' }); cleanup.push(() => handle.close());
  expect(handle.url).toBe('https://test.vip.cpolar.cn');
  const raw = await readFile(join(directory, 'args.json'), 'utf8'); expect(raw).not.toContain('private-test-token');
  const args = JSON.parse(raw).args as string[]; const config = args.find(s => s.startsWith('-config='))!.slice(8);
  expect((await stat(config)).mode & 0o777).toBe(0o600); expect(await readFile(config, 'utf8')).toContain('private-test-token');
  expect(args).toContain('-inspect-addr=127.0.0.1:0'); expect(args).toContain('-proto=https'); expect(args).toContain('-daemon=off');
  await handle.close(); await expect(stat(config)).rejects.toThrow();
});
it('rejects cpolar authentication failure with sanitized feedback and cleans up aborted starts', async () => {
  expect(cpolarAddress('visit https://dashboard.cpolar.com/auth')).toBeUndefined();
  expect(() => cpolarAddress('Failed to authenticate to switch server: user authToken auth failed. private-test-token')).toThrow('cpolar 认证');
  const { directory, binary, options } = await fixture("console.log('Failed to authenticate to switch server: user authToken auth failed. private-test-token'); setInterval(()=>{},1000);");
  vi.stubEnv('TURNWIRE_CPOLAR_PATH', binary);
  await expect(startCpolarTunnel({ ...options, token: 'private-test-token' })).rejects.toThrow('cpolar 认证');
  expect(await readdir(join(directory, 'tunnel', 'cpolar'))).toHaveLength(0);
  await writeFile(binary, '#!' + process.execPath + '\nsetInterval(()=>{},1000);');
  const aborter = new AbortController(); const task = startCpolarTunnel({ ...options, token: 'test', signal: aborter.signal });
  setTimeout(() => aborter.abort(), 100); await expect(task).rejects.toThrow();
  expect(await readdir(join(directory, 'tunnel', 'cpolar'))).toHaveLength(0);
});
