// Explicit developer-only daemon deployment. Never changes or stops DSH.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, lstatSync, existsSync, symlinkSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fingerprints, health, reloadState } from './host-reload.mjs';
import { buildDaemonArtifact } from './build-identity.mjs';
import { requireBuiltIdentity, requireSameBuild, requireContract } from '../packages/protocol/src/release-identity.mjs';

const delay = ms => new Promise(done => setTimeout(done, ms));
function local(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw Error('deployment requires credential-free loopback HTTP URL');
  return url;
}
function privateJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw Error('deployment record must be private and owned by current user');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function deploymentControl(env = process.env) {
  const home = env.HOME || homedir();
  if (env.TURNWIRE_HOME !== undefined) throw Error('TURNWIRE_HOME has been removed; use TURNWIRE_STATE_HOME and TURNWIRE_CONFIG_HOME.');
  const xdg = (name, fallback) => env[name] && isAbsolute(env[name]) ? env[name] : join(home, fallback);
  const state = env.TURNWIRE_STATE_HOME || join(xdg('XDG_STATE_HOME', '.local/state'), 'turnwire');
  const config = env.TURNWIRE_CONFIG_HOME || join(xdg('XDG_CONFIG_HOME', '.config'), 'turnwire');
  const recordPath = join(state, 'run/host-readiness.json');
  const client = () => { const value = privateJson(join(config, 'client.json')); local(value.url); if (typeof value.token !== 'string' || !value.token) throw Error('missing local daemon credential'); return value; };
  const request = async (body) => {
    const { url, token } = client();
    const response = await fetch(new URL('/maintenance', url), { method: body ? 'PUT' : 'GET', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw Error('maintenance request failed; gate remains closed');
    return response.json();
  };
  return {
    record() {
      const value = privateJson(recordPath);
      if (value.version !== 1 || value.ready !== true || !Number.isSafeInteger(value.supervisorPid) || value.supervisorPid <= 1 || !Number.isSafeInteger(value.dshPid) || value.dshPid <= 1 || !Number.isSafeInteger(value.daemonPid) || value.daemonPid <= 1 || !Number.isSafeInteger(value.generation) || !Number.isFinite(value.checkedAt) || Date.now() - value.checkedAt > 10_000 || value.checkedAt > Date.now() + 1000) throw Error('supervisor readiness stale or unknown');
      local(value.dshUrl); process.kill(value.supervisorPid, 0); process.kill(value.dshPid, 0); process.kill(value.daemonPid, 0); return value;
    },
    request,
    signal(record) { process.kill(record.supervisorPid, 'SIGUSR2'); },
    async health() { return health(new URL('/health', client().url)); },
  };
}
export async function stageDaemon(root, stage) {
  // Bundle workspace code into ONE replacement artifact; leave installed external dependencies alone.
  const { identity, code } = await buildDaemonArtifact(root);
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, 'main.js'), code);
  writeFileSync(join(stage, 'turnwire-build.json'), JSON.stringify(identity) + '\n');
  return identity;
}
export async function preflightDaemon(root, stage, env = process.env) {
  // Staging lives in private host state, not below the workspace's node_modules.
  // Match installed dependency resolution without rebuilding or copying dependencies.
  const modules = join(stage, 'node_modules');
  if (!existsSync(modules)) symlinkSync(join(root, 'node_modules'), modules, 'dir');
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [join(stage, 'main.js'), '--build-identity'], { cwd: root, env, timeout: 30_000, maxBuffer: 64 * 1024 });
    const identity = requireBuiltIdentity(JSON.parse(stdout));
    requireSameBuild(identity, JSON.parse(readFileSync(join(stage, 'turnwire-build.json'), 'utf8')));
    await promisify(execFile)(process.execPath, [join(stage, 'main.js'), '--check-storage'], { cwd: root, env, timeout: 30_000, maxBuffer: 64 * 1024 });
    return identity;
  } catch {
    // Never propagate child output: startup/import errors can contain host data.
    throw Error('staged daemon storage preflight failed; no installation or signal was performed');
  }
}
function verifyServedFrontend(root, identity) {
  const dist = join(root, 'apps/remote-web/dist');
  if (!existsSync(join(dist, 'index.html'))) return; // API-only host: no frontend is served.
  if (!existsSync(join(dist, 'turnwire-build.json'))) throw Error('served frontend has no required contract; use an offline full release');
  requireContract(identity, JSON.parse(readFileSync(join(dist, 'turnwire-build.json'), 'utf8')).requiredContract);
}
function atomic(path, bytes) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' }); renameSync(tmp, path); } finally { rmSync(tmp, { force: true }); }
}
export async function deployDaemon(root, { stateDir = reloadState(root), control = deploymentControl(), build = stage => stageDaemon(root, stage), preflight = stage => preflightDaemon(root, stage), timeoutMs = 120_000, pollMs = 500, dryRun = false, log = console.log } = {}) {
  root = resolve(root);
  const state = stateDir; mkdirSync(state, { recursive: true, mode: 0o700 });
  const journal = join(state, 'reload.daemon.pending.json');
  if (existsSync(journal)) throw Error('unfinished daemon deployment; inspect private pending journal and recover maintenance manually');
  const current = fingerprints(root);
  const stage = join(state, `daemon-stage-${randomUUID()}`); mkdirSync(stage, { mode: 0o700 });
  const target = join(root, 'apps/daemon/dist/main.js');
  let installed = false; let releasing = false; let old; let lease; let initial;
  const save = phase => atomic(journal, JSON.stringify({ phase, token: lease, initial, stage, target, fingerprints: current }) + '\n');
  const waitFor = async check => {
    const end = Date.now() + timeoutMs;
    do { if (await check()) return; await delay(pollMs); } while (Date.now() < end);
    throw Error('deployment readiness timed out; maintenance remains closed');
  };
  const owned = status => {
    if (!lease || status.token !== lease || status.scope !== 'turnwire-managed' || !['draining', 'ready'].includes(status.state)) throw Error('maintenance ownership or scope changed');
    return status.state === 'ready' && status.inFlight === 0 && status.busy === 0;
  };
  try {
    await build(stage);
    if (JSON.stringify(fingerprints(root)) !== JSON.stringify(current)) throw Error('source changed during staged build');
    if (dryRun) { rmSync(stage, { recursive: true, force: true }); log('daemon staging verified (dry run); no maintenance, signals, installation or DSH changes'); return; }
    const expectedIdentity = requireBuiltIdentity(await preflight(stage));
    verifyServedFrontend(root, expectedIdentity);
    initial = control.record(); requireBuiltIdentity((await control.health())?.identity);
    const before = await control.request();
    if (before.state !== 'accepting') throw Error('existing maintenance requires manual operator action');
    // Journal precedes acquisition: lost begin response must never lead to implicit cancellation.
    save('acquiring');
    const begun = await control.request({ action: 'begin' }); lease = begun.token;
    if (typeof lease !== 'string' || !lease) throw Error('maintenance did not provide lease');
    save('draining');
    await waitFor(async () => owned(await control.request()));
    const record = control.record();
    if (record.supervisorPid !== initial.supervisorPid || record.dshPid !== initial.dshPid || record.generation !== initial.generation) throw Error('host changed during drain');
    if (JSON.stringify(fingerprints(root)) !== JSON.stringify(current)) throw Error('source changed while draining');
    // Revalidate the drained database with the new format before replacing/stopping anything.
    requireSameBuild(await preflight(stage), expectedIdentity);
    verifyServedFrontend(root, expectedIdentity);
    old = readFileSync(target); atomic(join(stage, 'rollback.js'), old); save('installing');
    atomic(target, readFileSync(join(stage, 'main.js'))); installed = true; save('installed');
    control.signal(initial);
    await waitFor(async () => {
      let next; try { next = control.record(); } catch { return false; }
      if (next.supervisorPid !== initial.supervisorPid || next.dshPid !== initial.dshPid) throw Error('runtime identity changed; refusing gate release');
      if (next.generation <= initial.generation || next.daemonPid === initial.daemonPid) return false;
      try { requireSameBuild((await control.health())?.identity, expectedIdentity); return owned(await control.request()); } catch { return false; }
    });
    save('verified');
    releasing = true;
    await control.request({ action: 'cancel', token: lease });
    const accepting = await control.request(); if (accepting.state !== 'accepting') throw Error('maintenance release unconfirmed');
    atomic(join(state, 'reload.daemon.json'), JSON.stringify({ ...current, verifiedAt: new Date().toISOString() }) + '\n');
    rmSync(journal); rmSync(stage, { recursive: true, force: true });
    log('daemon deployed and verified; DSH was not restarted');
  } catch (error) {
    if (installed && old && !releasing) {
      // If admission/ownership is unknown, leave bytes and process alone for manual recovery.
      // In particular, never roll back a host whose operator independently released the lease.
      let held = false;
      try { const status = await control.request(); held = status.token === lease && status.scope === 'turnwire-managed' && ['draining', 'ready'].includes(status.state); } catch { /* unknown */ }
      if (held) {
        atomic(target, old); save('rolled-back-manual-recovery');
        try { const now = control.record(); if (now.supervisorPid === initial.supervisorPid && now.dshPid === initial.dshPid) control.signal(now); } catch { /* manual recovery */ }
      } else save('installed-manual-recovery');
    }
    if (!existsSync(journal)) rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
