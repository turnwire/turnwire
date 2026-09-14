import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { stageDaemon } from './host-reload-daemon.mjs';
for (const name of ['protocol', 'wire', 'runtime', 'core', 'runtime-dsh', 'sdk']) {
  await mkdir(`packages/${name}/dist`, { recursive: true });
  await build({ entryPoints: [`packages/${name}/src/index.ts`], outfile: `packages/${name}/dist/index.js`, bundle: true, packages: 'external', external: ['@turnwire/*'], platform: ['protocol', 'wire', 'sdk'].includes(name) ? 'neutral' : 'node', format: 'esm', target: 'es2023', sourcemap: true });
}
// The daemon must bundle workspace sources, not mutable external package dist files.
await stageDaemon(process.cwd(), 'apps/daemon/dist');
for (const name of ['relay', 'cli']) {
  await build({ entryPoints: [`apps/${name}/src/main.ts`], outfile: `apps/${name}/dist/main.js`, bundle: true, packages: 'external', external: ['@turnwire/*'], platform: 'node', format: 'esm', target: 'node22', sourcemap: true });
}
for (const [source, outfile] of [['apps/daemon/src/host-service.ts', 'apps/daemon/dist/host-service.mjs'], ['apps/relay/src/main.ts', 'apps/relay/dist/standalone.mjs'], ['apps/deployer/src/installer.ts', 'apps/deployer/dist/installer.mjs']]) {
  await build({ entryPoints: [source], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: false, banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
}
