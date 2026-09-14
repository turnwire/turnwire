import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { build, version as esbuildVersion } from 'esbuild';

function digest(root, paths) {
  const hash = createHash('sha256');
  function visit(path) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${path}/${entry.name}`;
      if (/^(dist|node_modules|tests|__tests__)$/.test(entry.name) || /\.(test|spec)\./.test(entry.name)) continue;
      if (entry.isSymbolicLink()) throw Error(`non-regular build input: ${child}`);
      if (entry.isDirectory()) visit(child); else add(child);
    }
  }
  function add(path) { if (existsSync(join(root, path))) { const bytes = readFileSync(join(root, path)); hash.update(JSON.stringify([path, bytes.length]) + '\0').update(bytes); } }
  for (const [path, directory] of paths) directory ? visit(path) : add(path);
  return hash.digest('hex');
}
export function requiredContract(root) {
  return digest(root, [...['protocol', 'wire', 'sdk'].flatMap(name => [[`packages/${name}/src`, true], [`packages/${name}/package.json`, false]]), ['package-lock.json', false], ['tsconfig.json', false]]);
}
export function identityDefine(identity) { return { __TURNWIRE_BUILD_IDENTITY__: JSON.stringify(identity) }; }

// Keep the identity outside esbuild's output: the hash covers the un-stamped artifact,
// not its own value. This also avoids a second compilation against mutable sources.
const identityVariable = '__turnwire_captured_build_identity__';
const loaders = { '.ts': 'ts', '.tsx': 'tsx', '.mts': 'ts', '.cts': 'ts', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js', '.json': 'json' };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function stamp(path) {
  const stat = statSync(path, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
// Resolution reads manifests/configuration outside metafile.inputs. Capture these
// before esbuild starts, including new workspaces, without enumerating source owners.
function configuration(root, sourceStamps) {
  const files = new Map();
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'dist', '.git', '.turnwire'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (sourceStamps && entry.isFile() && loaders[extname(path)]) sourceStamps.set(relative(root, path), stamp(path));
      if (entry.isDirectory()) visit(path);
      else if (/^(package(-lock)?|[jt]sconfig[^/]*)\.json$/.test(entry.name) || (dirname(path) === join(root, 'scripts') && /^(build.*|host-reload-daemon)\.mjs$/.test(entry.name))) {
        files.set(relative(root, path), { bytes: readFileSync(path), stamp: stamp(path) });
      }
    }
  }
  visit(root);
  return files;
}
function sameSnapshot(a, b) {
  return a.size === b.size && [...a].every(([path, value]) => b.has(path) && value.stamp === b.get(path).stamp && value.bytes.equals(b.get(path).bytes));
}
export async function buildDaemonArtifact(root) {
  root = resolve(root);
  const sourceStamps = new Map();
  const configs = configuration(root, sourceStamps);
  const contractDigest = requiredContract(root);
  const alias = {};
  // Discover workspace entry points instead of maintaining a second source list.
  const packages = join(root, 'packages');
  if (existsSync(packages)) for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(packages, entry.name, 'src/index.ts'))) continue;
    const manifest = configs.get(`packages/${entry.name}/package.json`);
    const name = manifest && JSON.parse(manifest.bytes).name;
    if (typeof name !== 'string' || !name.startsWith('@turnwire/')) throw Error(`invalid workspace manifest: packages/${entry.name}/package.json`);
    alias[name] = `./packages/${entry.name}/src/index.ts`;
  }
  const options = { entryPoints: ['apps/daemon/src/main.ts'], outfile: 'main.js', bundle: true, packages: 'external', alias, platform: 'node', format: 'esm', target: 'node22', sourcemap: false, write: false, metafile: true, define: { __TURNWIRE_BUILD_IDENTITY__: identityVariable } };
  const inputs = new Map();
  const result = await build({ ...options, absWorkingDir: root, plugins: [{ name: 'capture-identity-inputs', setup(context) {
    context.onLoad({ filter: /.*/, namespace: 'file' }, args => {
      const loader = loaders[extname(args.path)];
      if (!loader) throw Error(`unsupported build identity input: ${args.path}`);
      const before = stamp(args.path); const bytes = readFileSync(args.path);
      if (sourceStamps.get(relative(root, args.path)) !== before || before !== stamp(args.path)) throw Error('source changed during staged build');
      inputs.set(relative(root, args.path), { bytes, stamp: before });
      return { contents: bytes, loader, resolveDir: dirname(args.path) };
    });
  } }] });
  // Every metafile input must have been captured, including tree-shaken modules.
  for (const path of Object.keys(result.metafile.inputs)) if (!inputs.has(path)) throw Error(`uncaptured build identity input: ${path}`);
  for (const [path, input] of inputs) {
    if (input.stamp !== stamp(resolve(root, path)) || !input.bytes.equals(readFileSync(resolve(root, path)))) throw Error('source changed during staged build');
  }
  if (!sameSnapshot(configs, configuration(root)) || contractDigest !== requiredContract(root)) throw Error('source changed during staged build');
  const hash = createHash('sha256');
  hash.update(JSON.stringify(canonical({ schema: 2, esbuildVersion, options, graph: result.metafile, contractDigest })));
  const usedConfigs = [...configs].filter(([path]) => {
    const dir = dirname(path);
    return dir === '.' || dir === 'scripts' || [...inputs.keys()].some(input => input.startsWith(`${dir}/`)) || Object.values(alias).some(input => input.startsWith(`./${dir}/`));
  });
  for (const [path, input] of [...usedConfigs, ...inputs].sort(([a], [b]) => a.localeCompare(b))) hash.update(JSON.stringify([path, input.bytes.length]) + '\0').update(input.bytes);
  if (result.outputFiles.length !== 1) throw Error('daemon identity requires one JavaScript artifact');
  const output = result.outputFiles[0].contents;
  hash.update(output);
  const identity = { kind: 'built', buildId: hash.digest('hex'), contractDigest };
  const text = Buffer.from(output).toString('utf8');
  const split = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
  return { identity, code: `${text.slice(0, split)}const ${identityVariable} = ${JSON.stringify(identity)};\n${text.slice(split)}` };
}
export async function buildIdentity(root) { return (await buildDaemonArtifact(root)).identity; }
