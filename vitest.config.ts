import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  resolve: { alias: Object.fromEntries(['protocol', 'wire', 'runtime', 'core', 'runtime-dsh', 'sdk'].map(name => [`@turnwire/${name}`, resolve(`packages/${name}/src/index.ts`)])) },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 15_000, hookTimeout: 15_000, fileParallelism: false },
});
