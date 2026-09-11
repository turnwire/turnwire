import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hermeticEnv } from './helpers/hermetic-env.mjs';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const keys = ['TURNWIRE_HOME','TURNWIRE_CONFIG_HOME','TURNWIRE_DATA_HOME','TURNWIRE_CACHE_HOME','DSH_HOME','DSH_ENV_FILE','DSH_ENTRY','TURNWIRE_NODE','TURNWIRE_UNITS_DIR'];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'turnwire-paths-')); roots.push(root);
  await mkdir(join(root, 'scripts')); await mkdir(join(root, 'home')); await mkdir(join(root, 'mock'));
  for (const name of ['host-paths.sh','install-host-service.mjs']) await copyFile(resolve('scripts', name), join(root, 'scripts', name));
  const env = hermeticEnv(root, { PATH: `${root}/mock:/usr/bin:/bin` });
  const paths = (extra: Record<string,string> = {}) => {
    const result = spawnSync('/bin/bash', ['-c', 'source "$1/scripts/host-paths.sh"; turnwire_resolve_paths "$1"; shift; for key; do printf "%s\\0" "${!key}"; done','paths',root,...keys], { env: {...env,...extra}, encoding:'utf8' });
    expect(result.status,result.stderr).toBe(0);
    return Object.fromEntries(keys.map((key,i) => [key,result.stdout.split('\0')[i]]));
  };
  return {root,env,paths};
}
it('resolves fresh XDG defaults and ignores relative or empty XDG values', async () => {
  const f = await fixture(); const p = f.paths({XDG_CONFIG_HOME:'relative',XDG_STATE_HOME:'',XDG_DATA_HOME:'relative',XDG_CACHE_HOME:'relative'});
  expect(p.TURNWIRE_HOME).toBe(`${f.env.HOME}/.local/state/turnwire`);
  expect(p.DSH_HOME).toBe(`${p.TURNWIRE_HOME}/dsh`);
  expect(p.DSH_ENV_FILE).toBe(`${f.env.HOME}/.config/turnwire/dsh.env.json`);
  expect(p.TURNWIRE_NODE).toBe(`${f.env.HOME}/.local/share/turnwire/runtime/node/bin/node`);
  expect(p.TURNWIRE_CACHE_HOME).toBe(`${f.env.HOME}/.cache/turnwire`);
});
it.each(['state','runtime','dsh-state','config/dsh.env.json'])('preserves the entire legacy layout with marker %s',async marker => {
  const f=await fixture(); await mkdir(join(f.root,marker),{recursive:true}); const p=f.paths({XDG_DATA_HOME:`${f.root}/xdg`});
  expect(p.TURNWIRE_HOME).toBe(`${f.root}/state`); expect(p.TURNWIRE_DATA_HOME).toBe(f.root);
  expect(p.DSH_ENV_FILE).toBe(`${f.root}/config/dsh.env.json`); expect(p.DSH_HOME).toBe(`${f.root}/dsh-state`);
});
it('preserves explicit home and per-kind overrides and standalone legacy home',async () => {
  const f=await fixture(); let p=f.paths({TURNWIRE_HOME:`${f.root}/custom`,DSH_ENTRY:`${f.root}/external.js`,DSH_ENV_FILE:`${f.root}/key.json`});
  expect(p.TURNWIRE_CONFIG_HOME).toBe(`${f.root}/custom`); expect(p.TURNWIRE_DATA_HOME).toBe(`${f.root}/custom`);
  expect(p.DSH_ENTRY).toBe(`${f.root}/external.js`); expect(p.DSH_ENV_FILE).toBe(`${f.root}/key.json`);
  await mkdir(`${f.env.HOME}/.turnwire`); p=f.paths(); expect(p.TURNWIRE_HOME).toBe(`${f.env.HOME}/.turnwire`);
});
it('writes quoted XDG unit and launcher with resolved environment without leaking credentials',async () => {
  const f=await fixture(); const extra={XDG_CONFIG_HOME:`${f.root}/config space`,XDG_STATE_HOME:`${f.root}/state space`,XDG_DATA_HOME:`${f.root}/data space`,XDG_CACHE_HOME:`${f.root}/cache space`}; const p=f.paths(extra);
  for(const file of [p.TURNWIRE_NODE,p.DSH_ENTRY,p.DSH_ENV_FILE,`${f.root}/apps/daemon/dist/host-service.mjs`]) { await mkdir(resolve(file!,'..'),{recursive:true}); await writeFile(file!,''); }
  await writeFile(`${f.root}/mock/systemctl`, '#!/bin/sh\n[ -z "${TURNWIRE_HARNESS_DEEPSEEK_API_KEY-}" ] || exit 99\nprintf "%s\\n" "$*" >> "$HOME/calls"\n',{mode:0o755});
  const result=spawnSync(process.execPath,[`${f.root}/scripts/install-host-service.mjs`,f.root],{env:{...f.env,...extra,TURNWIRE_HARNESS_DEEPSEEK_API_KEY:'private'},encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0); const unit=await readFile(`${p.TURNWIRE_UNITS_DIR}/turnwire-host.service`,'utf8');
  for(const key of keys.slice(0,7)) expect(unit).toContain(`Environment="${key}=${p[key]}"`);
  expect(unit).toContain(`ExecStart="${p.TURNWIRE_NODE}"`); expect(unit).not.toContain('private');
  expect(await readFile(`${f.root}/bin/turnwire`,'utf8')).toContain(p.TURNWIRE_NODE);
  expect(await readFile(`${f.env.HOME}/calls`,'utf8')).toContain('--user enable --now turnwire-host.service');
  const again=spawnSync(process.execPath,[`${f.root}/scripts/install-host-service.mjs`,f.root],{env:{...f.env,...extra},encoding:'utf8'}); expect(again.status).not.toBe(0); expect(await readFile(`${p.TURNWIRE_UNITS_DIR}/turnwire-host.service`,'utf8')).toBe(unit);
});
it('refuses a conflicting HOME unit even with custom XDG config',async () => {
  const f=await fixture(); const dir=`${f.env.HOME}/.config/systemd/user`; await mkdir(dir,{recursive:true}); await writeFile(`${dir}/turnwire-host.service`,'existing');
  const result=spawnSync(process.execPath,[`${f.root}/scripts/install-host-service.mjs`,f.root],{env:{...f.env,XDG_CONFIG_HOME:`${f.root}/xdg`},encoding:'utf8'});
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('refusing to overwrite'); expect(await readFile(`${dir}/turnwire-host.service`,'utf8')).toBe('existing');
});
