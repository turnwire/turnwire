// Installed-tarball smoke only. Never consumes developer config or prints local credentials.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const packageRoot = resolve(process.argv[2] ?? '');
assert(process.argv[2], 'Pass the installed turnwire package root');
const sandbox = await mkdtemp(join(tmpdir(), 'turnwire-npm-smoke-'));
const allowed = new Set(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key)));
Object.assign(env, { TURNWIRE_RUNTIME: 'demo', TURNWIRE_PORT: '0', TURNWIRE_CONFIG_HOME: join(sandbox, 'config'), TURNWIRE_STATE_HOME: join(sandbox, 'state'), TURNWIRE_DATA_HOME: join(sandbox, 'data'), TURNWIRE_CACHE_HOME: join(sandbox, 'cache'), HOME: sandbox, XDG_CONFIG_HOME: join(sandbox, 'xdg-config'), XDG_STATE_HOME: join(sandbox, 'xdg-state'), XDG_DATA_HOME: join(sandbox, 'xdg-data'), XDG_CACHE_HOME: join(sandbox, 'xdg-cache') });
const child = spawn(process.execPath, [join(packageRoot, 'apps/daemon/dist/main.js')], { cwd: sandbox, env, stdio: ['ignore', 'ignore', 'pipe'] });
let ended = false; let spawnError; child.on('error', error => { spawnError = error; ended = true; });
const closed = new Promise(resolve => child.once('close', () => { ended = true; resolve(); }));
// Do not echo process output, which can include connection details on a regression.
child.stderr.resume();
try {
  let config;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (ended) throw Error(`Packaged daemon exited before readiness${spawnError ? ': spawn failed' : ''}`);
    try { config = JSON.parse(await readFile(join(sandbox, 'config/client.json'), 'utf8')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(config?.url && config?.token, 'Isolated daemon did not write readiness config');
  const get = async path => { const response = await fetch(new URL(path, config.url), { headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(5000) }); assert(response.ok, `HTTP ${response.status} for ${path}`); return response; };
  const health = await (await get('/health')).json();
  const rpc = await fetch(new URL('/rpc', config.url), { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, id: 'npm-smoke', method: 'system.snapshot', params: {} }), signal: AbortSignal.timeout(5000) });
  assert(rpc.ok, 'Snapshot RPC HTTP failure');
  const reply = await rpc.json(); assert(!reply.error, 'Snapshot RPC failed'); const snapshot = reply.result;
  assert(snapshot.runtimes?.some(runtime => runtime.id === 'demo'), 'Packaged demo runtime absent');
  const manifest = await (await get('/turnwire-build.json')).json();
  assert.equal(manifest.requiredContract, health.identity?.contractDigest, 'Daemon/Web contract mismatch');
  const html = await (await get('/')).text();
  assert(html.includes(manifest.requiredContract), 'Web entry lacks expected contract');
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
  assert(assets.length >= 2, 'Web entry lacks bundled assets');
  for (const asset of assets) await get(asset);
  console.log('Installed tarball: demo daemon, authenticated snapshot, matching Web contract and assets passed.');
} finally {
  if (!ended) child.kill('SIGTERM');
  const timer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 5000);
  await closed; clearTimeout(timer); await rm(sandbox, { recursive: true, force: true });
}
