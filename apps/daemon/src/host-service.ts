#!/usr/bin/env node
/** Optional headless host supervisor. TUI remains a client of the same daemon. */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveManagedHostPaths } from '../../../packages/sdk/src/node-paths.js';

/** Turnwire's own secrets: neither child may inherit these, whatever a configuration file says. */
const TURNWIRE_SECRETS = ['TURNWIRE_RELAY_TOKEN', 'TURNWIRE_DSH_TOKEN', 'TURNWIRE_DSH_URL'];

export async function runManagedHost() {
  const root = resolve(process.env.TURNWIRE_INSTALL_DIR ?? fileURLToPath(new URL('../../../', import.meta.url)));
  const paths = resolveManagedHostPaths(root);
  const directory = paths.state;
  const dshHome = paths.dshHome;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(dshHome, { recursive: true, mode: 0o700 });
  // The private file is the DSH environment, not one slot for one key: a deployment may register
  // several provider routes, each naming its own credential by environment variable. Every string
  // it holds is therefore forwarded to DSH — and only to DSH, because model credentials never
  // belong in a client or in the daemon. Turnwire's own secrets are never forwarded, whatever the
  // file says, and every forwarded value is kept out of the logs.
  const envFile = paths.dshEnvFile;
  let values: Record<string, unknown> = {};
  try { values = JSON.parse(await readFile(envFile, 'utf8')) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot read the DSH environment file ${envFile}`); }
  const forwarded: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(values)) if (typeof value === 'string' && !TURNWIRE_SECRETS.includes(name)) forwarded[name] = value;
  const key = process.env.TURNWIRE_HARNESS_DEEPSEEK_API_KEY || forwarded.TURNWIRE_HARNESS_DEEPSEEK_API_KEY;
  if (!key) throw new Error('Configure TURNWIRE_HARNESS_DEEPSEEK_API_KEY in the DSH environment file');
  const base: NodeJS.ProcessEnv = { ...process.env, TURNWIRE_HOME: directory, TURNWIRE_CONFIG_HOME: paths.config, TURNWIRE_DATA_HOME: paths.data, TURNWIRE_CACHE_HOME: paths.cache };
  // The model credentials belong to DSH alone: the daemon drives the runtime, it never holds a key.
  for (const name of [...TURNWIRE_SECRETS, 'TURNWIRE_HARNESS_DEEPSEEK_API_KEY']) delete base[name];
  // Redact the model credentials and anything else long enough to be one: a short value in that
  // file is configuration, and replacing it everywhere would mangle unrelated log text.
  const secrets = [...new Set([key, ...Object.values(forwarded)])].filter((secret): secret is string => typeof secret === 'string' && (secret === key || secret.length >= 8));
  const dshEntry = paths.dshEntry;
  const daemonEntry = resolve(process.env.TURNWIRE_DAEMON_ENTRY ?? join(root, 'apps/daemon/dist/main.js'));
  const port = process.env.TURNWIRE_DSH_PORT ?? '3080';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid TURNWIRE_DSH_PORT');
  const timeoutMs = Number(process.env.TURNWIRE_HOST_START_TIMEOUT_MS ?? 120_000);
  const children: ChildProcess[] = []; let stopping = false; let launchURL = '';
  const clean = (text: string) => secrets.reduce((redacted, secret) => redacted.replaceAll(secret, '[redacted]'), text).replace(/([?&]token=)[^\s)&]+/g, '$1[redacted]');
  let finish!: (code: number) => void;
  const done = new Promise<number>(ok => { finish = ok; });
  async function stop(code: number) {
    if (stopping) return; stopping = true; clearTimeout(startup);
    // Stop the connector first so it can persist cursors before the runtime exits.
    for (const child of [...children].reverse()) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise<void>(resolveStop => {
        const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
        child.once('exit', () => { clearTimeout(kill); resolveStop(); }); child.kill('SIGTERM');
      });
    }
    finish(code);
  }
  const startup = setTimeout(() => { console.error('DSH startup timed out'); void stop(1); }, timeoutMs);
  const launch = (entry: string, args: string[], env: NodeJS.ProcessEnv, label: string) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
    child.once('error', error => { console.error(clean(`${label}: ${error.message}`)); void stop(1); });
    child.once('exit', () => { if (!stopping) { console.error(`${label} exited; supervisor will restart the host`); void stop(1); } });
    return child;
  };
  // Process environment first, then the file: an operator's exported value wins over the stored one.
  const dsh = launch(dshEntry, ['--patch', join(root, 'config/dsh-deepseek.patch.yml'), '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', port], { ...forwarded, ...base, DSH_HOME: dshHome, TURNWIRE_HARNESS_DEEPSEEK_API_KEY: key, DO_NOT_TRACK: '1' }, 'DSH');
  for (const stream of [dsh.stdout!, dsh.stderr!]) createInterface({ input: stream }).on('line', line => {
    if (!launchURL && !stopping) {
      const found = line.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+)/)?.[1];
      if (found && new URL(found).port === port) {
        launchURL = found; clearTimeout(startup);
        const daemon = launch(daemonEntry, [], { ...base, TURNWIRE_RUNTIME: 'dsh', TURNWIRE_DSH_URL: found }, 'Turnwire');
        for (const output of [daemon.stdout!, daemon.stderr!]) createInterface({ input: output }).on('line', value => console.log(clean(value)));
      }
    }
    console.log(clean(line));
  });
  const terminate = () => { void stop(0); };
  process.once('SIGTERM', terminate); process.once('SIGINT', terminate);
  const code = await done;
  process.off('SIGTERM', terminate); process.off('SIGINT', terminate);
  return code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runManagedHost().then(code => { process.exitCode = code; }).catch(() => { console.error('Host configuration or startup failed; inspect private host configuration'); process.exitCode = 1; });
}
