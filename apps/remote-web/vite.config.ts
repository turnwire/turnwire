import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Node-only build helper
import { requiredContract } from '../../scripts/build-identity.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig(() => {
  const contract = requiredContract(root);
  return {
    plugins: [react(), { name: 'turnwire-required-contract', generateBundle() { this.emitFile({ type: 'asset', fileName: 'turnwire-build.json', source: JSON.stringify({ requiredContract: contract }) + '\n' }); }, transformIndexHtml(html) { return html.replace('<head>', `<head><meta name="turnwire-required-contract" content="${contract}">`); } }],
    resolve: { alias: { '@turnwire/wire': fileURLToPath(new URL('../../packages/wire/src/index.ts', import.meta.url)), '@turnwire/sdk': fileURLToPath(new URL('../../packages/sdk/src/index.ts', import.meta.url)), '@turnwire/protocol': fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)) } },
    build: { sourcemap: true }, server: { port: 5173, strictPort: true },
  };
});
