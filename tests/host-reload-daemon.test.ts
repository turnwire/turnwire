import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error standalone developer script
import { deployDaemon, stageDaemon } from '../scripts/host-reload-daemon.mjs';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'daemon-deploy-')); roots.push(root); execFileSync('git', ['init', '-q', root]);
 mkdirSync(join(root, 'apps/daemon/dist'), { recursive: true }); mkdirSync(join(root, 'apps/daemon/src'));
 writeFileSync(join(root, 'apps/daemon/src/main.ts'), 'source'); writeFileSync(join(root, 'apps/daemon/dist/main.js'), 'old');
 const events: string[] = []; let state = 'accepting'; let generation = 1; let signals = 0;
 const control = {
  record: () => ({ version: 1, ready: true, supervisorPid: 10, dshPid: 11, daemonPid: 20 + generation, generation, checkedAt: Date.now() }),
  health: async () => { events.push('health'); },
  request: async (body?: { action: string; token?: string }) => {
   if (body?.action === 'begin') { events.push('begin'); state = 'ready'; }
   if (body?.action === 'cancel') { expect(body.token).toBe('lease-secret'); events.push('cancel'); state = 'accepting'; }
   return { state, scope: 'turnwire-managed', token: state === 'accepting' ? undefined : 'lease-secret', inFlight: 0, busy: 0 };
  },
  signal: () => { signals++; events.push('signal'); generation++; },
 };
 const build = async (stage: string) => { events.push('build'); expect(readFileSync(join(root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('old'); writeFileSync(join(stage, 'main.js'), 'new'); };
 return { root, events, control, options: { control, build, pollMs: 1, timeoutMs: 10, log: () => {} }, signals: () => signals };
}
it('staging bundles workspace wire source instead of stale package dist', async () => {
 const f = fixture();
 mkdirSync(join(f.root, 'packages/wire/src'), { recursive: true }); mkdirSync(join(f.root, 'packages/wire/dist'));
 writeFileSync(join(f.root, 'packages/wire/src/index.ts'), 'export const value = "fresh-wire-source";');
 writeFileSync(join(f.root, 'packages/wire/dist/index.js'), 'export const value = "stale-wire-dist";');
 writeFileSync(join(f.root, 'apps/daemon/src/main.ts'), 'import {value} from "@turnwire/wire"; console.log(value);');
 const stage = join(f.root, 'staged'); await stageDaemon(f.root, stage);
 const output = readFileSync(join(stage, 'main.js'), 'utf8');
 expect(output).toContain('fresh-wire-source'); expect(output).not.toContain('stale-wire-dist');
 expect(output).not.toMatch(/from ["']@turnwire\//);
 expect(readFileSync(join(f.root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('old');
});
it('builds staged before acquiring lease; signals daemon only then verifies and releases', async () => {
 const f = fixture(); await deployDaemon(f.root, f.options);
 expect(f.events[0]).toBe('build'); expect(f.events.indexOf('begin')).toBeLessThan(f.events.indexOf('signal'));
 expect(f.events.indexOf('signal')).toBeLessThan(f.events.indexOf('cancel'));
 expect(f.signals()).toBe(1); expect(readFileSync(join(f.root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('new');
 expect(existsSync(join(f.root, '.turnwire/reload.daemon.pending.json'))).toBe(false);
 expect(readFileSync(join(f.root, '.turnwire/reload.daemon.json'), 'utf8')).not.toContain('lease-secret');
});
it('dry-run builds staged without reading live control or entering maintenance', async () => {
 const f = fixture(); f.control.record = () => { throw Error('must not inspect live control'); };
 await deployDaemon(f.root, { ...f.options, dryRun: true });
 expect(f.events).toEqual(['build']); expect(f.signals()).toBe(0);
 expect(readFileSync(join(f.root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('old');
});
it('build failure never acquires maintenance or touches current artifact', async () => {
 const f = fixture(); await expect(deployDaemon(f.root, { ...f.options, build: () => { throw Error('build'); } })).rejects.toThrow('build');
 expect(f.events).toEqual([]); expect(f.signals()).toBe(0); expect(readFileSync(join(f.root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('old');
});
it('unknown managed activity times out with private durable journal and no install', async () => {
 const f = fixture(); const request = f.control.request;
 f.control.request = async body => ({ ...await request(body), busy: null as unknown as number });
 await expect(deployDaemon(f.root, f.options)).rejects.toThrow('timed out');
 expect(f.signals()).toBe(0); expect(f.events).not.toContain('cancel');
 expect(statSync(join(f.root, '.turnwire/reload.daemon.pending.json')).mode & 0o777).toBe(0o600);
 await expect(deployDaemon(f.root, f.options)).rejects.toThrow('unfinished');
});
it('failed post-install health rolls bytes back but retains gate and recovery journal', async () => {
 const f = fixture(); f.control.health = async () => { if (f.signals()) throw Error('offline'); };
 await expect(deployDaemon(f.root, f.options)).rejects.toThrow('timed out');
 expect(f.signals()).toBe(2); expect(f.events).not.toContain('cancel');
 expect(readFileSync(join(f.root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('old');
 expect(JSON.parse(readFileSync(join(f.root, '.turnwire/reload.daemon.pending.json'), 'utf8')).phase).toBe('rolled-back-manual-recovery');
 expect(existsSync(join(f.root, '.turnwire/reload.daemon.json'))).toBe(false);
});
it('unknown release response never rolls back or signals an accepting host', async () => {
 const f = fixture(); const request = f.control.request;
 f.control.request = async body => { const status = await request(body); if (body?.action === 'cancel') throw Error('lost response'); return status; };
 await expect(deployDaemon(f.root, f.options)).rejects.toThrow('lost response');
 expect(f.signals()).toBe(1); expect(readFileSync(join(f.root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('new');
 expect(existsSync(join(f.root, '.turnwire/reload.daemon.pending.json'))).toBe(true);
});
