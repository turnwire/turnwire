import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanEnvironment, parseLaunch, privateJson, launchUrl, findConnection, ensureKey, doctor, runChild } from '../apps/launcher/main.mjs';

describe('npm launcher bootstrap', () => {
  it('strips ambient credentials and Node injection but preserves canonical directories', () => {
    expect(cleanEnvironment({ HOME: '/tmp/home', PATH: '/bin', NODE_OPTIONS: '--require bad', OPENAI_API_KEY: 'secret', TURNWIRE_HARNESS_DEEPSEEK_API_KEY: 'secret', TURNWIRE_DSH_URL: 'secret', TURNWIRE_CONFIG_HOME: '/tmp/config', TURNWIRE_DSH_PORT: '45678' })).toEqual({ HOME: '/tmp/home', PATH: '/bin', TURNWIRE_CONFIG_HOME: '/tmp/config', TURNWIRE_DSH_PORT: '45678' });
  });
  it('parses explicit install, browser and port options without shell syntax', () => {
    expect(parseLaunch(['--yes','--port','9922','--no-open'])).toEqual({ yes: true, port: '9922', open: false });
    for (const args of [['--port','0'],['--port','1;echo'],['--unknown']]) expect(() => parseLaunch(args)).toThrow();
  });
  it('requires explicit authenticated DSH and refuses insecure remote URLs', () => {
    expect(launchUrl('http://localhost:3080','secret')).toBe('http://localhost:3080/?token=secret');
    expect(() => launchUrl('http://remote.example','secret')).toThrow();
    expect(() => launchUrl('http://localhost:3080')).toThrow();
    expect(() => launchUrl('https://user:password@example.com','secret')).toThrow();
  });
  it('reads private explicit connection only and refuses broad file permissions', async () => {
    const root = await mkdtemp(join(tmpdir(),'turnwire-launcher-'));
    try {
      const file = join(root,'dsh-connection.json');
      expect(await findConnection({}, {config:root})).toBeUndefined();
      await writeFile(file,JSON.stringify({url:'http://localhost:3080',token:'fixture'}),{mode:0o600});
      expect(await findConnection({}, {config:root})).toContain('token=fixture');
      const bad = join(root,'public.json'); await writeFile(bad,'{}',{mode:0o644}); await chmod(bad,0o644);
      await expect(privateJson(bad)).rejects.toThrow('private');
      await expect(findConnection({TURNWIRE_DSH_TOKEN:'fixture'}, {config:root})).rejects.toThrow('requires');
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it('never overwrites existing private credentials and creates new secrets 0600', async () => {
    const root = await mkdtemp(join(tmpdir(),'turnwire-launcher-'));
    try {
      const paths = {dshEnvFile:join(root,'config','dsh.env.json')};
      await ensureKey(paths,{},async()=> 'fixture-key');
      expect((await stat(paths.dshEnvFile)).mode & 0o777).toBe(0o600);
      const original = await readFile(paths.dshEnvFile,'utf8');
      await ensureKey(paths,{},async()=> {throw Error('must not prompt');});
      expect(await readFile(paths.dshEnvFile,'utf8')).toBe(original);
      expect(await ensureKey(paths,{TURNWIRE_HARNESS_DEEPSEEK_API_KEY:'temporary'})).toBe('temporary');
      expect(await readFile(paths.dshEnvFile,'utf8')).toBe(original);
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it('doctor does not create directories or require credentials/network', async () => {
    const root = await mkdtemp(join(tmpdir(),'turnwire-launcher-'));
    try {
      const report = await doctor({env:{HOME:root},platform:'darwin',node:'22.13.0'});
      expect(report.supported).toBe(true); expect(report.foregroundOnly).toBe(true); expect(report.dshInstalled).toBe(false);
      await expect(stat(join(root,'.config'))).rejects.toMatchObject({code:'ENOENT'});
      expect((await doctor({env:{HOME:root},platform:'win32',node:'22.13.0'})).supported).toBe(false);
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it('waits for owned child exit and preserves failure code', async () => {
    expect(await runChild(process.execPath,['-e','process.exit(7)'],{env:cleanEnvironment(),quiet:true})).toBe(7);
  });
});
