import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({ plugins: [react()], resolve: { alias: { '@turnwire/wire': fileURLToPath(new URL('../../packages/wire/src/index.ts', import.meta.url)), '@turnwire/sdk': fileURLToPath(new URL('../../packages/sdk/src/index.ts', import.meta.url)), '@turnwire/protocol': fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)) } }, build: { sourcemap: true }, server: { port: 5173, strictPort: true } });
