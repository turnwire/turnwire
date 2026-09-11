// Explicit developer-only daemon deployment. Never changes or stops DSH.
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, lstatSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fingerprints, health } from './host-reload.mjs';

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
  const legacy = env.TURNWIRE_HOME || (existsSync(join(home, '.turnwire')) ? join(home, '.turnwire') : undefined);
  const xdg = (name, fallback) => env[name] && isAbsolute(env[name]) ? env[name] : join(home, fallback);
  const state = legacy || join(xdg('XDG_STATE_HOME', '.local/state'), 'turnwire');
  const config = env.TURNWIRE_CONFIG_HOME || legacy || join(xdg('XDG_CONFIG_HOME', '.config'), 'turnwire');
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
    async health() { await health(new URL('/health', client().url)); },
  };
}
export async function stageDaemon(root, stage) {
  // Bundle workspace code into ONE replacement artifact; leave installed external dependencies alone.
  const workspace = ['protocol', 'runtime', 'core', 'runtime-dsh', 'sdk', 'wire'];
  await build({ absWorkingDir: root, entryPoints: ['apps/daemon/src/main.ts'], outfile: join(stage, 'main.js'), bundle: true, packages: 'external', alias: Object.fromEntries(workspace.map(name => [`@turnwire/${name}`, join(root, `packages/${name}/src/index.ts`)])), platform: 'node', format: 'esm', target: 'node22', sourcemap: false });
}
function atomic(path, bytes) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' }); renameSync(tmp, path); } finally { rmSync(tmp, { force: true }); }
}
export async function deployDaemon(root, { control = deploymentControl(), build = stage => stageDaemon(root, stage), timeoutMs = 120_000, pollMs = 500, dryRun = false, log = console.log } = {}) {
  root = resolve(root);
  const state = join(root, '.turnwire'); mkdirSync(state, { recursive: true, mode: 0o700 });
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
    initial = control.record(); await control.health();
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
    old = readFileSync(target); atomic(join(stage, 'rollback.js'), old); save('installing');
    atomic(target, readFileSync(join(stage, 'main.js'))); installed = true; save('installed');
    control.signal(initial);
    await waitFor(async () => {
      let next; try { next = control.record(); } catch { return false; }
      if (next.supervisorPid !== initial.supervisorPid || next.dshPid !== initial.dshPid) throw Error('runtime identity changed; refusing gate release');
      if (next.generation <= initial.generation || next.daemonPid === initial.daemonPid) return false;
      try { await control.health(); return owned(await control.request()); } catch { return false; }
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
