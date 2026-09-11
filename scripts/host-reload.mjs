#!/usr/bin/env node
// Only frontend publication is automated. No idle snapshot is a drain gate.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ignored = /(^|\/)(node_modules|dist|build|coverage|docs?|tests?|__tests__|\.git|\.turnwire)(\/|$)|\.(test|spec)\.|\.(md|mdx|rst|txt)$|(^|\/)(\.env[^/]*|dsh\.env\.json)$|\.(pem|key|p12|pfx)$|(^|\/)[^/]*(secret|credential)[^/]*\.(json|ya?ml)$/i;
export function component(path, executable = false) {
  if (ignored.test(path)) return null;
  // Select executable/build inputs and public frontend assets, not arbitrary local data.
  const source = /\.(?:[cm]?[jt]sx?|sh|css|html|vue|svelte|swift|rs|c|h|cpp)$/.test(path);
  const manifest = /(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json)$/.test(path);
  const asset = /^apps\/remote-web\/(src|public)\/.*\.(svg|png|jpg|jpeg|webp|gif|ico|woff2?|webmanifest)$/.test(path);
  if (!source && !manifest && !asset && !executable && path !== 'config/dsh-deepseek.patch.yml') return null;
  if (/^config\/dsh-runtime\/(package(-lock)?\.json|(?:src|scripts)\/.*)$/.test(path) || path === 'config/dsh-deepseek.patch.yml') return 'dsh';
  if (path.startsWith('apps/remote-web/')) return 'frontend';
  if (/^(apps|packages|scripts)\//.test(path) || /^(package(-lock)?\.json|tsconfig[^/]*\.json)$/.test(path)) return 'backend';
  return null;
}
export function fingerprints(root) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean);
  const hashes = Object.fromEntries(['frontend', 'backend', 'dsh'].map(c => [c, createHash('sha256')]));
  for (const file of [...new Set(files)].sort()) {
    if (ignored.test(file)) continue;
    const path = join(root, file); if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    const c = component(file, !!(stat.mode & 0o111)); if (!c) continue;
    if (!stat.isFile()) throw new Error(`refusing non-regular source: ${file}`);
    const bytes = readFileSync(path);
    hashes[c].update(JSON.stringify([file, stat.mode & 0o111, bytes.length]) + '\0').update(bytes);
  }
  return Object.fromEntries(Object.entries(hashes).map(([c, h]) => [c, h.digest('hex')]));
}
function localUrl(url) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.protocol !== 'http:' || parsed.username || parsed.password) throw new Error('health URL must be local HTTP without credentials');
  return parsed;
}
// Match SDK client discovery without importing unbuilt TypeScript or exposing its token.
export function healthUrl(env = process.env) {
  if (env.TURNWIRE_RELOAD_HEALTH_URL) return localUrl(env.TURNWIRE_RELOAD_HEALTH_URL).href;
  const home = env.HOME || homedir();
  const legacy = env.TURNWIRE_HOME || (existsSync(join(home, '.turnwire')) ? join(home, '.turnwire') : undefined);
  const config = env.TURNWIRE_CONFIG_HOME || legacy || join(env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config'), 'turnwire');
  const client = join(config, 'client.json');
  if (existsSync(client)) {
    const value = JSON.parse(readFileSync(client, 'utf8'));
    if (typeof value.url !== 'string') throw new Error('client config has no daemon URL; health unknown');
    return new URL('/health', localUrl(value.url)).href;
  }
  if (env.TURNWIRE_PORT) return localUrl(`http://127.0.0.1:${env.TURNWIRE_PORT}/health`).href;
  throw new Error('no local client config or explicit health endpoint; health unknown');
}
export async function health(url, fetcher = fetch) {
  const parsed = localUrl(url);
  const response = await fetcher(parsed, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  const value = await response.json();
  if (!response.ok || value?.status !== 'ok' || value?.protocol !== 1) throw new Error('health unknown or not ready; blocked');
}
function atomicJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`; writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 }); renameSync(tmp, path);
}
function assetFiles(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('refusing symlink in build');
    return entry.isDirectory() ? assetFiles(root, path) : [relative(root, path)];
  });
}
// Keep old content-addressed assets for existing pages. All assets land before atomic index switch.
function publish(stage, dist) {
  const files = assetFiles(stage); if (!files.includes('index.html')) throw new Error('build has no index.html');
  mkdirSync(dist, { recursive: true });
  for (const file of files.filter(f => f !== 'index.html')) {
    const target = join(dist, file);
    if (existsSync(target) && !readFileSync(target).equals(readFileSync(join(stage, file)))) throw new Error(`non-content-addressed asset collision: ${file}; manual publication required`);
  }
  for (const file of files.filter(f => f !== 'index.html')) {
    const target = join(dist, file); mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) { const tmp = `${target}.${randomUUID()}.tmp`; copyFileSync(join(stage, file), tmp); renameSync(tmp, target); }
  }
  const index = join(dist, 'index.html'), old = existsSync(index) ? readFileSync(index) : null;
  const tmp = `${index}.${randomUUID()}.tmp`; copyFileSync(join(stage, 'index.html'), tmp); renameSync(tmp, index);
  return () => { if (old === null) rmSync(index, { force: true }); else { writeFileSync(tmp, old); renameSync(tmp, index); } };
}
export async function reload(root, { frontend = false, checkHealth = () => health(healthUrl()), build = stage => execFileSync('npm', ['run', 'build', '-w', '@turnwire/remote-web', '--', '--outDir', stage], { cwd: root, stdio: 'inherit' }), log = console.log } = {}) {
  const state = join(root, '.turnwire'); mkdirSync(state, { recursive: true });
  const observedPath = join(state, 'reload.observed.json'), stamp = join(state, 'reload.frontend.json');
  const current = fingerprints(root);
  const previous = existsSync(observedPath) ? JSON.parse(readFileSync(observedPath, 'utf8')) : null;
  for (const c of ['backend', 'dsh']) {
    if (!previous || previous[c] !== current[c]) log(`${c} content ${previous ? 'changed' : 'not verified'}: manual operator action required; automatic backend updates disabled (no drain gate)`);
  }
  atomicJson(observedPath, current);
  const deployed = existsSync(stamp) ? JSON.parse(readFileSync(stamp, 'utf8')) : null;
  if (!deployed && !frontend) { log('no verified frontend baseline; run scripts/host-reload.sh --frontend explicitly to initialize'); return; }
  if (deployed?.frontend === current.frontend && !frontend) { log('no frontend content change; nothing to deploy'); return; }
  // Shared packages/lockfiles require manual maintenance; never silently mix new SDK and old daemon.
  if (deployed && deployed.backend !== current.backend && !frontend) throw new Error('backend/shared content changed; manual frontend maintenance required');
  await checkHealth();
  const stage = join(state, `frontend-stage-${randomUUID()}`);
  let rollback;
  try {
    build(stage);
    if (JSON.stringify(fingerprints(root)) !== JSON.stringify(current)) throw new Error('source changed during build; retry later');
    await checkHealth();
    rollback = publish(stage, join(root, 'apps/remote-web/dist'));
    await checkHealth();
    atomicJson(stamp, { ...current, verifiedAt: new Date().toISOString() });
    rollback = undefined;
    log('frontend assets published; no backend or DSH process was restarted');
  } finally { rollback?.(); rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--frontend') || args.length > 1) { console.error('usage: scripts/host-reload.sh [--frontend] (never restarts backend or DSH)'); process.exitCode = 1; }
  else await reload(resolve(dirname(fileURLToPath(import.meta.url)), '..'), { frontend: args.includes('--frontend') }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
