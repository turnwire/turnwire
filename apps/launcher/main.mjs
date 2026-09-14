#!/usr/bin/env node
/** Foreground npm entry. Runtime acquisition is explicit; no system services are installed. */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, lstat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { installedVersion, selectedEntry, resolveLatest, compareVersions, stageAndActivate } from './dsh-policy.mjs';
import { resolveManagedHostPaths } from '../../packages/sdk/src/node-paths.ts';
// Import the separately bundled helper at runtime; never inline its executable main guard.
export const DSH_VERSION = '0.1.5-rc.2';
const systemNames = ['PATH','HOME','USER','LOGNAME','SHELL','TMPDIR','TMP','TEMP','LANG','LC_ALL','LC_CTYPE','TZ','SYSTEMROOT','WINDIR','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR','TERM','COLORTERM'];
const pathNames = ['TURNWIRE_STATE_HOME','TURNWIRE_CONFIG_HOME','TURNWIRE_DATA_HOME','TURNWIRE_CACHE_HOME','TURNWIRE_DSH_HOME','TURNWIRE_DSH_ENV_FILE','TURNWIRE_DSH_ENTRY'];
export function cleanEnvironment(env = process.env) { return Object.fromEntries([...systemNames, ...pathNames, 'TURNWIRE_PORT','TURNWIRE_DSH_PORT','TURNWIRE_ALLOWED_ORIGINS'].filter(key => env[key] !== undefined).map(key => [key, env[key]])); }
export function parseLaunch(args) {
  const options = { yes: false, port: undefined, open: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--yes') options.yes = true;
    else if (args[i] === '--update-dsh') options.updateDsh = true;
    else if (args[i] === '--open') options.open = true;
    else if (args[i] === '--no-open') options.open = false;
    else if (args[i] === '--port') { const value = Number(args[++i]); if (!Number.isInteger(value) || value < 1 || value > 65535) throw Error('Port must be an integer from 1 to 65535'); options.port = String(value); }
    else throw Error(`Unknown startup option: ${args[i]}`);
  }
  return options;
}
export async function privateJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw Error('Connection/credential file must be a private regular file owned by you (0600)');
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid private configuration file');
  return value;
}
export function launchUrl(url, token) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw Error('Invalid DSH connection URL');
  if (parsed.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)) throw Error('Non-loopback DSH connections require HTTPS');
  if (token) parsed.searchParams.set('token', token);
  if (!parsed.searchParams.get('token')) throw Error('DSH connection needs an explicit token');
  return parsed.href;
}
export async function findConnection(env, paths) {
  if (env.TURNWIRE_DSH_URL) return launchUrl(env.TURNWIRE_DSH_URL, env.TURNWIRE_DSH_TOKEN);
  if (env.TURNWIRE_DSH_TOKEN) throw Error('TURNWIRE_DSH_TOKEN requires TURNWIRE_DSH_URL');
  try { const value = await privateJson(join(paths.config, 'dsh-connection.json')); return launchUrl(value.url, value.token); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return undefined; }
}
async function confirm(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await prompt.question(question + ' [y/N] ')).trim()); } finally { prompt.close(); }
}
async function hiddenKey() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('Set TURNWIRE_HARNESS_DEEPSEEK_API_KEY for noninteractive startup');
  process.stdout.write('DeepSeek API key (hidden): ');
  const input = process.stdin; const wasRaw = input.isRaw; input.setRawMode(true); input.resume();
  return new Promise((ok, fail) => {
    let key = '';
    const cleanup = () => { input.off('data', onData); input.setRawMode(!!wasRaw); input.pause(); process.stdout.write('\n'); };
    const onData = data => { for (const char of data.toString()) { if (char === '\u0003') { cleanup(); fail(Error('Cancelled')); return; } if (char === '\r' || char === '\n') { cleanup(); key.trim() ? ok(key.trim()) : fail(Error('API key is required')); return; } if (char === '\u007f' || char === '\b') key = key.slice(0,-1); else if (char >= ' ') key += char; } };
    input.on('data', onData);
  });
}
export async function ensureKey(paths, env, prompt = hiddenKey) {
  let existing;
  try { existing = await privateJson(paths.dshEnvFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const supplied = env.TURNWIRE_HARNESS_DEEPSEEK_API_KEY;
  if (supplied) return supplied;
  if (typeof existing?.TURNWIRE_HARNESS_DEEPSEEK_API_KEY === 'string' && existing.TURNWIRE_HARNESS_DEEPSEEK_API_KEY.trim()) return undefined;
  if (existing) throw Error('Existing private DSH environment has no DeepSeek key; set TURNWIRE_HARNESS_DEEPSEEK_API_KEY or edit it explicitly. It was not overwritten.');
  const key = await prompt();
  await mkdir(dirname(paths.dshEnvFile), { recursive: true, mode: 0o700 });
  await writeFile(paths.dshEnvFile, JSON.stringify({ TURNWIRE_HARNESS_DEEPSEEK_API_KEY: key }) + '\n', { mode: 0o600, flag: 'wx' });
  return undefined;
}
export async function runChild(executable, args, { env, cwd, quiet = false } = {}) {
  const child = spawn(executable, args, { env, cwd, stdio: quiet ? ['ignore','ignore','ignore'] : 'inherit' });
  const signals = ['SIGINT','SIGTERM'];
  const forward = signal => child.kill(signal);
  const handlers = signals.map(signal => { const fn = () => forward(signal); process.on(signal, fn); return [signal, fn]; });
  try { return await new Promise((ok, fail) => { child.once('error', () => fail(Error('Could not launch child process'))); child.once('close', (code, signal) => ok(code ?? (signal === 'SIGINT' ? 130 : 143))); }); }
  finally { for (const [signal, fn] of handlers) process.off(signal, fn); }
}
async function browserWhenReady(paths, port, signal, root) {
  const expected = JSON.parse(await readFile(join(root,'apps/daemon/dist/turnwire-build.json'),'utf8'));
  for (let attempt = 0; attempt < 120 && !signal.aborted; attempt++) {
    try {
      const url = `http://127.0.0.1:${port}`;
      const health = await fetch(url + '/health', { signal: AbortSignal.any([signal, AbortSignal.timeout(800)]) });
      if (!health.ok) throw Error('Not ready');
      const observed = await health.json();
      if (observed.identity?.buildId !== expected.buildId || observed.identity?.contractDigest !== expected.contractDigest) throw Error('Different running build');
      const config = await privateJson(paths.clientConfig);
      if (new URL(config.url).origin !== url || typeof config.token !== 'string') throw Error('Unexpected local config');
      if (signal.aborted) return;
      const link = `${url}/#local=${encodeURIComponent(JSON.stringify({ url, token: config.token }))}`;
      const code = await runChild(process.platform === 'darwin' ? 'open' : 'xdg-open', [link], { env: cleanEnvironment(), quiet: true });
      if (code) console.log('Could not open browser. Use the printed local URL and turnwire connect.');
      return;
    } catch { if (signal.aborted) return; }
    await new Promise(resolve => setTimeout(resolve,1000));
  }
}
export async function doctor({ env = process.env, platform = process.platform, node = process.versions.node } = {}) {
  const paths = resolveManagedHostPaths({ env });
  const entry = await selectedEntry(paths, env, privateJson);
  const version = await installedVersion(entry);
  return { platform, node, supported: ['linux','darwin'].includes(platform) && Number(node.split('.')[0]) >= 22 && (Number(node.split('.')[0]) > 22 || Number(node.split('.')[1]) >= 13), foregroundOnly: true, dshInstalled: !!version, dshVersion: version ?? null, dshBaselineVersion: DSH_VERSION, dshPolicy: 'latest-on-install-explicit-staged-update', paths: { config: paths.config, state: paths.state, data: paths.data, cache: paths.cache, dshEntry: entry }, externalDshConfigured: !!env.TURNWIRE_DSH_URL };
}
export async function main(args = process.argv.slice(2), root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  if (args[0] === '--version' || args[0] === '-V') { console.log(JSON.parse(await readFile(join(root,'package.json'),'utf8')).version); return 0; }
  if (args[0] === 'doctor') { if (args.some(arg => !['doctor','--json'].includes(arg))) throw Error('Usage: turnwire doctor [--json]'); const report = await doctor(); console.log(args.includes('--json') ? JSON.stringify(report) : JSON.stringify(report,null,2)); return report.supported ? 0 : 1; }
  if (args.includes('--help') || args.includes('-h')) {
    if (!args.length || ['--help','-h','start'].includes(args[0])) console.log('Turnwire — foreground local Web + runtime\nUsage: turnwire [start] [--yes] [--update-dsh] [--port PORT] [--open | --no-open]\n       turnwire doctor [--json]\n       turnwire --version\nNo service is installed; keep this process running. Ctrl-C stops owned processes only.\nExisting DSH: TURNWIRE_DSH_URL + TURNWIRE_DSH_TOKEN, or private config/dsh-connection.json.\nNo DSH: confirm installation of registry latest (resolved exact version).\n--update-dsh: stage and probe latest before selection; never downgrade or hot-update.\nCLI commands:');
    return runChild(process.execPath,[join(root,'apps/cli/dist/main.js'), ...(args[0] === 'start' ? ['--help'] : args)], { env: cleanEnvironment(), cwd: process.cwd() });
  }
  if (args.length && args[0] !== 'start' && !args[0].startsWith('-')) return runChild(process.execPath,[join(root,'apps/cli/dist/main.js'),...args], { env: cleanEnvironment(), cwd: process.cwd() });
  const options = parseLaunch(args[0] === 'start' ? args.slice(1) : args);
  const report = await doctor(); if (!report.supported) throw Error('Turnwire requires Linux/macOS and Node.js >=22.13');
  const paths = resolveManagedHostPaths(); const env = cleanEnvironment(); if (options.port) env.TURNWIRE_PORT = options.port;
  const port = Number(env.TURNWIRE_PORT ?? 9898); if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid TURNWIRE_PORT');
  // A launcher lock prevents competing acquisition/install/start attempts. Never steal a stale lock.
  await mkdir(paths.state,{ recursive: true, mode: 0o700 });
  const lock = join(paths.state,'launcher.lock'); await writeFile(lock,String(process.pid),{flag:'wx',mode:0o600}).catch(() => { throw Error('Another launcher may be running. Inspect launcher.lock before retrying; no process was stopped.'); });
  const browserAbort = new AbortController();
  let browserTask;
  try {
    await new Promise((ok, fail) => { const server = createServer(); server.once('error', () => fail(Error('Local Web port is already occupied; choose --port.'))); server.listen(port,'127.0.0.1',() => server.close(ok)); });
    const shouldOpen = options.open ?? (!!process.stdin.isTTY && await confirm('Open local Web in your browser after startup?'));
    const startBrowser = () => { if (shouldOpen) browserTask = browserWhenReady(paths,port,browserAbort.signal,root).catch(() => { console.log('Browser bootstrap unavailable; use local connection command.'); }); };
    const connection = await findConnection(process.env, paths);
    if (connection) {
      if (options.updateDsh) throw Error('External DSH is user-owned; update it separately');
      try { const { probeDsh } = await import(pathToFileURL(join(root,'apps/daemon/dist/host-service.mjs')).href); await probeDsh(connection); } catch { throw Error('Configured DSH failed authenticated readiness. Check its URL/token; no replacement was installed.'); }
      console.log(`Turnwire foreground Web: http://127.0.0.1:${port}\nUsing external DSH; it will not be stopped by Turnwire. Use turnwire connect for local connection details.`);
      startBrowser();
      return await runChild(process.execPath,[join(root,'apps/daemon/dist/main.js')],{env:{...env,TURNWIRE_RUNTIME:'dsh',TURNWIRE_DSH_URL:connection},cwd:root});
    }
    if (options.updateDsh && process.env.TURNWIRE_DSH_ENTRY) throw Error('Custom DSH entry is user-owned; update it separately');
    let entry = await selectedEntry(paths, process.env, privateJson);
    const installed = await installedVersion(entry);
    const dshPort = Number(env.TURNWIRE_DSH_PORT ?? 3080);
    if (!Number.isInteger(dshPort) || dshPort < 1 || dshPort > 65535) throw Error('Invalid TURNWIRE_DSH_PORT');
    await new Promise((ok, fail) => { const server = createServer(); server.once('error', () => fail(Error('Managed DSH port is already occupied; set TURNWIRE_DSH_PORT or connect to an external DSH.'))); server.listen(dshPort, '127.0.0.1', () => server.close(ok)); });
    try {
      const live = await privateJson(join(paths.state,'run/host-readiness.json'));
      if (Number.isSafeInteger(live.supervisorPid) && live.supervisorPid > 0) {
        try { process.kill(live.supervisorPid,0); throw Error('A managed host is already running; connect to it explicitly or stop it first'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!installed || options.updateDsh) {
      if (process.env.TURNWIRE_DSH_ENTRY) throw Error('Explicit TURNWIRE_DSH_ENTRY does not exist; refusing to install over a custom path');
      if (!options.yes && !await confirm('Resolve, stage and validate registry latest DSH before use?')) throw Error('Installation not authorised. Re-run interactively or pass --yes.');
      const version = await resolveLatest({...env, npm_config_cache: join(paths.cache,'npm')});
      if (installed && compareVersions(version,installed) <= 0) console.log('Registry latest is not newer than installed DSH; keeping current installation (no downgrade).');
      else {
        console.log(`Staging DSH ${version}; current installation remains unchanged until validation passes…`);
        const {probeDsh} = await import(pathToFileURL(join(root,'apps/daemon/dist/host-service.mjs')).href);
        entry = await stageAndActivate({paths,version,root,env,runChild,probe:probeDsh});
      }
    }
    const key = await ensureKey(paths,process.env);
    env.TURNWIRE_DSH_ENTRY = entry;
    console.log(`Turnwire foreground Web: http://127.0.0.1:${port}\nKeep this terminal open. Ctrl-C stops this managed host. Use turnwire connect for local connection details.`);
    startBrowser();
    return await runChild(process.execPath,[join(root,'apps/daemon/dist/host-service.mjs')],{env:{...env,TURNWIRE_INSTALL_DIR:root,...(key ? {TURNWIRE_HARNESS_DEEPSEEK_API_KEY:key} : {})},cwd:root});
  } finally { browserAbort.abort(); await browserTask; await unlink(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().then(code => { process.exitCode = code; }).catch(error => { console.error(`Turnwire: ${error.message}`); process.exitCode = 1; });
