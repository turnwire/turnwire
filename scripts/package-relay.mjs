import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Produces an independently deployable Relay + PWA without host state or model runtimes.
const output = resolve(process.argv[2] ?? 'dist/relay-release');
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
await build({ entryPoints: ['apps/relay/src/main.ts'], outfile: join(output, 'relay.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: false, banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
await cp('apps/remote-web/dist', join(output, 'web'), { recursive: true, filter: source => !source.endsWith('.map') });
const files = {};
async function inventory(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name, path = join(directory, entry.name);
    if (entry.isDirectory()) await inventory(path, relative + '/');
    else files[relative] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
}
await inventory(output);
await writeFile(join(output, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), node: '>=22.13', files }, null, 2) + '\n');
console.log(`Relay release prepared: ${output}`);
