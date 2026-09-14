#!/usr/bin/env node
// Real, no-inference compatibility check. Output is deliberately metadata-only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASELINE = '0.1.5-rc.2';
export function isolatedEnvironment(home, source = process.env) {
  const allowed = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'];
  return { ...Object.fromEntries(allowed.filter(key => source[key] !== undefined).map(key => [key, source[key]])), HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'),
    npm_config_cache: join(home, 'npm-cache'), npm_config_userconfig: join(home, 'npmrc'), npm_config_globalconfig: join(home, 'global-npmrc'), DO_NOT_TRACK: '1' };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
function child(command, args, env, cwd) {
  // Each owned root has a dedicated POSIX process group for failure cleanup.
  const process = spawn(command, args, { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', ended = false;
  process.stdout.on('data', data => { output = (output + data).slice(-1024 * 1024); });
  process.stderr.on('data', () => {}); // Never forward runtime URLs, tokens or config diagnostics.
  const closed = new Promise(resolve => { process.once('error', () => { ended = true; resolve(-1); }); process.once('close', code => { ended = true; resolve(code); }); });
  return { process, closed, get output() { return output; }, get ended() { return ended; } };
}
async function command(args, env, cwd, timeout = 300000) {
  const running = child('npm', args, env, cwd);
  const timer = setTimeout(() => running.process.kill('SIGKILL'), timeout);
  try { assert.equal(await running.closed, 0, 'npm acquisition command failed (output suppressed)'); return running.output; } finally { clearTimeout(timer); }
}
async function stop(running) {
  if (running.ended) return;
  running.process.kill('SIGTERM');
  const timer = setTimeout(() => running.process.kill('SIGKILL'), 12000);
  try { await running.closed; } finally { clearTimeout(timer); }
}
async function wait(test, processes = []) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    assert(!processes.some(item => item.ended), 'Owned process exited before readiness');
    try { const result = await test(); if (result) return result; } catch {}
    await delay(200);
  }
  throw Error('Compatibility readiness timed out (private runtime output suppressed)');
}
function assertDead(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0, 'Missing owned PID');
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  throw Error('Owned process survived launcher shutdown');
}
async function rpc(config, method, params = {}) {
  const response = await fetch(new URL('/rpc', config.url), { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, id: randomUUID(), method, params }), signal: AbortSignal.timeout(10000) });
  assert(response.ok, 'Authenticated RPC HTTP failure');
  const reply = await response.json();
  assert(!reply.error, `RPC ${method} rejected (${typeof reply.error?.code === 'string' && /^[A-Za-z0-9_/-]+$/.test(reply.error.code) ? reply.error.code : 'unknown'})`);
  return reply.result;
}
async function ready(env, webPort, owned) {
  return wait(async () => {
    const config = JSON.parse(await readFile(join(env.XDG_CONFIG_HOME, 'turnwire/client.json'), 'utf8'));
    assert.equal(new URL(config.url).origin, `http://127.0.0.1:${webPort}`);
    const snapshot = await rpc(config, 'system.snapshot');
    return snapshot.runtimes?.some(runtime => runtime.id === 'dsh' && runtime.online) && config;
  }, owned);
}
async function coreChecks(config, cwd) {
  const catalog = await rpc(config, 'model.catalog', { runtimeId: 'dsh' });
  assert(Array.isArray(catalog.groups), 'Model catalog groups missing');
  for (const group of catalog.groups) { assert(typeof group.id === 'string'); assert(Array.isArray(group.models)); for (const model of group.models) assert(typeof model.id === 'string'); }
  // Creating an empty session invokes the real adapter but never sends a model message.
  const created = await rpc(config, 'session.create', { cwd, title: 'DSH compatibility smoke', runtimeId: 'dsh' });
  assert(typeof created.id === 'string' && typeof created.runtimeSessionId === 'string', 'Adapter session creation missing identity');
  const snapshot = await rpc(config, 'system.snapshot');
  assert(snapshot.sessions.some(session => session.id === created.id), 'Created adapter session absent from Core snapshot');
  return created.id;
}
export async function runCompatibility({ packageRoot, entry, home }) {
  const children = [];
  const launch = (args, env) => { const running = child(process.execPath, args, env, packageRoot); children.push(running); return running; };
  const environment = async name => { const value = join(home, name); await mkdir(value, { recursive: true }); return { ...isolatedEnvironment(value), TURNWIRE_HARNESS_DEEPSEEK_API_KEY: 'dummy-nonsecret-no-inference' }; };
  try {
    console.log('Phase: managed startup, authenticated Core/catalog/session checks');
    const managedEnv = await environment('managed'); const web = await port(), dsh = await port();
    const managed = launch([join(packageRoot, 'bin/turnwire.mjs'), '--no-open', '--port', String(web)], { ...managedEnv, TURNWIRE_DSH_ENTRY: entry, TURNWIRE_DSH_PORT: String(dsh) });
    const config = await ready(managedEnv, web, [managed]);
    const session = await coreChecks(config, managedEnv.HOME);
    const record = JSON.parse(await readFile(join(managedEnv.XDG_STATE_HOME, 'turnwire/run/host-readiness.json'), 'utf8'));
    await stop(managed); assertDead(record.daemonPid); assertDead(record.dshPid);
    // Reconnect the actual adapter to persisted DSH state: session/list must restore it.
    console.log('Phase: managed restart and adapter session resume');
    const restarted = launch([join(packageRoot, 'bin/turnwire.mjs'), '--no-open', '--port', String(web)], { ...managedEnv, TURNWIRE_DSH_ENTRY: entry, TURNWIRE_DSH_PORT: String(dsh) });
    const resumed = await ready(managedEnv, web, [restarted]);
    // session.resume verifies the runtime root via the real adapter's session/list.
    await rpc(resumed, 'session.resume', { sessionId: session });
    const snapshot = await rpc(resumed, 'system.snapshot');
    assert(snapshot.sessions.some(value => value.id === session), 'Session missing after managed restart');
    const restartRecord = JSON.parse(await readFile(join(managedEnv.XDG_STATE_HOME, 'turnwire/run/host-readiness.json'), 'utf8'));
    await stop(restarted); assertDead(restartRecord.daemonPid); assertDead(restartRecord.dshPid);
    console.log('Managed: authenticated online snapshot, runtime model catalog, empty session, restart and owned shutdown passed.');
    console.log('Phase: external startup, authenticated checks and ownership');
    const externalEnv = await environment('external'); const externalPort = await port();
    const external = launch([entry, '--patch', join(packageRoot, 'config/dsh-deepseek.patch.yml'), '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', String(externalPort)], { ...externalEnv, DSH_HOME: join(externalEnv.HOME, 'dsh') });
    const url = await wait(() => external.output.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]*token=[^\s\x1b]+/)?.[0], [external]);
    const externalWeb = await port();
    const attached = launch([join(packageRoot, 'bin/turnwire.mjs'), '--no-open', '--port', String(externalWeb)], { ...externalEnv, TURNWIRE_DSH_URL: url });
    const attachedConfig = await ready(externalEnv, externalWeb, [attached, external]);
    await coreChecks(attachedConfig, externalEnv.HOME);
    await stop(attached); assert(!external.ended, 'External DSH stopped with launcher'); process.kill(external.process.pid, 0);
    // Verify the daemon listener closed, not merely the launcher.
    let reachable = false; try { reachable = (await fetch(new URL('/health', attachedConfig.url), { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    assert(!reachable, 'External-mode daemon survived launcher shutdown');
    await stop(external);
    console.log('External: authenticated online snapshot, catalog/session and ownership-safe shutdown passed.');
  } finally {
    for (const running of children.reverse()) {
      await stop(running);
      // Kill only this smoke's dedicated group, including descendants after a crashed root.
      if (running.process.pid) try { process.kill(-running.process.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}
export async function main(args = process.argv.slice(2)) {
  const channel = args[0] ?? 'baseline';
  assert(['baseline', 'latest', 'next'].includes(channel), 'Expected baseline, latest or next');
  const packageRoot = resolve(args[1] ?? 'artifacts/npm/turnwire');
  const home = await mkdtemp(join(tmpdir(), 'turnwire-dsh-compatibility-'));
  console.log('Phase: resolve registry version');
  try {
    const env = isolatedEnvironment(home);
    const version = JSON.parse(await command(['view', `@deepseek-ai/dsh@${channel === 'baseline' ? BASELINE : channel}`, 'version', '--json', '--registry=https://registry.npmjs.org'], env, home));
    assert(typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), 'Invalid registry version');
    console.log(`DSH compatibility: channel=${channel} resolved=${version} platform=${process.platform} arch=${process.arch}`);
    console.log('Phase: install exact resolved DSH without lifecycle scripts');
    const prefix = join(home, 'runtime');
    await command(['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `@deepseek-ai/dsh@${version}`, '--registry=https://registry.npmjs.org'], env, home);
    const manifest = JSON.parse(await readFile(join(prefix, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
    assert.equal(manifest.version, version);
    await runCompatibility({ packageRoot, entry: join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), home });
  } finally { await rm(home, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('Real DSH compatibility failed. Runtime output is suppressed to protect launch credentials.'); process.exitCode = 1; });
