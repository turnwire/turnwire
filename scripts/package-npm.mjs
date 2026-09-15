#!/usr/bin/env node
// Produce an isolated, dependency-free npm distribution, never touch installed services.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { build as buildWeb } from 'vite';
import { mkdir, readFile, writeFile, cp, rm, chmod, readdir, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { buildDaemonArtifact } from './build-identity.mjs';

export const packageVersion = '0.1.0-next.1';
export function distributionVersion(env = process.env) {
  const preview = env.TURNWIRE_NPM_PREVIEW_VERSION;
  if (!preview) return packageVersion;
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-next\.[1-9][0-9]*\.[0-9a-f]{12}$/.test(preview) || !preview.startsWith(packageVersion.split('-')[0] + '-next.')) throw Error('Invalid CI preview version');
  return preview;
}
export const packageManifest = () => ({ name: 'turnwire', version: distributionVersion(), description: 'Self-hosted agent sessions across your terminal, browser and phone', type: 'module', license: 'Apache-2.0', bin: { turnwire: 'bin/turnwire.mjs' }, engines: { node: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node }, os: ['linux', 'darwin'], files: ['bin/', 'apps/', 'config/', 'licenses/', 'README.md', 'README.zh.md', 'LICENSE'], publishConfig: { access: 'public', tag: distributionVersion().includes('-') ? 'next' : 'latest' }, repository: { type: 'git', url: 'git+https://github.com/turnwire/turnwire.git' }, homepage: 'https://github.com/turnwire/turnwire', bugs: { url: 'https://github.com/turnwire/turnwire/issues' } });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'artifacts/npm/turnwire');
const banner = "import { createRequire as __twCreateRequire } from 'node:module'; const require = __twCreateRequire(import.meta.url);";
export function assertBundled(meta) {
  for (const entry of Object.values(meta.outputs)) for (const item of entry.imports) {
    if (item.external && !isBuiltin(item.path)) throw Error(`Unbundled runtime dependency: ${item.path}`);
  }
}
export async function packageNpm() {
  execFileSync(process.execPath, [join(root, 'scripts/sync-docs.mjs'), '--check'], { cwd: root, stdio: 'inherit' });
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
  const alias = {};
  for (const name of await readdir(join(root, 'packages'))) {
    const pkg = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'));
    alias[pkg.name] = join(root, 'packages', name, 'src/index.ts');
  }
  const licenseInputs = new Set();
  async function bundle(entry, target, options = {}) {
    const result = await build({ absWorkingDir: root, entryPoints: [entry], outfile: join(output, target), bundle: true, alias, platform: 'node', format: 'esm', target: 'node22', sourcemap: false, metafile: true, banner: { js: banner }, plugins: [{ name: 'optional-color-capability', setup(context) { context.onResolve({ filter: /^supports-color$/ }, () => ({ path: 'supports-color', namespace: 'optional-color' })); context.onLoad({ filter: /.*/, namespace: 'optional-color' }, () => ({ contents: 'module.exports = false;', loader: 'js' })); } }], define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' }, ...options });
    assertBundled(result.metafile);
    for (const input of Object.keys(result.metafile.inputs)) if (input.includes('node_modules/')) licenseInputs.add(input);
  }
  const staged = await buildDaemonArtifact(root);
  const daemon = 'apps/daemon/dist/main.js';
  await bundle(undefined, daemon, { entryPoints: undefined, stdin: { contents: staged.code, resolveDir: root, sourcefile: 'turnwire-daemon-stage.js', loader: 'js' } });
  // The npm daemon is a distinct fully bundled artifact, not the developer external-dependency build.
  const code = await readFile(join(output, daemon), 'utf8');
  const identity = { ...staged.identity, buildId: createHash('sha256').update('turnwire-npm-v1\0').update(code).digest('hex') };
  await writeFile(join(output, daemon), code.replaceAll(staged.identity.buildId, identity.buildId));
  await writeFile(join(output, 'apps/daemon/dist/turnwire-build.json'), JSON.stringify(identity) + '\n');
  for (const [entry, target] of [
    ['apps/cli/src/main.ts', 'apps/cli/dist/main.js'],
    ['apps/daemon/src/host-service.ts', 'apps/daemon/dist/host-service.mjs'],
    ['apps/relay/src/main.ts', 'apps/relay/dist/standalone.mjs'],
    ['apps/deployer/src/installer.ts', 'apps/deployer/dist/installer.mjs'],
    ['apps/launcher/main.mjs', 'bin/turnwire.mjs'],
  ]) await bundle(join(root, entry), target);
  const launcher = join(output, 'bin/turnwire.mjs');
  const launchCode = await readFile(launcher, 'utf8');
  if (!launchCode.startsWith('#!')) await writeFile(launcher, '#!/usr/bin/env node\n' + launchCode);
  await chmod(launcher, 0o755);
  await buildWeb({ plugins: [{ name: 'collect-npm-web-licenses', generateBundle() { for (const id of this.getModuleIds()) if (id.includes('node_modules/')) licenseInputs.add(id.replace(/\?.*$/, '')); } }], root: join(root, 'apps/remote-web'), configFile: join(root, 'apps/remote-web/vite.config.ts'), build: { outDir: join(output, 'apps/remote-web/dist'), emptyOutDir: true, sourcemap: false } });
  const webIdentity = JSON.parse(await readFile(join(output, 'apps/remote-web/dist/turnwire-build.json'), 'utf8'));
  if (webIdentity.requiredContract !== identity.contractDigest) throw Error('Daemon/Web contract changed during package build');
  await mkdir(join(output, 'config'), { recursive: true });
  await cp(join(root, 'config/dsh-deepseek.patch.yml'), join(output, 'config/dsh-deepseek.patch.yml'));
  await cp(join(root, 'LICENSE'), join(output, 'LICENSE'));
  await writeFile(join(output, 'package.json'), JSON.stringify(packageManifest(), null, 2) + '\n');
  for (const [source, target] of [['NPM-README.md', 'README.md'], ['NPM-README.zh.md', 'README.zh.md']]) {
    const guide = (await readFile(join(root, 'docs', source), 'utf8')).replaceAll('(NPM-README.md)', '(README.md)').replaceAll('(NPM-README.zh.md)', '(README.zh.md)');
    await writeFile(join(output, target), guide);
  }
  await mkdir(join(output, 'licenses'), { recursive: true });
  const seen = new Set();
  for (const input of licenseInputs) {
    let directory = dirname(resolve(root, input));
    while (directory.includes('node_modules')) {
      try {
        const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (!seen.has(pkg.name)) {
          seen.add(pkg.name);
          const names = (await readdir(directory)).filter(name => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
          for (const name of names) await cp(join(directory, name), join(output, 'licenses', `${pkg.name.replaceAll('/', '__')}-${name}`));
        }
        break;
      } catch { directory = dirname(directory); }
    }
  }
  return output;
}
export async function verifyPack(directory = output) {
  const temporary = await mkdtemp(join(tmpdir(), 'turnwire-npm-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: temporary, npm_config_cache: join(temporary, 'npm-cache') } }))[0];
    for (const file of packed.files) if (/(^|\/)(node_modules|\.env|client\.json|dsh\.env\.json|state|\.git)(\/|$)/.test(file.path)) throw Error(`Unexpected packed file: ${file.path}`);
    execFileSync('tar', ['-xzf', join(temporary, packed.filename), '-C', temporary]);
    const isolated = join(temporary, 'package');
    for (const [source, target] of [['NPM-README.md', 'README.md'], ['NPM-README.zh.md', 'README.zh.md']]) {
      const expected = (await readFile(join(root, 'docs', source), 'utf8')).replaceAll('(NPM-README.md)', '(README.md)').replaceAll('(NPM-README.zh.md)', '(README.zh.md)');
      if (await readFile(join(isolated, target), 'utf8') !== expected) throw Error(`Packaged documentation differs from source: ${target}`);
    }
    const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', NODE_PATH: '', HOME: temporary, XDG_CONFIG_HOME: join(temporary, 'config'), XDG_STATE_HOME: join(temporary, 'state'), XDG_DATA_HOME: join(temporary, 'data'), XDG_CACHE_HOME: join(temporary, 'cache') };
    for (const key of Object.keys(env)) if (key.startsWith('TURNWIRE_')) delete env[key];
    const help = execFileSync(process.execPath, [join(isolated, 'apps/cli/dist/main.js'), '--help'], { cwd: temporary, env, encoding: 'utf8', timeout: 30000 });
    if (!help.includes('Usage:')) throw Error('Standalone CLI help missing');
    const launchHelp = execFileSync(process.execPath, [join(isolated, 'bin/turnwire.mjs'), '--help'], { cwd: temporary, env, encoding: 'utf8', timeout: 30000 });
    if (!/turnwire/i.test(launchHelp)) throw Error('Standalone launcher help missing');
    const prefix = join(temporary, 'installed');
    execFileSync('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, packed.filename)], { cwd: temporary, env: { ...env, npm_config_cache: join(temporary, 'npm-cache') }, timeout: 30000 });
    const installedHelp = execFileSync(join(prefix, 'bin/turnwire'), ['--help'], { cwd: temporary, env, encoding: 'utf8', timeout: 30000 });
    if (!/turnwire/i.test(installedHelp)) throw Error('Installed npm bin help missing');
    const actual = JSON.parse(execFileSync(process.execPath, [join(isolated, 'apps/daemon/dist/main.js'), '--build-identity'], { cwd: temporary, env, encoding: 'utf8', timeout: 30000 }));
    const expected = JSON.parse(await readFile(join(isolated, 'apps/daemon/dist/turnwire-build.json'), 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Packaged daemon identity mismatch');
    return { filename: packed.filename, files: packed.files.length, size: packed.size, unpackedSize: packed.unpackedSize };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--verify')) throw Error('Usage: node scripts/package-npm.mjs [--verify]');
    console.log(await packageNpm());
    if (process.argv.includes('--verify')) console.log(JSON.stringify(await verifyPack()));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
