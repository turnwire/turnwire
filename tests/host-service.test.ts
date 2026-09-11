import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hermeticEnv } from './helpers/hermetic-env.mjs';

const key = 'fixture-model-secret';
const gateway = 'fixture-gateway-secret';
const token = 'fixture-launch-secret';
const dshScript = `import {writeFileSync,appendFileSync} from 'node:fs';
import {createServer} from 'node:http';
createServer(async(req,res)=>{
 if(req.url==='/?token=${token}') {res.writeHead(303,{'set-cookie':'fixture=authenticated; HttpOnly',location:'/'});res.end();return;}
 if(req.url==='/api/session/list' && req.headers.cookie==='fixture=authenticated') {
 let body='';for await(const part of req)body+=part;const value=JSON.parse(body);
 res.setHeader('content-type','application/json');res.end(JSON.stringify({type:'server-response',rpcId:value.rpcId,result:{ok:true,value:{items:[]}}}));return;
 }res.writeHead(401);res.end();
}).listen(43081,'127.0.0.1');
writeFileSync('dsh.json',JSON.stringify({pid:process.pid,env:process.env,argv:process.argv}));
console.log('dsh web: http://127.0.0.1:43081/?token=${token}');
console.log('credential diagnostic ${key} ${gateway}');
process.on('SIGTERM',()=>{appendFileSync('stops','dsh\\n');process.exit(0)});setInterval(()=>{},1000);`;
const daemonScript = `import {writeFileSync,appendFileSync} from 'node:fs';
appendFileSync('starts',JSON.stringify({pid:process.pid,env:process.env,argv:process.argv,time:Date.now()})+'\\n');
console.log('daemon endpoint '+process.env.TURNWIRE_DSH_URL);
process.on('SIGTERM',()=>{appendFileSync('stops','daemon\\n');process.exit(0)});setInterval(()=>{},1000);`;
async function fixture(dsh = dshScript, daemon = daemonScript, overrides: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'turnwire-host-service-'));
  await mkdir(join(root, 'config'));
  await writeFile(join(root, 'config/dsh.env.json'), JSON.stringify({ TURNWIRE_HARNESS_DEEPSEEK_API_KEY: key, CUSTOM_PROVIDER_KEY: gateway, TURNWIRE_RELAY_TOKEN: 'file-relay-secret', TURNWIRE_DSH_TOKEN: 'file-launch-secret', TURNWIRE_NOT_A_STRING: { nested: true } }), { mode: 0o600 });
  await writeFile(join(root, 'dsh.mjs'), dsh);
  await writeFile(join(root, 'daemon.mjs'), daemon);
  // Never spread process.env: exported DSH/HOME/XDG/ports/provider values cannot escape the fixture.
  const env = hermeticEnv(root, { TURNWIRE_INSTALL_DIR: root, TURNWIRE_HOME: join(root, 'state'), TURNWIRE_CONFIG_HOME: join(root, 'config'), TURNWIRE_DATA_HOME: join(root, 'data'), TURNWIRE_CACHE_HOME: join(root, 'cache'), TURNWIRE_DSH_HOME: join(root, 'dsh-state'), TURNWIRE_DSH_ENV_FILE: join(root, 'config/dsh.env.json'), TURNWIRE_DSH_PORT: '43081', TURNWIRE_PORT: '0', TURNWIRE_DSH_ENTRY: join(root, 'dsh.mjs'), TURNWIRE_DAEMON_ENTRY: join(root, 'daemon.mjs'), TURNWIRE_HOST_START_TIMEOUT_MS: '2000', TURNWIRE_HOST_RESTART_DELAY_MS: '30', TURNWIRE_HOST_RESTART_MAX_DELAY_MS: '60', TURNWIRE_HOST_STABLE_MS: '60000', ...overrides });
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('apps/daemon/src/host-service.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', chunk => { logs += String(chunk); }); child.stderr.on('data', chunk => { logs += String(chunk); });
  const stopped = new Promise<number | null>(done => child.once('exit', done));
  const starts = async () => { try { return (await readFile(join(root, 'starts'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; } };
  return { root, child, stopped, starts, logs: () => logs, async cleanup() { child.kill('SIGTERM'); await stopped; await rm(root, { recursive: true, force: true }); } };
}

it('isolates ambient and custom provider credentials, keeps operational paths, redacts tokens, and stops in dependency order', async () => {
  const f = await fixture(undefined, undefined, { ARBITRARY_PROVIDER_PASSWORD: 'ambient-secret', OPENAI_API_KEY: 'ambient-openai', TURNWIRE_HARNESS_OTHER_KEY: 'ambient-other', TURNWIRE_RELAY_TOKEN: 'ambient-relay', TURNWIRE_ALLOWED_ORIGINS: 'https://fixture.invalid', TURNWIRE_SSH_PATH: '/fixture/ssh' });
  try {
    await expect.poll(async () => (await f.starts()).length).toBe(1);
    const recordPath = join(f.root, 'state/run/host-readiness.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record.ready).toBe(true); expect(record.supervisorPid).toBe(f.child.pid);
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(record)).not.toContain(token); expect(JSON.stringify(record)).not.toContain(key);
    const daemon = (await f.starts())[0];
    const dsh = JSON.parse(await readFile(join(f.root, 'dsh.json'), 'utf8'));
    for (const name of ['ARBITRARY_PROVIDER_PASSWORD', 'OPENAI_API_KEY', 'TURNWIRE_HARNESS_OTHER_KEY', 'TURNWIRE_RELAY_TOKEN', 'TURNWIRE_DSH_TOKEN', 'TURNWIRE_NOT_A_STRING']) {
      expect(daemon.env[name]).toBeUndefined(); expect(dsh.env[name]).toBeUndefined();
    }
    expect(daemon.env.TURNWIRE_HARNESS_DEEPSEEK_API_KEY).toBeUndefined(); expect(daemon.env.CUSTOM_PROVIDER_KEY).toBeUndefined();
    expect(dsh.env.TURNWIRE_HARNESS_DEEPSEEK_API_KEY).toBe(key); expect(dsh.env.CUSTOM_PROVIDER_KEY).toBe(gateway);
    expect(dsh.env.DSH_HOME).toBe(join(f.root, 'dsh-state'));
    expect(daemon.env.TURNWIRE_DSH_URL).toBe(`http://127.0.0.1:43081/?token=${token}`);
    expect(daemon.env.TURNWIRE_RUNTIME).toBe('dsh'); expect(daemon.env.TURNWIRE_PORT).toBe('0');
    expect(daemon.env.TURNWIRE_ALLOWED_ORIGINS).toBe('https://fixture.invalid'); expect(daemon.env.TURNWIRE_SSH_PATH).toBe('/fixture/ssh');
    for (const suffix of ['HOME', 'CONFIG_HOME', 'DATA_HOME', 'CACHE_HOME']) expect(daemon.env[`TURNWIRE_${suffix}`]).toMatch(f.root);
    expect(JSON.stringify([daemon.argv, dsh.argv])).not.toContain(token);
    f.child.kill('SIGTERM'); expect(await f.stopped).toBe(0);
    expect(await readFile(join(f.root, 'stops'), 'utf8')).toBe('daemon\ndsh\n');
    for (const secret of [key, token, gateway]) expect(f.logs()).not.toContain(secret);
  } finally { await f.cleanup(); }
});

it('restarts a crashed daemon without terminating healthy DSH', async () => {
  const f = await fixture();
  try {
    await expect.poll(async () => (await f.starts()).length).toBe(1);
    const dsh = JSON.parse(await readFile(join(f.root, 'dsh.json'), 'utf8'));
    process.kill((await f.starts())[0].pid, 'SIGKILL');
    await expect.poll(async () => (await f.starts()).length).toBe(2);
    expect((await f.starts())[1].pid).not.toBe((await f.starts())[0].pid);
    expect(process.kill(dsh.pid, 0)).toBe(true);
    await expect(readFile(join(f.root, 'stops'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

it('resumes a backoff restart after transient readiness loss without consuming more budget', async () => {
  const script = dshScript.replace("import {createServer}", "import {existsSync} from 'node:fs';\nimport {createServer}").replace(" if(req.url==='/?token=", " if(existsSync('unready')) {res.writeHead(503);res.end();return;}\n if(req.url==='/?token=");
  const f = await fixture(script, undefined, { TURNWIRE_HOST_RESTART_DELAY_MS: '1500', TURNWIRE_HOST_RESTART_MAX_DELAY_MS: '1500', TURNWIRE_HOST_RESTART_LIMIT: '1' });
  try {
    await expect.poll(async () => (await f.starts()).length).toBe(1);
    await writeFile(join(f.root, 'unready'), '');
    await expect.poll(async () => JSON.parse(await readFile(join(f.root, 'state/run/host-readiness.json'), 'utf8')).ready).toBe(false);
    process.kill((await f.starts())[0].pid, 'SIGKILL');
    await expect.poll(() => f.logs()).toContain('in 1500ms');
    // Wait past backoff through observable heartbeat rather than assuming the timer fired.
    const began = Date.now();
    await expect.poll(() => Date.now() - began, { timeout: 3000 }).toBeGreaterThan(1700);
    expect((await f.starts()).length).toBe(1);
    await rm(join(f.root, 'unready'));
    await expect.poll(async () => (await f.starts()).length, { timeout: 3000 }).toBe(2);
    expect(f.logs()).not.toContain('budget exhausted');
  } finally { await f.cleanup(); }
});

it('SIGUSR2 deliberately reloads only the daemon', async () => {
  const f = await fixture();
  try {
    await expect.poll(async () => (await f.starts()).length).toBe(1);
    const dsh = JSON.parse(await readFile(join(f.root, 'dsh.json'), 'utf8'));
    f.child.kill('SIGUSR2');
    await expect.poll(async () => (await f.starts()).length).toBe(2);
    expect(await readFile(join(f.root, 'stops'), 'utf8')).toBe('daemon\n');
    expect(process.kill(dsh.pid, 0)).toBe(true);
    expect((await f.starts())[1].env.TURNWIRE_DSH_URL).toBe((await f.starts())[0].env.TURNWIRE_DSH_URL);
  } finally { await f.cleanup(); }
});

it('bounds repeated daemon failures and allows explicit recovery without sacrificing DSH', async () => {
  const f = await fixture(undefined, daemonScript + '\nprocess.exit(2);', { TURNWIRE_HOST_RESTART_LIMIT: '2' });
  try {
    await expect.poll(() => f.logs()).toContain('restart budget exhausted');
    expect((await f.starts()).length).toBe(3);
    expect(f.logs()).toContain('in 30ms'); expect(f.logs()).toContain('in 60ms');
    expect(process.kill(JSON.parse(await readFile(join(f.root, 'dsh.json'), 'utf8')).pid, 0)).toBe(true);
    expect(f.child.exitCode).toBeNull();
    await writeFile(join(f.root, 'daemon.mjs'), daemonScript);
    f.child.kill('SIGUSR2');
    await expect.poll(async () => (await f.starts()).length).toBe(4);
  } finally { await f.cleanup(); }
});

it('DSH death stops the dependent daemon and exits for deliberate supervisor recovery', async () => {
  const f = await fixture();
  try {
    await expect.poll(async () => (await f.starts()).length).toBe(1);
    process.kill(JSON.parse(await readFile(join(f.root, 'dsh.json'), 'utf8')).pid, 'SIGKILL');
    expect(await f.stopped).toBe(1);
    expect(await readFile(join(f.root, 'stops'), 'utf8')).toBe('daemon\n');
    expect((await f.starts()).length).toBe(1);
  } finally { await f.cleanup(); }
});

it('fails promptly when DSH exits before readiness without starting the daemon', async () => {
  const f = await fixture('process.exit(2)');
  try { expect(await f.stopped).toBe(1); expect(await f.starts()).toEqual([]); }
  finally { await f.cleanup(); }
});

it('stdout alone cannot start the daemon', async () => {
  const f = await fixture(`console.log('dsh web: http://127.0.0.1:43081/?token=${token}');setInterval(()=>{},1000)`, undefined, { TURNWIRE_HOST_START_TIMEOUT_MS: '150' });
  try { expect(await f.stopped).toBe(1); expect(await f.starts()).toEqual([]); }
  finally { await f.cleanup(); }
});

it('stale launch authentication fails closed even with a reachable HTTP listener', async () => {
  const f = await fixture(dshScript.replace("req.url==='/?token=fixture-launch-secret'", "req.url==='/?token=other'"), undefined, { TURNWIRE_HOST_START_TIMEOUT_MS: '250' });
  try { expect(await f.stopped).toBe(1); expect(await f.starts()).toEqual([]); expect(f.logs()).not.toContain(token); }
  finally { await f.cleanup(); }
});

it('does not accept stderr or mismatched-port readiness and redacts malformed launch tokens', async () => {
  const f = await fixture(`console.error('dsh web: http://127.0.0.1:43081/?token=${token}');console.log('dsh web: http://127.0.0.1:43082/?token=${token}');setInterval(()=>{},1000)`, undefined, { TURNWIRE_HOST_START_TIMEOUT_MS: '100' });
  try { expect(await f.stopped).toBe(1); expect(await f.starts()).toEqual([]); expect(f.logs()).not.toContain(token); }
  finally { await f.cleanup(); }
});
