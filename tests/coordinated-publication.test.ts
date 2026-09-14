import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishCoordinated } from '../scripts/host-publish-coordinated.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coordinated-test-'));
  const source = join(root, 'source'), target = join(root, 'target'), state = join(root, 'state');
  const old = { kind: 'built', buildId: 'a'.repeat(64), contractDigest: 'b'.repeat(64) };
  const next = { kind: 'built', buildId: 'c'.repeat(64), contractDigest: 'd'.repeat(64) };
  for (const [path, identity, asset] of [[target, old, 'old'], [source, next, 'new']] as const) {
    mkdirSync(join(path, 'apps/daemon/dist'), { recursive: true });
    mkdirSync(join(path, 'apps/remote-web/dist/assets'), { recursive: true });
    writeFileSync(join(path, 'apps/daemon/dist/main.js'), JSON.stringify(identity));
    writeFileSync(join(path, 'apps/daemon/dist/turnwire-build.json'), JSON.stringify(identity));
    writeFileSync(join(path, 'apps/remote-web/dist/turnwire-build.json'), JSON.stringify({ requiredContract: identity.contractDigest }));
    writeFileSync(join(path, 'apps/remote-web/dist/index.html'), asset);
    writeFileSync(join(path, `apps/remote-web/dist/assets/${asset}.js`), asset);
  }
  let token: string | undefined, generation = 1, signals = 0, begins = 0, idleReads = 0;
  const control = {
    record: () => ({ supervisorPid: 10, dshPid: 11, daemonPid: 20 + generation, generation }),
    pin: () => ({ supervisor: 'birth1', dsh: 'birth2' }),
    health: async () => ({ identity: JSON.parse(readFileSync(join(target, 'apps/daemon/dist/main.js'), 'utf8')) }),
    request: async (body?: { action: string; token?: string }) => {
      if (body?.action === 'begin') { token = 'lease'; begins++; }
      if (body?.action === 'cancel') { expect(body.token).toBe(token); token = undefined; }
      return { state: token ? 'ready' : 'accepting', scope: 'turnwire-managed', token, busy: token ? 0 : (++idleReads < 2 ? 1 : 0), inFlight: 0 };
    },
    signal: () => { signals++; generation++; },
    frontend: async () => {},
    remote: async () => ({ mode: 'temporary', provider: 'cloudflare-named', health: { relayRegistration: 'ready', tunnelProcess: 'ready' } }),
  };
  return { root, source, target, state, old, next, control, counts: () => ({ signals, begins, token }),
    preflight: async (dir: string) => JSON.parse(readFileSync(join(dir, 'main.js'), 'utf8')) };
}
describe('coordinated operator publication', () => {
  it('dry-run verifies both contracts without acquiring maintenance or changing target', async () => {
    const f = fixture();
    try {
      const result = await publishCoordinated({ ...f, log: () => {} });
      expect(result.dryRun).toBe(true);
      expect(f.counts()).toEqual({ signals: 0, begins: 0, token: undefined });
      expect(await f.control.health()).toEqual({ identity: f.old });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it('publishes a changed contract only under owned idle maintenance and retains old assets', async () => {
    const f = fixture();
    try {
      await publishCoordinated({ ...f, apply: true, sleep: async () => {}, log: () => {} });
      expect(f.counts()).toEqual({ signals: 1, begins: 1, token: undefined });
      expect(await f.control.health()).toEqual({ identity: f.next });
      expect(readFileSync(join(f.target, 'apps/remote-web/dist/index.html'), 'utf8')).toBe('new');
      expect(existsSync(join(f.target, 'apps/remote-web/dist/assets/old.js'))).toBe(true);
      expect(existsSync(join(f.state, 'coordinated.pending.json'))).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it('rolls both entry points back after publication verification failure, retaining the lease and journal', async () => {
    const f = fixture(); let checks = 0;
    f.control.frontend = async () => { if (++checks === 2) throw Error('injected served Web mismatch'); };
    try {
      await expect(publishCoordinated({ ...f, apply: true, sleep: async () => {}, log: () => {} })).rejects.toThrow('injected');
      expect(f.counts()).toEqual({ signals: 2, begins: 1, token: 'lease' });
      expect(await f.control.health()).toEqual({ identity: f.old });
      expect(readFileSync(join(f.target, 'apps/remote-web/dist/index.html'), 'utf8')).toBe('old');
      expect(JSON.parse(readFileSync(join(f.state, 'coordinated.pending.json'), 'utf8')).phase).toBe('rollback-verified-maintenance-held');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it('never acquires while managed activity remains busy', async () => {
    const f = fixture();
    f.control.request = async () => ({ state: 'accepting', scope: 'turnwire-managed', token: undefined, busy: 1, inFlight: 0 });
    try {
      await expect(publishCoordinated({ ...f, apply: true, waitMs: 1, pollMs: 1, log: () => {} })).rejects.toThrow('timed out');
      expect(f.counts().signals).toBe(0);
      expect(await f.control.health()).toEqual({ identity: f.old });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
