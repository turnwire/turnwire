#!/usr/bin/env node
/** Optional headless host supervisor. TUI remains a client of the same daemon. */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { writeFileSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Pinned 0.1.5-rc.2 launch-cookie + read-only session/list contract; never trusts HTML. */
export async function probeDsh(launch: string, timeoutMs = 5000) {
  const signal = AbortSignal.timeout(timeoutMs);
  const login = await fetch(launch, { redirect: 'manual', signal });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  await login.body?.cancel();
  if (login.status !== 303 || !cookie) throw new Error('DSH authentication not ready');
  const rpcId = randomUUID();
  const response = await fetch(new URL('/api/session/list', launch), { method: 'POST', redirect: 'error', signal,
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: { args: { _request: {} } } }) });
  const value = await response.json();
  if (!response.ok || value?.type !== 'server-response' || value.rpcId !== rpcId || value.result?.ok !== true || !Array.isArray(value.result.value?.items)) throw new Error('DSH session endpoint not ready');
}
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveManagedHostPaths } from '../../../packages/sdk/src/node-paths.js';

/** Neither ambient provider credentials nor Node injection options cross this boundary. */
const SYSTEM_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SYSTEMROOT', 'WINDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TERM', 'COLORTERM'];
const DAEMON_ENV = ['TURNWIRE_PORT', 'TURNWIRE_ALLOWED_ORIGINS', 'TURNWIRE_RELAY_URL', 'TURNWIRE_REMOTE_URL', 'TURNWIRE_CLOUDFLARED_PATH', 'TURNWIRE_CPOLAR_PATH', 'TURNWIRE_SSH_PATH'];
const TURNWIRE_SECRETS = ['TURNWIRE_RELAY_TOKEN', 'TURNWIRE_DSH_TOKEN', 'TURNWIRE_DSH_URL'];
function pick(names: string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
}
function integer(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export async function runManagedHost() {
  const root = resolve(process.env.TURNWIRE_INSTALL_DIR ?? fileURLToPath(new URL('../../../', import.meta.url)));
  const paths = resolveManagedHostPaths();
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  await mkdir(paths.dshHome, { recursive: true, mode: 0o700 });
  // Custom provider credential names are supported only through this private DSH environment
  // file, never by copying the supervisor's ambient environment to either child.
  let values: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.dshEnvFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid environment');
    values = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read the private DSH environment file');
  }
  const forwarded: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(values)) if (typeof value === 'string' && !TURNWIRE_SECRETS.includes(name)) forwarded[name] = value;
  const key = process.env.TURNWIRE_HARNESS_DEEPSEEK_API_KEY || forwarded.TURNWIRE_HARNESS_DEEPSEEK_API_KEY;
  if (!key) throw new Error('Configure TURNWIRE_HARNESS_DEEPSEEK_API_KEY in the DSH environment file');
  const system = pick(SYSTEM_ENV);
  const base = { ...system, ...pick(DAEMON_ENV), TURNWIRE_STATE_HOME: paths.state, TURNWIRE_CONFIG_HOME: paths.config, TURNWIRE_DATA_HOME: paths.data, TURNWIRE_CACHE_HOME: paths.cache };
  const secrets = [...new Set([key, ...Object.values(forwarded), ...TURNWIRE_SECRETS.map(name => process.env[name])])].filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);
  const clean = (text: string) => secrets.reduce((redacted, secret) => redacted.replaceAll(secret, '[redacted]'), text).replace(/([?&]token=)[^\s)&]+/gi, '$1[redacted]');
  const daemonEntry = resolve(process.env.TURNWIRE_DAEMON_ENTRY ?? join(root, 'apps/daemon/dist/main.js'));
  const port = String(integer('TURNWIRE_DSH_PORT', 3080, 1, 65535));
  const timeoutMs = integer('TURNWIRE_HOST_START_TIMEOUT_MS', 120_000, 1, 3_600_000);
  const restartBase = integer('TURNWIRE_HOST_RESTART_DELAY_MS', 500, 1, 60_000);
  const restartMax = integer('TURNWIRE_HOST_RESTART_MAX_DELAY_MS', 30_000, restartBase, 300_000);
  const restartLimit = integer('TURNWIRE_HOST_RESTART_LIMIT', 5, 0, 100);
  const stableMs = integer('TURNWIRE_HOST_STABLE_MS', 60_000, 1, 3_600_000);
  const run = join(paths.state, 'run'); await mkdir(run, { recursive: true, mode: 0o700 }); chmodSync(run, 0o700);
  const readiness = join(run, 'host-readiness.json'); rmSync(readiness, { force: true });
  let generation = 0; let checkedAt = 0; let probing = false; let ready = false;
  let heartbeat: NodeJS.Timeout | undefined;
  const record = () => {
    const tmp = `${readiness}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, supervisorPid: process.pid, dshPid: dsh.pid, daemonPid: daemon?.pid ?? null, generation, checkedAt, ready, dshUrl: `http://127.0.0.1:${port}/` }) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(tmp, readiness);
    } finally { rmSync(tmp, { force: true }); }
  };
  let stopping = false; let launchURL = ''; let daemon: ChildProcess | undefined;
  let failures = 0; let reloading = false; let pendingStart = false;
  let restart: NodeJS.Timeout | undefined; let stable: NodeJS.Timeout | undefined;
  let finish!: (code: number) => void;
  const done = new Promise<number>(ok => { finish = ok; });
  const alive = (child: ChildProcess | undefined): child is ChildProcess => !!child?.pid && child.exitCode === null && child.signalCode === null;
  async function terminateChild(child: ChildProcess | undefined) {
    if (!alive(child)) return;
    await new Promise<void>(resolveStop => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.once('exit', () => { clearTimeout(kill); resolveStop(); });
      child.kill('SIGTERM');
    });
  }
  async function stop(code: number) {
    if (stopping) return;
    stopping = true; clearTimeout(startup); clearTimeout(restart); clearTimeout(stable); clearInterval(heartbeat);
    rmSync(readiness, { force: true });
    // Full shutdown only: daemon crash/reload never enters this path while DSH is healthy.
    await terminateChild(daemon);
    await terminateChild(dsh);
    finish(code);
  }
  const logOutput = (child: ChildProcess) => {
    for (const stream of [child.stdout!, child.stderr!]) createInterface({ input: stream }).on('line', line => console.log(clean(line)));
  };
  function scheduleRestart() {
    if (stopping || reloading) return;
    if (failures >= restartLimit) {
      console.error('Turnwire restart budget exhausted; DSH remains running. Explicit SIGUSR2 reload retries the daemon.');
      return;
    }
    const delay = Math.min(restartMax, restartBase * 2 ** failures++);
    console.error(`Turnwire exited; restarting daemon in ${delay}ms (DSH remains running)`);
    restart = setTimeout(() => { restart = undefined; startDaemon(); }, delay);
  }
  function startDaemon() {
    if (stopping || !launchURL || alive(daemon)) return;
    if (!ready || Date.now() - checkedAt > 10_000) { pendingStart = true; return; }
    pendingStart = false;
    const child = spawn(process.execPath, [daemonEntry], { cwd: root, env: { ...base, TURNWIRE_RUNTIME: 'dsh', TURNWIRE_DSH_URL: launchURL }, stdio: ['ignore', 'pipe', 'pipe'] });
    daemon = child; generation++; record(); logOutput(child);
    stable = setTimeout(() => { failures = 0; }, stableMs);
    let ended = false;
    const end = () => {
      if (ended) return; ended = true; clearTimeout(stable);
      if (daemon === child) daemon = undefined;
      if (!stopping) record();
      scheduleRestart();
    };
    child.once('error', () => { console.error('Turnwire launch failed'); end(); });
    child.once('exit', end);
  }
  // Explicit operator-only daemon reload. Coalesce repeated signals, including during shutdown;
  // no automatic backend update path should invoke this before its safe handling is complete.
  const reload = () => {
    if (stopping || reloading || !launchURL) return;
    reloading = true; clearTimeout(restart); restart = undefined; clearTimeout(stable);
    void probeDsh(launchURL).then(async () => {
      if (stopping) return;
      ready = true; checkedAt = Date.now();
      await terminateChild(daemon);
      reloading = false; failures = 0;
      if (!stopping) startDaemon();
    }).catch(() => { reloading = false; ready = false; if (!stopping) record(); console.error('Daemon reload refused: DSH readiness unknown'); });
  };
  const startup = setTimeout(() => { console.error('DSH startup timed out'); void stop(1); }, timeoutMs);
  const dsh = spawn(process.execPath, [paths.dshEntry, '--patch', join(root, 'config/dsh-deepseek.patch.yml'), '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', port], { cwd: root, env: { ...system, ...forwarded, DSH_HOME: paths.dshHome, TURNWIRE_HARNESS_DEEPSEEK_API_KEY: key, DO_NOT_TRACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  dsh.once('error', () => { console.error('DSH launch failed'); void stop(1); });
  dsh.once('exit', () => { if (!stopping) { console.error('DSH exited; stopping dependent daemon for supervisor recovery'); void stop(1); } });
  // Stdout is bootstrap secret discovery only. Authenticated session API proves readiness.
  // Probe failure never kills an active DSH; it invalidates the record and blocks daemon starts.
  const check = async () => {
    if (stopping || probing || !launchURL) return;
    probing = true;
    try {
      await probeDsh(launchURL, Math.min(timeoutMs, 5000));
      if (stopping) return;
      ready = true; checkedAt = Date.now(); record(); clearTimeout(startup);
      if (!daemon && !restart && (failures === 0 || pendingStart) && !reloading) startDaemon();
    } catch {
      if (!stopping) { ready = false; record(); }
    } finally { probing = false; }
  };
  heartbeat = setInterval(() => { void check(); }, 1000);
  createInterface({ input: dsh.stdout! }).on('line', line => {
    if (!launchURL && !stopping) {
      const found = line.match(/^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9._~%+-]+)\s*$/)?.[1];
      if (found && new URL(found).port === port) {
        launchURL = found; secrets.push(new URL(found).searchParams.get('token')!);
        void check();
      }
    }
    console.log(clean(line));
  });
  createInterface({ input: dsh.stderr! }).on('line', line => console.log(clean(line)));
  const terminate = () => { void stop(0); };
  process.on('SIGTERM', terminate); process.on('SIGINT', terminate); process.on('SIGUSR2', reload);
  const code = await done;
  process.off('SIGTERM', terminate); process.off('SIGINT', terminate); process.off('SIGUSR2', reload);
  return code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runManagedHost().then(code => { process.exitCode = code; }).catch(() => { console.error('Host configuration or startup failed; inspect private host configuration'); process.exitCode = 1; });
}
