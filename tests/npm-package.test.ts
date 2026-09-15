import { describe, expect, it } from 'vitest';
// @ts-expect-error JavaScript operator helper
import { assertBundled, packageManifest, distributionVersion } from '../scripts/package-npm.mjs';

describe('standalone npm package boundary', () => {
  it('publishes one preview app without private workspace dependencies or install hooks', () => {
    const manifest = packageManifest();
    expect(manifest.name).toBe('turnwire');
    expect(manifest.version).toBe('0.1.0-next.1');
    expect(manifest.bin).toEqual({ turnwire: 'bin/turnwire.mjs' });
    expect(manifest.os).toEqual(['linux', 'darwin']);
    expect(manifest.publishConfig).toEqual({ access: 'public', tag: 'next' });
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    expect(manifest.files).not.toContain('node_modules');
    expect(manifest.files).toEqual(expect.arrayContaining(['README.md', 'README.zh.md']));
  });
  it('allows CI preview overrides but never stable or unrelated version overrides', () => {
    expect(distributionVersion({ TURNWIRE_NPM_PREVIEW_VERSION: '0.1.0-next.42.abc123abcdef' })).toBe('0.1.0-next.42.abc123abcdef');
    for (const value of ['0.1.0', '1.0.0-next.42.abc123abcdef', '0.1.0-next.0.abc123abcdef', '../bad']) expect(() => distributionVersion({ TURNWIRE_NPM_PREVIEW_VERSION: value })).toThrow();
  });
  it('rejects unresolved workspaces and third-party runtime imports', () => {
    const graph = (path: string) => ({ outputs: { 'main.js': { imports: [{ external: true, path }] } } });
    expect(() => assertBundled(graph('@turnwire/sdk'))).toThrow('Unbundled');
    expect(() => assertBundled(graph('ws'))).toThrow('Unbundled');
    expect(() => assertBundled(graph('node:fs'))).not.toThrow();
    expect(() => assertBundled(graph('node:sqlite'))).not.toThrow();
  });
});
