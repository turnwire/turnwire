import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, validateStorageFile } from '../packages/core/src/store.js';
import { hermeticEnv } from './helpers/hermetic-env.mjs';
// @ts-expect-error standalone developer script
import { deployDaemon, stageDaemon, preflightDaemon } from '../scripts/host-reload-daemon.mjs';
const oldIdentity = { kind: 'built', buildId: 'a'.repeat(64), contractDigest: 'c'.repeat(64) };
const newIdentity = { kind: 'built', buildId: 'b'.repeat(64), contractDigest: 'd'.repeat(64) };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'daemon-deploy-')); roots.push(root); execFileSync('git', ['init', '-q', root]);
 mkdirSync(join(root, 'apps/daemon/dist'), { recursive: true }); mkdirSync(join(root, 'apps/daemon/src'));
 writeFileSync(join(root, 'apps/daemon/src/main.ts'), 'source'); writeFileSync(join(root, 'apps/daemon/dist/main.js'), 'old');
 const events: string[] = []; let state = 'accepting'; let generation = 1; let signals = 0;
 const control = {
  record: () => ({ version: 1, ready: true, supervisorPid: 10, dshPid: 11, daemonPid: 20 + generation, generation, checkedAt: Date.now() }),
  health: async () => { events.push('health'); return { identity: signals ? newIdentity : oldIdentity }; },
  request: async (body?: { action: string; token?: string }) => {
   if (body?.action === 'begin') { events.push('begin'); state = 'ready'; }
   if (body?.action === 'cancel') { expect(body.token).toBe('lease-secret'); events.push('cancel'); state = 'accepting'; }
   return { state, scope: 'turnwire-managed', token: state === 'accepting' ? undefined : 'lease-secret', inFlight: 0, busy: 0 };
  },
  signal: () => { signals++; events.push('signal'); generation++; },
 };
 const build = async (stage: string) => { events.push('build'); expect(readFileSync(join(root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('old'); writeFileSync(join(stage, 'main.js'), 'new'); };
 return { root, events, control, options: { stateDir: join(root, 'reload-state'), control, build, preflight: async () => { events.push('preflight'); return newIdentity; }, pollMs: 1, timeoutMs: 10, log: () => {} }, signals: () => signals };
}
it('staging bundles workspace wire source instead of stale package dist', async () => {
 const f = fixture();
 mkdirSync(join(f.root, 'packages/wire/src'), { recursive: true }); mkdirSync(join(f.root, 'packages/wire/dist'));
 writeFileSync(join(f.root, 'packages/wire/package.json'), '{"name":"@turnwire/wire"}');
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
 expect(f.events.indexOf('preflight')).toBeLessThan(f.events.indexOf('begin'));
 expect(f.events.lastIndexOf('preflight')).toBeLessThan(f.events.indexOf('signal'));
 expect(f.events.filter(event => event === 'preflight')).toHaveLength(2);
 expect(f.events.indexOf('signal')).toBeLessThan(f.events.indexOf('cancel'));
 expect(f.signals()).toBe(1); expect(readFileSync(join(f.root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('new');
 expect(existsSync(join(f.root, 'reload-state/reload.daemon.pending.json'))).toBe(false);
 expect(readFileSync(join(f.root, 'reload-state/reload.daemon.json'), 'utf8')).not.toContain('lease-secret');
});
it('rejects a daemon contract upgrade while an incompatible or unidentified frontend is served', async () => {
 const f = fixture(); const dist = join(f.root, 'apps/remote-web/dist'); mkdirSync(dist, { recursive: true }); writeFileSync(join(dist, 'index.html'), 'old frontend');
 await expect(deployDaemon(f.root, f.options)).rejects.toThrow('no required contract');
 writeFileSync(join(dist, 'turnwire-build.json'), JSON.stringify({ requiredContract: oldIdentity.contractDigest }));
 await expect(deployDaemon(f.root, f.options)).rejects.toThrow('required contract');
 expect(f.signals()).toBe(0); expect(f.events).not.toContain('begin');
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
 expect(statSync(join(f.root, 'reload-state/reload.daemon.pending.json')).mode & 0o777).toBe(0o600);
 await expect(deployDaemon(f.root, f.options)).rejects.toThrow('unfinished');
});
it('failed post-install health rolls bytes back but retains gate and recovery journal', async () => {
 const f = fixture(); f.control.health = async () => { if (f.signals()) throw Error('offline'); return { identity: oldIdentity }; };
 await expect(deployDaemon(f.root, f.options)).rejects.toThrow('timed out');
 expect(f.signals()).toBe(2); expect(f.events).not.toContain('cancel');
 expect(readFileSync(join(f.root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('old');
 expect(JSON.parse(readFileSync(join(f.root, 'reload-state/reload.daemon.pending.json'), 'utf8')).phase).toBe('rolled-back-manual-recovery');
 expect(existsSync(join(f.root, 'reload-state/reload.daemon.json'))).toBe(false);
});
it('old process cannot masquerade as staged build after generation changes', async () => {
 const f = fixture(); f.control.health = async () => ({ identity: oldIdentity });
 await expect(deployDaemon(f.root, f.options)).rejects.toThrow('timed out');
 expect(f.events).not.toContain('cancel'); expect(f.signals()).toBe(2);
 expect(readFileSync(join(f.root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('old');
});
it('legacy 0/0 database is rejected by the actual staged artifact without modifying host state', async () => {
 const f = fixture(); const host = join(f.root, 'host'); mkdirSync(host);
 const database = join(host, 'state.db'); const db = new DatabaseSync(database);
 db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
 db.prepare('INSERT INTO sessions VALUES (?,?)').run('private-session', 'private-session-body'); db.close();
 const before = readFileSync(database); const stat = statSync(database);
 const env = hermeticEnv(f.root, { TURNWIRE_STATE_HOME: host, TURNWIRE_CONFIG_HOME: join(f.root, 'config') });

 const root = resolve('.');
 await expect(deployDaemon(f.root, { ...f.options, build: (stage: string) => stageDaemon(root, stage), preflight: async (stage: string) => {
  try { await preflightDaemon(root, stage, env); }
  catch (error) {
   // Normal startup must reject the same legacy database before leaving a PID lock.
   expect(() => execFileSync(process.execPath, [join(stage, 'main.js')], { env, stdio: 'pipe' })).toThrow();
   throw error;
  }
 } })).rejects.toThrow('storage preflight failed');
 expect(readFileSync(database)).toEqual(before); expect(statSync(database).mode).toBe(stat.mode); expect(statSync(database).mtimeMs).toBe(stat.mtimeMs);
 expect(existsSync(`${database}-wal`)).toBe(false); expect(existsSync(`${database}-shm`)).toBe(false);
 expect(existsSync(join(host, 'daemon.pid'))).toBe(false); expect(existsSync(env.TURNWIRE_CONFIG_HOME!)).toBe(false);
 expect(f.events).toEqual([]); expect(f.signals()).toBe(0);
 expect(readFileSync(join(f.root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('old');
 expect(existsSync(join(f.root, 'reload-state/reload.daemon.pending.json'))).toBe(false);
});
it('actual staged artifact validates current storage without acquiring daemon lock or writing config', async () => {
 const f = fixture(); const host = join(f.root, 'host'); mkdirSync(host);
 const database = join(host, 'state.db'); new Store(database).close(); const before = readFileSync(database);
 const stage = join(f.root, 'stage'); mkdirSync(stage); const root = resolve('.'); await stageDaemon(root, stage);
 const env = hermeticEnv(f.root, { TURNWIRE_STATE_HOME: host, TURNWIRE_CONFIG_HOME: join(f.root, 'config') });
 await preflightDaemon(root, stage, env);
 expect(readFileSync(database)).toEqual(before); expect(existsSync(join(host, 'daemon.pid'))).toBe(false); expect(existsSync(env.TURNWIRE_CONFIG_HOME!)).toBe(false);
});
it('read-only validator accepts current storage and rejects malformed records without exposing them', () => {
 const f = fixture(); const path = join(f.root, 'state.db'); const store = new Store(path); store.close();
 const before = readFileSync(path); expect(validateStorageFile(path)).toBe('current'); expect(readFileSync(path)).toEqual(before);
 const db = new DatabaseSync(path); db.prepare('INSERT INTO sessions VALUES (?,?)').run('secret', JSON.stringify({ title: 'private-title' })); db.close();
 const invalid = readFileSync(path);
 expect(() => validateStorageFile(path)).toThrow('invalid database or persisted session/device record');
 try { validateStorageFile(path); } catch (error) { expect(String(error)).not.toMatch(/private-title|secret/); }
 expect(readFileSync(path)).toEqual(invalid);
 const absent = join(f.root, 'absent.db'); expect(() => validateStorageFile(absent)).toThrow('cannot read database'); expect(existsSync(absent)).toBe(false);
});
it('preflight after drain fails closed before artifact replacement or daemon stop', async () => {
 const f = fixture(); let checks = 0;
 await expect(deployDaemon(f.root, { ...f.options, preflight: async () => { if (++checks === 2) throw Error('changed database'); return newIdentity; } })).rejects.toThrow('changed database');
 expect(f.events).toContain('begin'); expect(f.events).not.toContain('cancel'); expect(f.signals()).toBe(0);
 expect(readFileSync(join(f.root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('old');
 expect(JSON.parse(readFileSync(join(f.root, 'reload-state/reload.daemon.pending.json'), 'utf8')).phase).toBe('draining');
});
it('actual artifact startup failure is redacted and rejected before maintenance', async () => {
 const f = fixture();
 await expect(deployDaemon(f.root, { ...f.options, build: async (stage: string) => { writeFileSync(join(stage, 'main.js'), 'throw Error("PRIVATE_STARTUP_DATA")'); }, preflight: (stage: string) => preflightDaemon(f.root, stage) })).rejects.toThrow('staged daemon storage preflight failed; no installation or signal was performed');
 expect(f.events).toEqual([]); expect(f.signals()).toBe(0); expect(readFileSync(join(f.root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('old');
});
it('replacement startup death with unreachable management leaves installed bytes and gate for manual recovery', async () => {
 const f = fixture(); const request = f.control.request; const record = f.control.record; const signal = f.control.signal;
 f.control.signal = () => { signal(); expect(() => execFileSync(process.execPath, [join(f.root, 'apps/daemon/dist/main.js')], { stdio: 'pipe' })).toThrow(); };
 f.control.record = () => { if (f.signals()) throw Error('daemon never became ready'); return record(); };
 f.control.request = async body => { if (f.signals()) throw Error('management unreachable'); return request(body); };
 await expect(deployDaemon(f.root, f.options)).rejects.toThrow('timed out');
 expect(f.signals()).toBe(1); expect(f.events).not.toContain('cancel');
 expect(readFileSync(join(f.root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('new');
 const journal = JSON.parse(readFileSync(join(f.root, 'reload-state/reload.daemon.pending.json'), 'utf8'));
 expect(journal.phase).toBe('installed-manual-recovery'); expect(readFileSync(join(journal.stage, 'rollback.js'), 'utf8')).toBe('old');
});
it('unknown release response never rolls back or signals an accepting host', async () => {
 const f = fixture(); const request = f.control.request;
 f.control.request = async body => { const status = await request(body); if (body?.action === 'cancel') throw Error('lost response'); return status; };
 await expect(deployDaemon(f.root, f.options)).rejects.toThrow('lost response');
 expect(f.signals()).toBe(1); expect(readFileSync(join(f.root, 'apps/daemon/dist/main.js'), 'utf8')).toBe('new');
 expect(existsSync(join(f.root, 'reload-state/reload.daemon.pending.json'))).toBe(true);
});
