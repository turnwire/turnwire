import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('supervises DSH and daemon with isolated credentials, startup tokens and clean shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnwire-host-service-'));
  await mkdir(join(root, 'config'));
  const key = 'fixture-model-secret'; const token = 'fixture-launch-secret';
  // A second provider route names its own credential here, and Turnwire's own secrets are present
  // too: the file is the whole DSH environment, so only the first kind may reach DSH.
  const gateway = 'fixture-gateway-secret';
  await writeFile(join(root, 'config/dsh.env.json'), JSON.stringify({
    TURNWIRE_HARNESS_DEEPSEEK_API_KEY: key,
    TURNWIRE_HARNESS_GATEWAY_KEY: gateway,
    TURNWIRE_RELAY_TOKEN: 'file-relay-secret',
    TURNWIRE_DSH_TOKEN: 'file-launch-secret',
    TURNWIRE_NOT_A_STRING: { nested: true },
  }), { mode: 0o600 });
  await writeFile(join(root, 'dsh.mjs'), `import {writeFileSync} from 'node:fs';
writeFileSync('dsh.json',JSON.stringify({hasKey:process.env.TURNWIRE_HARNESS_DEEPSEEK_API_KEY==='${key}',hasGatewayKey:process.env.TURNWIRE_HARNESS_GATEWAY_KEY==='${gateway}',hasRelayToken:!!process.env.TURNWIRE_RELAY_TOKEN,hasFileRelayToken:process.env.TURNWIRE_RELAY_TOKEN==='file-relay-secret',hasDshToken:!!process.env.TURNWIRE_DSH_TOKEN,hasObject:!!process.env.TURNWIRE_NOT_A_STRING}));
console.log('dsh web: http://127.0.0.1:3080/?token=${token}');
console.log('credential diagnostic ${key}');
console.log('gateway diagnostic ${gateway}');
process.on('SIGTERM',()=>{writeFileSync('dsh-stopped','yes');process.exit(0)});setInterval(()=>{},1000);`);
  await writeFile(join(root, 'daemon.mjs'), `import {writeFileSync} from 'node:fs';
writeFileSync('daemon.json',JSON.stringify({hasKey:!!process.env.TURNWIRE_HARNESS_DEEPSEEK_API_KEY,hasGatewayKey:!!process.env.TURNWIRE_HARNESS_GATEWAY_KEY,url:process.env.TURNWIRE_DSH_URL,runtime:process.env.TURNWIRE_RUNTIME}));
process.on('SIGTERM',()=>{writeFileSync('daemon-stopped','yes');process.exit(0)});setInterval(()=>{},1000);`);
  // Pin every location and port the supervisor reads: an exported development environment must
  // not point the fixture at the developer's state, DSH home, env file or DSH port.
  const environment = { ...process.env, TURNWIRE_HARNESS_DEEPSEEK_API_KEY: '', TURNWIRE_RELAY_TOKEN: 'fixture-relay', TURNWIRE_INSTALL_DIR: root, TURNWIRE_HOME: join(root, 'state'), TURNWIRE_DSH_HOME: join(root, 'dsh-state'), TURNWIRE_DSH_ENV_FILE: join(root, 'config/dsh.env.json'), TURNWIRE_DSH_PORT: '3080', TURNWIRE_DSH_ENTRY: join(root, 'dsh.mjs'), TURNWIRE_DAEMON_ENTRY: join(root, 'daemon.mjs') };
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('apps/daemon/src/host-service.ts')], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', chunk => { logs += String(chunk); }); child.stderr.on('data', chunk => { logs += String(chunk); });
  const stopped = new Promise(resolve => child.once('exit', resolve));
  try {
    await expect.poll(async () => JSON.parse(await readFile(join(root, 'daemon.json'), 'utf8'))).toEqual({ hasKey: false, hasGatewayKey: false, url: `http://127.0.0.1:3080/?token=${token}`, runtime: 'dsh' });
    // DSH gets the whole file — both credentials, and nothing of Turnwire's own.
    expect(JSON.parse(await readFile(join(root, 'dsh.json'), 'utf8'))).toEqual({ hasKey: true, hasGatewayKey: true, hasRelayToken: false, hasFileRelayToken: false, hasDshToken: false, hasObject: false });
    child.kill('SIGTERM'); expect(await stopped).toBe(0);
    expect(await readFile(join(root, 'daemon-stopped'), 'utf8')).toBe('yes'); expect(await readFile(join(root, 'dsh-stopped'), 'utf8')).toBe('yes');
    expect(logs).not.toContain(key); expect(logs).not.toContain(token); expect(logs).not.toContain(gateway);
  } finally { child.kill('SIGTERM'); await stopped; await rm(root, { recursive: true, force: true }); }
});

it('fails promptly when DSH exits before readiness, without starting the daemon', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnwire-host-failure-')); await writeFile(join(root, 'dsh.mjs'), 'process.exit(2)');
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('apps/daemon/src/host-service.ts')], { env: { ...process.env, TURNWIRE_HARNESS_DEEPSEEK_API_KEY: 'fixture', TURNWIRE_INSTALL_DIR: root, TURNWIRE_HOME: join(root, 'state'), TURNWIRE_DSH_HOME: join(root, 'dsh-state'), TURNWIRE_DSH_ENTRY: join(root, 'dsh.mjs'), TURNWIRE_DAEMON_ENTRY: join(root, 'does-not-exist.mjs') }, stdio: 'ignore' });
  try { expect(await new Promise(resolve => child.once('exit', resolve))).toBe(1); }
  finally { child.kill('SIGTERM'); await rm(root, { recursive: true, force: true }); }
});
