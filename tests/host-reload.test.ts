import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { hermeticEnv } from './helpers/hermetic-env.mjs';
// Source-only helpers: no system services, network requests or production build.
// @ts-expect-error standalone developer script
import { fingerprints, health, healthUrl, reload } from '../scripts/host-reload.mjs';
// @ts-expect-error standalone build helper
import { requiredContract } from '../scripts/build-identity.mjs';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reload-test-')); roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  const put = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  put('apps/remote-web/src/main.ts', 'one'); put('apps/daemon/src/main.ts', 'one');
  execFileSync('git', ['add', '.'], { cwd: root });
  let builds = 0;
  const build = (stage: string) => { builds++; mkdirSync(join(stage, 'assets'), { recursive: true }); writeFileSync(join(stage, 'index.html'), 'new'); writeFileSync(join(stage, 'assets/new-hash.js'), 'asset'); writeFileSync(join(stage, 'turnwire-build.json'), JSON.stringify({ requiredContract: requiredContract(root) })); };
  const options = { stateDir: join(root, 'reload-state'), build, checkHealth: async () => ({ status: 'ok', protocol: 1, identity: { kind: 'built', buildId: 'a'.repeat(64), contractDigest: requiredContract(root) } }), log: () => {} };
  return { root, put, options, builds: () => builds };
}
describe('developer reload safety', () => {
  it('discovers custom daemon port from local client config without forwarding token', () => {
    const f = fixture(); f.put('state/client.json', JSON.stringify({ url: 'http://127.0.0.1:9998', token: 'never-forward' }));
    expect(healthUrl({ HOME: f.root, TURNWIRE_CONFIG_HOME: join(f.root, 'state') })).toBe('http://127.0.0.1:9998/health');
    f.put('xdg/turnwire/client.json', JSON.stringify({ url: 'http://[::1]:9987' }));
    expect(healthUrl({ HOME: f.root, XDG_CONFIG_HOME: join(f.root, 'xdg') })).toBe('http://[::1]:9987/health');
    expect(() => healthUrl({ HOME: f.root })).toThrow('health unknown');
    for (const url of ['https://example.com', 'http://example.com', 'http://user:secret@127.0.0.1:9998']) {
      f.put('state/client.json', JSON.stringify({ url }));
      expect(() => healthUrl({ HOME: f.root, TURNWIRE_CONFIG_HOME: join(f.root, 'state') })).toThrow('local HTTP');
    }
    expect(healthUrl({ HOME: f.root, TURNWIRE_RELOAD_HEALTH_URL: 'http://localhost:9001/health' })).toBe('http://localhost:9001/health');
  });
  it('hashes dirty bytes and untracked sources, but excludes docs/tests/dist/secrets', () => {
    const f = fixture(); const a = fingerprints(f.root);
    f.put('apps/remote-web/src/main.ts', 'two'); const b = fingerprints(f.root);
    f.put('apps/remote-web/src/main.ts', 'three'); expect(fingerprints(f.root).frontend).not.toBe(b.frontend);
    expect(a.frontend).not.toBe(b.frontend);
    f.put('apps/remote-web/src/new.ts', 'new'); const c = fingerprints(f.root);
    for (const path of ['docs/a.md', 'apps/remote-web/src/a.test.ts', 'apps/remote-web/dist/out.js', 'apps/remote-web/.env.local']) f.put(path, 'ignored');
    expect(fingerprints(f.root)).toEqual(c);
  });
  it('detects deletion, executable mode, and DSH changes independently', () => {
    const f = fixture(); const a = fingerprints(f.root);
    chmodSync(join(f.root, 'apps/daemon/src/main.ts'), 0o755); const b = fingerprints(f.root);
    expect(b.backend).not.toBe(a.backend); expect(b.frontend).toBe(a.frontend);
    rmSync(join(f.root, 'apps/daemon/src/main.ts')); expect(fingerprints(f.root).backend).not.toBe(b.backend);
    f.put('config/dsh-runtime/package.json', '{"version":"2"}'); expect(fingerprints(f.root).dsh).not.toBe(a.dsh);
  });
  it('DSH-only drift reports operator action without a build', async () => {
    const f = fixture(); await reload(f.root, { ...f.options, frontend: true });
    f.put('config/dsh-runtime/package.json', '{}'); const messages: string[] = [];
    await reload(f.root, { ...f.options, log: (s: string) => messages.push(s) });
    expect(f.builds()).toBe(1); expect(messages.join('\n')).toContain('dsh content changed: manual operator action');
  });
  it('does not deploy on first observation or docs-only changes', async () => {
    const f = fixture(); await reload(f.root, f.options); expect(f.builds()).toBe(0);
    await reload(f.root, { ...f.options, frontend: true });
    f.put('docs/note.md', 'docs'); await reload(f.root, f.options); expect(f.builds()).toBe(1);
  });
  it('frontend-only update keeps old assets and makes no service calls', async () => {
    const f = fixture(); f.put('apps/remote-web/dist/assets/old-hash.js', 'old');
    await reload(f.root, { ...f.options, frontend: true });
    f.put('apps/remote-web/src/main.ts', 'two'); await reload(f.root, f.options);
    expect(f.builds()).toBe(2); expect(readFileSync(join(f.root, 'apps/remote-web/dist/assets/old-hash.js'), 'utf8')).toBe('old');
  });
  it('blocks backend automation even while frontend also changes', async () => {
    const f = fixture(); await reload(f.root, { ...f.options, frontend: true });
    f.put('apps/daemon/src/main.ts', 'two'); f.put('apps/remote-web/src/main.ts', 'two');
    await expect(reload(f.root, f.options)).rejects.toThrow('manual'); expect(f.builds()).toBe(1);
  });
  it('failed or unknown health never builds or stamps', async () => {
    const f = fixture();
    await expect(reload(f.root, { ...f.options, frontend: true, checkHealth: async () => { throw Error('unknown'); } })).rejects.toThrow('unknown');
    expect(f.builds()).toBe(0); expect(existsSync(join(f.root, 'reload-state/reload.frontend.json'))).toBe(false);
    for (const value of [{}, { status: 'ok' }, { status: 'failed', protocol: 1 }]) await expect(health('http://127.0.0.1/health', async () => ({ ok: true, json: async () => value }))).rejects.toThrow('blocked');
    await expect(health('http://127.0.0.1/health', async () => ({ ok: true, json: async () => ({ status: 'ok', protocol: 1 }) }))).rejects.toThrow('identity');
    await expect(health('http://127.0.0.1/health', async () => ({ ok: true, json: f.options.checkHealth }))).resolves.toEqual(await f.options.checkHealth());
  });
  it('rejects new SDK against old daemon even with explicit frontend override', async () => {
    const f = fixture(); const old = await f.options.checkHealth();
    await reload(f.root, { ...f.options, frontend: true });
    f.put('packages/sdk/src/index.ts', 'export const newer = true;');
    await expect(reload(f.root, { ...f.options, frontend: true, checkHealth: async () => old })).rejects.toThrow('required contract');
    expect(f.builds()).toBe(1);
  });
  it('rejects old health and unbuilt source before explicit frontend publication', async () => {
    const f = fixture();
    for (const identity of [undefined, { kind: 'source', buildId: 'source', contractDigest: null }]) {
      await expect(reload(f.root, { ...f.options, frontend: true, checkHealth: async () => ({ status: 'ok', protocol: 1, identity }) })).rejects.toThrow('identity');
    }
    expect(f.builds()).toBe(0);
  });
  it('rolls index back and retains old stamp if post-publication health fails', async () => {
    const f = fixture(); await reload(f.root, { ...f.options, frontend: true });
    f.put('apps/remote-web/dist/index.html', 'old'); f.put('apps/remote-web/src/main.ts', 'two');
    const stamp = readFileSync(join(f.root, 'reload-state/reload.frontend.json'), 'utf8'); let calls = 0;
    await expect(reload(f.root, { ...f.options, checkHealth: async () => { if (++calls === 3) throw Error('not ready'); return f.options.checkHealth(); } })).rejects.toThrow('not ready');
    expect(readFileSync(join(f.root, 'apps/remote-web/dist/index.html'), 'utf8')).toBe('old');
    expect(readFileSync(join(f.root, 'reload-state/reload.frontend.json'), 'utf8')).toBe(stamp);
  });
  it('does not publish failed builds or source that changes during build', async () => {
    const f = fixture(); f.put('apps/remote-web/dist/index.html', 'old');
    await expect(reload(f.root, { ...f.options, frontend: true, build: () => { throw Error('build failed'); } })).rejects.toThrow('build failed');
    await expect(reload(f.root, { ...f.options, frontend: true, build: (stage: string) => { f.options.build(stage); f.put('apps/remote-web/src/main.ts', 'raced'); } })).rejects.toThrow('source changed');
    expect(readFileSync(join(f.root, 'apps/remote-web/dist/index.html'), 'utf8')).toBe('old');
    expect(existsSync(join(f.root, 'reload-state/reload.frontend.json'))).toBe(false);
  });
  it('executes installer against mocked systemctl and temporary HOME only', () => {
    const f = fixture();
    f.put('scripts/install-dev-host.sh', readFileSync(new URL('../scripts/install-dev-host.sh', import.meta.url), 'utf8'));
    f.put('config/dsh-runtime/node_modules/.bin/dsh', '#!/bin/sh\nexit 0\n'); chmodSync(join(f.root, 'config/dsh-runtime/node_modules/.bin/dsh'), 0o755);
    f.put('scripts/host-paths.sh', readFileSync(new URL('../scripts/host-paths.sh', import.meta.url), 'utf8'));
    f.put('home/.config/turnwire/dsh.env.json', '{}'); f.put('apps/daemon/dist/host-service.mjs', '');
    const calls = join(f.root, 'systemctl-calls');
    f.put('mock/systemctl', '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MOCK_CALLS"\n'); chmodSync(join(f.root, 'mock/systemctl'), 0o755);
    const env = hermeticEnv(f.root, { PATH: `${join(f.root, 'mock')}:${process.env.PATH}`, MOCK_CALLS: calls });
    const args = [join(f.root, 'scripts/install-dev-host.sh'), '--state', join(f.root, 'state'), '--dsh-home', join(f.root, 'dsh')];
    execFileSync('bash', args, { cwd: f.root, env });
    let commands = readFileSync(calls, 'utf8');
    expect(commands).toContain('--user disable --now turnwire-dev-reload.timer turnwire-dev-reload.path');
    expect(commands).toContain('--user stop turnwire-dev-reload.service'); expect(commands).not.toContain('enable --now');
    execFileSync('bash', [...args, '--enable-watch'], { cwd: f.root, env });
    commands = readFileSync(calls, 'utf8'); expect(commands).toContain('--user enable --now turnwire-dev-reload.timer turnwire-dev-reload.path');
    expect(commands).not.toMatch(/(?:start|restart) turnwire-dev\.service/);
  });
  it('installer manages both triggers and stops in-flight reload when disabled', () => {
    const source = readFileSync(new URL('../scripts/install-dev-host.sh', import.meta.url), 'utf8');
    expect(source).toContain('disable --now turnwire-dev-reload.timer turnwire-dev-reload.path');
    expect(source).toContain('stop turnwire-dev-reload.service');
    expect(source).toContain('enable --now turnwire-dev-reload.timer turnwire-dev-reload.path');
    const wrapper = readFileSync(new URL('../scripts/host-reload.sh', import.meta.url), 'utf8');
    expect(wrapper).toContain('flock -x 9'); expect(wrapper).not.toContain('systemctl'); expect(wrapper).not.toContain('model-sync');
  });
});
