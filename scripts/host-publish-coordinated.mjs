#!/usr/bin/env node
// Explicit operator-only publication of built daemon + Web. Never stop/restart DSH.
// Usage: node scripts/host-publish-coordinated.mjs --source /built/root --target /release
//   --state /private/deployment-state --wait-ms 1800000 [--apply]
// Default is dry-run. Set TURNWIRE_{STATE,CONFIG,DATA,CACHE}_HOME explicitly for apply.
// A pending journal is a MANUAL recovery boundary; do not delete it to retry blindly.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deploymentControl, preflightDaemon } from './host-reload-daemon.mjs';
import { requireBuiltIdentity, requireSameBuild, requireContract } from '../packages/protocol/src/release-identity.mjs';

const daemon = 'apps/daemon/dist';
const web = 'apps/remote-web/dist';
const entries = [`${daemon}/main.js`, `${daemon}/turnwire-build.json`, `${web}/turnwire-build.json`, `${web}/index.html`];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function regular(path) { if (!lstatSync(path).isFile()) throw Error(`Not a regular file: ${path}`); return readFileSync(path); }
function tree(root, dir = root) {
  return readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name), stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw Error('Non-regular build tree');
    return stat.isDirectory() ? tree(root, path) : [relative(root, path)];
  });
}
function collect(root) {
  const files = [...entries, ...tree(join(root, web)).map(p => `${web}/${p}`)];
  return Object.fromEntries([...new Set(files)].sort().map(p => [p, regular(join(root, p))]));
}
function hashes(files) { return Object.fromEntries(Object.entries(files).map(([p, bytes]) => [p, digest(bytes)])); }
function verifyFiles(root, files) { for (const [p, bytes] of Object.entries(files)) if (!regular(join(root, p)).equals(bytes)) throw Error(`Artifact changed: ${p}`); }
function atomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' }); renameSync(tmp, path); }
  finally { rmSync(tmp, { force: true }); }
}
function identity(files) {
  const value = requireBuiltIdentity(JSON.parse(files[`${daemon}/turnwire-build.json`]));
  requireContract(value, JSON.parse(files[`${web}/turnwire-build.json`]).requiredContract);
  return value;
}
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = lstatSync(path);
  if (!s.isDirectory() || s.mode & 0o077 || (process.getuid && s.uid !== process.getuid())) throw Error('Deployment state must be private and owned');
}
function held(status, token) {
  if (!token || status.token !== token || status.scope !== 'turnwire-managed' || !['draining', 'ready'].includes(status.state)) throw Error('Maintenance ownership changed');
  return status.state === 'ready' && status.busy === 0 && status.inFlight === 0;
}
const idle = s => s.state === 'accepting' && s.scope === 'turnwire-managed' && s.busy === 0 && s.inFlight === 0;

// Capture process birth identities, not just reusable PIDs. Linux-only live deployment.
function processIdentity(record, target) {
  const birth = pid => {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  };
  const cmd = pid => readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  if (!cmd(record.supervisorPid).includes(join(target, 'apps/daemon/dist/host-service.mjs')) || !cmd(record.daemonPid).includes(join(target, daemon, 'main.js'))) throw Error('Explicit target does not match active managed host');
  return { supervisor: birth(record.supervisorPid), dsh: birth(record.dshPid) };
}
export function coordinatedControl(env, target) {
  for (const key of ['TURNWIRE_STATE_HOME', 'TURNWIRE_CONFIG_HOME', 'TURNWIRE_DATA_HOME', 'TURNWIRE_CACHE_HOME']) if (!isAbsolute(env[key] ?? '')) throw Error(`Explicit absolute ${key} required`);
  const c = deploymentControl(env);
  const clientPath = join(env.TURNWIRE_CONFIG_HOME, 'client.json');
  const api = async (path, body) => {
    const stat = lstatSync(clientPath);
    if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw Error('Client credential file is not private');
    const { url, token } = JSON.parse(readFileSync(clientPath, 'utf8'));
    const base = new URL(url);
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash) throw Error('Local control URL required');
    const response = await fetch(new URL(path, base), { method: body ? 'PUT' : 'GET', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw Error('Local publication verification request failed');
    return response;
  };
  return { ...c, pin: record => processIdentity(record, target),
    remote: async body => (await api('/remote', body)).json(),
    async frontend(expected) {
      for (const path of [`${web}/turnwire-build.json`, `${web}/index.html`]) {
        const bytes = Buffer.from(await (await api('/' + path.slice(web.length + 1))).arrayBuffer());
        if (!bytes.equals(expected[path])) throw Error('Served frontend differs from published artifacts');
      }
    },
  };
}

export async function publishCoordinated({ source, target, state, apply = false, waitMs = 1800000, pollMs = 1000, env = process.env, control, preflight, sleep = ms => new Promise(r => setTimeout(r, ms)), log = console.log }) {
  if (![source, target, state].every(p => typeof p === 'string' && isAbsolute(p))) throw Error('Explicit absolute source, target and state required');
  source = resolve(source); target = resolve(target); state = resolve(state);
  if (source === target || source.startsWith(target + '/') || target.startsWith(source + '/')) throw Error('Source and target must be disjoint');
  if (!Number.isSafeInteger(waitMs) || waitMs <= 0 || !Number.isSafeInteger(pollMs) || pollMs <= 0) throw Error('Invalid wait budget');
  privateDirectory(state);
  const journal = join(state, 'coordinated.pending.json'), lock = join(state, 'coordinated.lock');
  if (existsSync(journal)) throw Error('Pending publication requires manual recovery');
  mkdirSync(lock, { mode: 0o700 }); // exclusive operator lock; crash leaves it for manual inspection
  const stage = join(state, `coordinated-${randomUUID()}`);
  let lease, initial, pin, installing = false, releasing = false, phase = 'preparing';
  let oldFiles, newFiles, oldIdentity, newIdentity, remote;
  const save = value => { phase = value; atomic(journal, JSON.stringify({ phase, lease, initial, pin, source, target, stage, remote, oldIdentity, newIdentity, oldHashes: oldFiles && hashes(oldFiles), newHashes: newFiles && hashes(newFiles) }) + '\n'); };
  const wait = async fn => {
    const end = Date.now() + waitMs;
    do { if (await fn()) return; await sleep(pollMs); } while (Date.now() < end);
    throw Error('Managed idle/readiness timed out; no force stop allowed');
  };
  const sameRuntime = record => {
    if (record.supervisorPid !== initial.supervisorPid || record.dshPid !== initial.dshPid || JSON.stringify(control.pin(record)) !== JSON.stringify(pin)) throw Error('DSH/supervisor identity changed; refusing further mutation');
  };
  const check = preflight ?? (dir => preflightDaemon(target, dir, env));
  try {
    oldFiles = collect(target); newFiles = collect(source);
    oldIdentity = identity(oldFiles); newIdentity = identity(newFiles);
    // Existing non-content-addressed public assets may not silently change.
    for (const [p, bytes] of Object.entries(newFiles)) if (!entries.includes(p) && existsSync(join(target, p)) && !regular(join(target, p)).equals(bytes)) throw Error(`Asset collision: ${p}`);
    for (const [label, files] of [['old', oldFiles], ['new', newFiles]]) for (const [p, bytes] of Object.entries(files)) atomic(join(stage, label, p), bytes);
    requireSameBuild(await check(join(stage, 'old', daemon)), oldIdentity);
    requireSameBuild(await check(join(stage, 'new', daemon)), newIdentity);
    verifyFiles(source, newFiles); verifyFiles(target, oldFiles);
    if (!apply) { log('Dry-run verified old/new build contracts, immutable assets and read-only storage preflights; no lease, publication or signals'); rmSync(stage, { recursive: true, force: true }); return { dryRun: true, oldIdentity, newIdentity }; }
    control ??= coordinatedControl(env, target);
    initial = control.record(); pin = control.pin(initial);
    requireSameBuild((await control.health()).identity, oldIdentity);
    await control.frontend(oldFiles);
    // Do not acquire a lease while the operator's own managed session is running.
    log('Waiting for managed idle before acquiring maintenance; no DSH stop or cancellation will be issued');
    await wait(async () => {
      const record = control.record(); sameRuntime(record);
      if (record.generation !== initial.generation || record.daemonPid !== initial.daemonPid) throw Error('Daemon changed while waiting');
      const status = await control.request();
      if (status.state !== 'accepting') throw Error('Existing maintenance requires operator action');
      return idle(status);
    });
    remote = await control.remote();
    save('acquiring'); // lost begin reply => journal retained; never guess ownership
    lease = (await control.request({ action: 'begin' })).token;
    if (typeof lease !== 'string' || !lease) throw Error('Missing maintenance lease');
    save('draining');
    await wait(async () => held(await control.request(), lease));
    const record = control.record(); sameRuntime(record);
    if (record.generation !== initial.generation || record.daemonPid !== initial.daemonPid) throw Error('Daemon changed during drain');
    requireSameBuild((await control.health()).identity, oldIdentity);
    verifyFiles(source, newFiles); verifyFiles(target, oldFiles);
    requireSameBuild(await check(join(stage, 'new', daemon)), newIdentity);
    if (!held(await control.request(), lease)) throw Error('Drain changed before publication');
    sameRuntime(control.record());
    save('installing'); installing = true;
    // Retain old assets so old tabs can load their chunks. Contract checks still fail closed.
    for (const [p, bytes] of Object.entries(newFiles)) if (!entries.includes(p) && !existsSync(join(target, p))) atomic(join(target, p), bytes);
    // Gate remains closed through the brief multi-file transition and daemon replacement.
    for (const p of entries) atomic(join(target, p), newFiles[p]);
    save('installed'); control.signal(initial);
    await wait(async () => {
      let next; try { next = control.record(); } catch { return false; }
      sameRuntime(next);
      if (next.generation <= initial.generation || next.daemonPid === initial.daemonPid) return false;
      try { requireSameBuild((await control.health()).identity, newIdentity); return held(await control.request(), lease); } catch { return false; }
    });
    verifyFiles(target, newFiles); await control.frontend(newFiles);
    sameRuntime(control.record());
    if (!held(await control.request(), lease)) throw Error('Drain no longer ready');
    save('verified'); releasing = true; save('releasing');
    await control.request({ action: 'cancel', token: lease });
    if ((await control.request()).state !== 'accepting') throw Error('Lease release unconfirmed');
    save('restoring-remote');
    const request = remote.mode === 'relay' ? { mode: 'relay', serverUrl: remote.relayServerUrl } : remote.mode === 'temporary' ? { mode: 'temporary', provider: remote.provider } : { mode: 'off' };
    await control.remote(request); // persisted credentials/options remain host-owned
    await wait(async () => {
      sameRuntime(control.record());
      const current = await control.remote();
      if (current.mode !== remote.mode) throw Error('Remote mode changed');
      return remote.mode === 'off' ? current.state === 'off' : current.health?.relayRegistration === 'ready' && (remote.mode !== 'temporary' || current.health?.tunnelProcess === 'ready');
    });
    save('complete'); renameSync(journal, join(stage, 'completed.json'));
    log(`Coordinated daemon/Web publication verified; DSH unchanged. Backup retained at ${stage}. Existing pages must refresh; public/device reachability is not inferred.`);
    return { oldIdentity, newIdentity, stage };
  } catch (error) {
    if (installing && !releasing) {
      try {
        const status = await control.request();
        if (!held(status, lease)) throw Error('Rollback requires owned idle maintenance');
        const now = control.record(); sameRuntime(now);
        // Never overwrite unrelated operator edits during rollback.
        for (const p of entries) { const bytes = regular(join(target, p)); if (!bytes.equals(oldFiles[p]) && !bytes.equals(newFiles[p])) throw Error('Artifact ownership lost'); }
        for (const p of entries) atomic(join(target, p), oldFiles[p]);
        save('rollback-installed'); control.signal(now);
        await wait(async () => {
          let next; try { next = control.record(); } catch { return false; }
          sameRuntime(next);
          if (next.generation <= now.generation || next.daemonPid === now.daemonPid) return false;
          try { requireSameBuild((await control.health()).identity, oldIdentity); return held(await control.request(), lease); } catch { return false; }
        });
        verifyFiles(target, oldFiles); await control.frontend(oldFiles); save('rollback-verified-maintenance-held');
      } catch { save('manual-recovery-required'); }
    }
    if (!existsSync(journal)) rmSync(stage, { recursive: true, force: true });
    throw Error(`${error.message}; phase=${phase}; any pending maintenance is retained for operator recovery`);
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    while (args.length) {
      const key = args.shift();
      if (key === '--apply') { options.apply = true; continue; }
      const name = { '--source': 'source', '--target': 'target', '--state': 'state', '--wait-ms': 'waitMs' }[key];
      if (!name || !args.length) throw Error('Usage: --source ABS --target ABS --state PRIVATE_ABS [--wait-ms N] [--apply]');
      options[name] = name === 'waitMs' ? Number(args.shift()) : args.shift();
    }
    await publishCoordinated(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
