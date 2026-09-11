#!/usr/bin/env node
/** Optional headless host supervisor. TUI remains a client of the same daemon. */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
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
  const paths = resolveManagedHostPaths(root);
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
  const base = { ...system, ...pick(DAEMON_ENV), TURNWIRE_HOME: paths.state, TURNWIRE_CONFIG_HOME: paths.config, TURNWIRE_DATA_HOME: paths.data, TURNWIRE_CACHE_HOME: paths.cache };
  const secrets = [...new Set([key, ...Object.values(forwarded), ...TURNWIRE_SECRETS.map(name => process.env[name])])].filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);
  const clean = (text: string) => secrets.reduce((redacted, secret) => redacted.replaceAll(secret, '[redacted]'), text).replace(/([?&]token=)[^\s)&]+/gi, '$1[redacted]');
  const daemonEntry = resolve(process.env.TURNWIRE_DAEMON_ENTRY ?? join(root, 'apps/daemon/dist/main.js'));
  const port = String(integer('TURNWIRE_DSH_PORT', 3080, 1, 65535));
  const timeoutMs = integer('TURNWIRE_HOST_START_TIMEOUT_MS', 120_000, 1, 3_600_000);
  const restartBase = integer('TURNWIRE_HOST_RESTART_DELAY_MS', 500, 1, 60_000);
  const restartMax = integer('TURNWIRE_HOST_RESTART_MAX_DELAY_MS', 30_000, restartBase, 300_000);
  const restartLimit = integer('TURNWIRE_HOST_RESTART_LIMIT', 5, 0, 100);
  const stableMs = integer('TURNWIRE_HOST_STABLE_MS', 60_000, 1, 3_600_000);
  let stopping = false; let launchURL = ''; let daemon: ChildProcess | undefined;
  let failures = 0; let reloading = false;
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
    stopping = true; clearTimeout(startup); clearTimeout(restart); clearTimeout(stable);
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
    const child = spawn(process.execPath, [daemonEntry], { cwd: root, env: { ...base, TURNWIRE_RUNTIME: 'dsh', TURNWIRE_DSH_URL: launchURL }, stdio: ['ignore', 'pipe', 'pipe'] });
    daemon = child; logOutput(child);
    stable = setTimeout(() => { failures = 0; }, stableMs);
    let ended = false;
    const end = () => {
      if (ended) return; ended = true; clearTimeout(stable);
      if (daemon === child) daemon = undefined;
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
    void terminateChild(daemon).then(() => {
      reloading = false; failures = 0;
      if (!stopping) startDaemon();
    });
  };
  const startup = setTimeout(() => { console.error('DSH startup timed out'); void stop(1); }, timeoutMs);
  const dsh = spawn(process.execPath, [paths.dshEntry, '--patch', join(root, 'config/dsh-deepseek.patch.yml'), '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', port], { cwd: root, env: { ...system, ...forwarded, DSH_HOME: paths.dshHome, TURNWIRE_HARNESS_DEEPSEEK_API_KEY: key, DO_NOT_TRACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  dsh.once('error', () => { console.error('DSH launch failed'); void stop(1); });
  dsh.once('exit', () => { if (!stopping) { console.error('DSH exited; stopping dependent daemon for supervisor recovery'); void stop(1); } });
  // Pinned DSH exposes readiness only through its launch line, not a private endpoint-file API.
  // Limitation: this is coupled to that stdout format (stderr is never trusted as readiness).
  // Capture only the exact loopback endpoint on the requested port. The bearer URL stays in a
  // private pipe and daemon environment, never argv or logs; redact even malformed launch lines.
  createInterface({ input: dsh.stdout! }).on('line', line => {
    if (!launchURL && !stopping) {
      const found = line.match(/^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9._~%+-]+)\s*$/)?.[1];
      if (found && new URL(found).port === port) {
        launchURL = found; secrets.push(new URL(found).searchParams.get('token')!);
        clearTimeout(startup); startDaemon();
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
