import { afterEach, expect, it, vi } from 'vitest';
const buildHooks = vi.hoisted(() => ({ before: undefined as (() => void) | undefined, after: undefined as (() => void) | undefined }));
vi.mock('esbuild', async importOriginal => {
 const original = await importOriginal<typeof import('esbuild')>();
 return { ...original, build: async (options: import('esbuild').BuildOptions) => {
  buildHooks.before?.(); const result = await original.build(options); buildHooks.after?.(); return result;
 } };
});
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { startDaemonServer } from '../apps/daemon/src/server.js';
import { daemonIdentity } from '../apps/daemon/src/identity.js';
import { requireBuiltIdentity } from '../packages/protocol/src/release-identity.mjs';
// @ts-expect-error standalone build helper
import { buildIdentity, identityDefine, buildDaemonArtifact } from '../scripts/build-identity.mjs';
// @ts-expect-error standalone build helper
import { stageDaemon } from '../scripts/host-reload-daemon.mjs';
const roots: string[] = [];
function graphFixture() {
 const root = mkdtempSync(join(tmpdir(), 'identity-graph-')); roots.push(root);
 const put = (path: string, source: string) => { const target = join(root, path); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, source); };
 put('apps/daemon/src/main.ts', 'import { value } from "../../relay/src/auth.ts"; console.log(value, __TURNWIRE_BUILD_IDENTITY__);');
 put('apps/relay/src/auth.ts', 'export const value = "old-secret-check";');
 return { root, put };
}
it('hashes relay-only changes and automatically follows newly imported source, including JSON', async () => {
 const { root, put } = graphFixture();
 const first = await buildIdentity(root);
 put('apps/relay/src/auth.ts', 'export const value = "new-secret-check";');
 const relay = await buildIdentity(root); expect(relay.buildId).not.toBe(first.buildId); expect(relay.contractDigest).toBe(first.contractDigest);
 put('new-owner/nested/data.json', '{"value":"first"}');
 put('apps/relay/src/auth.ts', 'export {default as value} from "../../../new-owner/nested/data.json";');
 const added = await buildIdentity(root);
 put('new-owner/nested/data.json', '{"value":"second"}');
 expect((await buildIdentity(root)).buildId).not.toBe(added.buildId);
});
it('is deterministic across stage paths and checkout locations, with frozen embedded identity', async () => {
 const a = graphFixture(); const b = graphFixture();
 mkdirSync(join(a.root, '.git'));
 a.put('config/unrelated-runtime/package.json', '{"name":"not-an-artifact-input"}');
 const artifact = await buildDaemonArtifact(a.root);
 expect(await buildDaemonArtifact(a.root)).toEqual(artifact);
 expect(await buildDaemonArtifact(b.root)).toEqual(artifact);
 const stage = join(a.root, 'dist'); expect(await stageDaemon(a.root, stage)).toEqual(artifact.identity);
 expect(readFileSync(join(stage, 'main.js'), 'utf8')).toBe(artifact.code);
 const run = () => execFileSync(process.execPath, [join(stage, 'main.js')], { encoding: 'utf8' });
 expect(run()).toContain(artifact.identity.buildId);
 a.put('apps/relay/src/auth.ts', 'export const value = "changed-after-build";');
 expect(run()).toContain(artifact.identity.buildId);
});
it('covers raw tree-shaken inputs and resolution/build configuration', async () => {
 const { root, put } = graphFixture(); const before = await buildIdentity(root);
 put('apps/relay/src/auth.ts', 'export const value = "old-secret-check"; // no emitted change');
 const comment = await buildIdentity(root); expect(comment.buildId).not.toBe(before.buildId);
 put('tsconfig.json', '{"compilerOptions":{"target":"ES2022"}}');
 expect((await buildIdentity(root)).buildId).not.toBe(comment.buildId);
});
afterEach(() => { buildHooks.before = undefined; buildHooks.after = undefined; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
it('rejects source changes before compiler load and after compiler output, without staging bytes', async () => {
 for (const phase of ['before', 'after'] as const) {
  const { root, put } = graphFixture();
  buildHooks[phase] = () => put('apps/relay/src/auth.ts', 'export const value = "raced";');
  await expect(stageDaemon(root, join(root, 'dist'))).rejects.toThrow('source changed during staged build');
  buildHooks[phase] = undefined;
 }
});
it('rejects configuration changes during compilation', async () => {
 const { root, put } = graphFixture();
 buildHooks.after = () => put('tsconfig.json', '{}');
 await expect(buildIdentity(root)).rejects.toThrow('source changed during staged build');
});
it('source execution has one frozen non-publishable identity, never a mutable-source contract', async () => {
 expect(daemonIdentity.kind).toBe('source'); expect(daemonIdentity.contractDigest).toBeNull(); expect(Object.isFrozen(daemonIdentity)).toBe(true);
 expect((await import('../apps/daemon/src/identity.js')).daemonIdentity).toBe(daemonIdentity);
 expect(() => requireBuiltIdentity(daemonIdentity)).toThrow('identity');
});
it('health reports a captured identity and defaults source/demo to non-publishable', async () => {
 const core = new TurnwireCore(new Store(':memory:'), [new DemoRuntime()], { id: 'identity-test', name: 'Identity test' });
 const identity = { kind: 'built' as const, buildId: 'a'.repeat(64), contractDigest: 'b'.repeat(64) };
 const server = await startDaemonServer({ core, token: 'test', port: 0, identity });
 const source = await startDaemonServer({ core, token: 'test', port: 0 });
 try {
  identity.buildId = 'c'.repeat(64);
  const response = await fetch(`http://127.0.0.1:${server.port}/health`);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await response.json()).identity.buildId).toBe('a'.repeat(64));
  expect((await (await fetch(`http://127.0.0.1:${source.port}/health`)).json()).identity).toEqual(daemonIdentity);
 } finally { await server.close(); await source.close(); await core.dispose(); }
});
it('built identity remains embedded after source inputs change, even in a fresh process', async () => {
 const root = mkdtempSync(join(tmpdir(), 'release-identity-')); roots.push(root);
 mkdirSync(join(root, 'packages/sdk/src'), { recursive: true });
 writeFileSync(join(root, 'packages/sdk/src/index.ts'), 'old sdk');
 writeFileSync(join(root, 'packages/sdk/package.json'), '{"name":"@turnwire/sdk"}');
 mkdirSync(join(root, 'apps/daemon/src'), { recursive: true });
 writeFileSync(join(root, 'apps/daemon/src/main.ts'), 'console.log("fixture");');
 const identity = await buildIdentity(root); const artifact = join(root, 'identity.mjs');
 await build({ stdin: { contents: `import { daemonIdentity } from ${JSON.stringify(resolve('apps/daemon/src/identity.ts'))}; console.log(JSON.stringify(daemonIdentity));`, resolveDir: resolve('.') }, bundle: true, platform: 'node', format: 'esm', outfile: artifact, define: identityDefine(identity) });
 const run = () => JSON.parse(execFileSync(process.execPath, [artifact], { encoding: 'utf8' }));
 expect(run()).toEqual(identity);
 writeFileSync(join(root, 'packages/sdk/src/index.ts'), 'new incompatible sdk');
 expect((await buildIdentity(root)).contractDigest).not.toBe(identity.contractDigest);
 expect(run()).toEqual(identity);
});
