import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { LocalClient } from '@turnwire/sdk';
import { randomSecret } from '@turnwire/wire';
import { normalizeConfig, publicURL, shellQuote } from '../apps/deployer/src/config.js';
import { caddySite, mergeCaddy, renewHook, bootstrap } from '../apps/deployer/src/templates.js';
import { deploymentEnvironment, sshArguments, execute } from '../apps/deployer/src/ssh.js';
import { FileTransaction } from '../apps/deployer/src/transaction.js';
import { verifyRelease } from '../apps/deployer/src/installer.js';
import { DeploymentController } from '../apps/daemon/src/deployment.js';
import { RemoteController } from '../apps/daemon/src/remote-control.js';
import { startDaemonServer } from '../apps/daemon/src/server.js';
import { createProgram } from '../apps/cli/src/program.js';
import { deploymentMenu, runTui } from '../apps/cli/src/terminal.js';

const configuration={host:'203.0.113.20',sshUser:'deployer',publicAddress:'relay.example.com',connectAfterDeploy:false};
let cleanup:Array<()=>Promise<unknown>|void>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const fn of cleanup.reverse())await fn();cleanup=[];});
async function directory(){const path=await mkdtemp(join(tmpdir(),'turnwire-deploy-test-'));cleanup.push(()=>rm(path,{recursive:true,force:true}));return path;}

it('requires machine addresses/accounts as input and rejects shell, URL and path injection',()=>{
  const c=normalizeConfig(configuration);expect(c.host).toBe(configuration.host);expect(c.sshUser).toBe('deployer');
  expect(()=>normalizeConfig({})).toThrow();
  for(const patch of [{host:'-oProxyCommand=evil'},{host:'999.0.0.1'},{publicAddress:'https://user:password@relay.example.com'},{sshUser:'user;id'},{installDir:'/opt/../etc'},{installDir:'/etc'},{caddyfile:'/etc/$(command)'},{serviceUser:'root'},{password:'not-accepted'}])expect(()=>normalizeConfig({...configuration,...patch})).toThrow();
  expect(publicURL(normalizeConfig({...configuration,publicAddress:'2001:db8::1'}))).toBe('https://[2001:db8::1]');
});
it('merges Caddy idempotently, preserves sites and global options, and renders configurable certificate hooks',()=>{
  const c=normalizeConfig({...configuration,publicAddress:'203.0.113.20',configDir:'/etc/custom-relay',relayPort:14000});
  const original='# Existing server\n{\n email ops@example.com\n}\nother.example.com {\n reverse_proxy localhost:9000\n}\n';
  const merged=mergeCaddy(original,c,'/etc/caddy/turnwire-relay.caddy');
  expect(merged).toContain('email ops@example.com');expect(merged).toContain('other.example.com {\n reverse_proxy localhost:9000');expect(merged.match(/default_sni/g)).toHaveLength(1);
  expect(mergeCaddy(merged,c,'/etc/caddy/turnwire-relay.caddy')).toBe(merged);
  expect(()=>mergeCaddy('{\n default_sni another.example.com\n}\n',c,'/etc/caddy/turnwire-relay.caddy')).toThrow('default_sni');
  expect(caddySite(c,true)).toContain('127.0.0.1:14000');expect(renewHook(c)).toContain('/etc/custom-relay/acme/live/turnwire-relay');
  expect(renewHook(normalizeConfig(configuration))).toContain('-checkhost');expect(renewHook(c)).toContain('-checkip');
});
it('keeps credentials out of SSH arguments/environment and quotes remote command values literally',async()=>{
  const c=normalizeConfig(configuration);const args=sshArguments(c,'/private/known_hosts','/private/key');
  expect(args).toContain('StrictHostKeyChecking=accept-new');expect(args).toContain('deployer');expect(args).toContain('IdentitiesOnly=yes');
  expect(deploymentEnvironment({PATH:'/bin',HOME:'/home/test',SSH_AUTH_SOCK:'/tmp/agent',TURNWIRE_HARNESS_DEEPSEEK_API_KEY:'secret',TURNWIRE_RELAY_TOKEN:'private'})).toEqual({PATH:'/bin',HOME:'/home/test',SSH_AUTH_SOCK:'/tmp/agent'});
  const literal="single ' quote $(uname) `id` $HOME";
  expect(await execute('sh',['-c',`printf %s ${shellQuote(literal)}`])).toBe(literal);
  const script=bootstrap(c,'/tmp/turnwire-deploy.test');expect(script).toContain('uname -m');expect(script).toContain('sha256sum -c');
  await execute('sh',['-n'],{input:script});await execute('sh',['-n'],{input:renewHook(c)});
});
it('restores changed service configuration and permissions after failure without touching unrelated files',async()=>{
  const root=await directory(),config=join(root,'service.env'),newFile=join(root,'new-service');
  await writeFile(config,'original-secret',{mode:0o600});await writeFile(join(root,'unrelated'),'keep');
  const tx=new FileTransaction(join(root,'backups'));await tx.write(config,'replacement',0o644);await tx.write(newFile,'created');await tx.rollback();
  expect(await readFile(config,'utf8')).toBe('original-secret');expect((await stat(config)).mode&0o777).toBe(0o600);
  await expect(stat(newFile)).rejects.toThrow();expect(await readFile(join(root,'unrelated'),'utf8')).toBe('keep');
});
it('verifies every release file and rejects tampering, extras and symlink escapes',async()=>{
  const root=await directory();await mkdir(join(root,'web'));await writeFile(join(root,'relay.mjs'),'server');await writeFile(join(root,'web/index.html'),'page');
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  await writeFile(join(root,'manifest.json'),JSON.stringify({files:{'relay.mjs':hash('server'),'web/index.html':hash('page')}}));
  await verifyRelease(root);await writeFile(join(root,'relay.mjs'),'modified');await expect(verifyRelease(root)).rejects.toThrow('verification failed');
  await writeFile(join(root,'relay.mjs'),'server');await symlink('/etc/passwd',join(root,'web/escape'));await expect(verifyRelease(root)).rejects.toThrow('Symlinks are not allowed');
});
it('packs portable archives without macOS AppleDouble sidecar files',async()=>{
  const root=await directory(),payload=join(root,'payload');await mkdir(payload);
  await writeFile(join(payload,'relay.mjs'),'portable');await writeFile(join(payload,'manifest.json'),'{}');
  const archive=join(root,'payload.tar.gz');await execute('tar',['-czf',archive,'-C',payload,'.']);
  const entries=await execute('tar',['-tzf',archive]);expect(entries).toContain('./relay.mjs');expect(entries).not.toContain('._');
});

async function setup() {
  const dir=await directory();const core=new TurnwireCore(new Store(':memory:'),[new DemoRuntime()],{id:crypto.randomUUID(),name:'Deploy test'});await core.start();cleanup.push(()=>core.dispose());
  const remote=new RemoteController(core,{directory:dir,webRoot:dir});cleanup.push(()=>remote.close());
  let starts=0;const secret=randomSecret();
  const deployment=new DeploymentController(core.store,async(c,progress)=>{starts++;progress('Testing isolated installer');await new Promise(r=>setTimeout(r,50));return {publicUrl:publicURL(c),release:'/opt/turnwire-relay/releases/test',token:secret};},remote,remote.activity);cleanup.push(()=>deployment.close());
  const token=randomSecret();const server=await startDaemonServer({core,token,port:0,remoteAccess:remote,deployment});cleanup.push(()=>server.close());
  const url=`http://127.0.0.1:${server.port}`;const local=new LocalClient(url,token);cleanup.push(()=>local.close());
  return {dir,core,deployment,remote,local,url,token,secret,starts:()=>starts};
}
it('shares asynchronous deployment status across local clients, fences administration and never returns Relay credentials',async()=>{
  const {core,local,url,token,secret,starts}=await setup();
  await local.call('session.create',{runtimeId:'demo',title:'Preserved',cwd:process.cwd()});
  expect((await fetch(url+'/deployment')).status).toBe(401);
  expect((await fetch(url+'/deployment',{headers:{authorization:'Bearer '+token,origin:'https://untrusted.example'}})).status).toBe(403);
  const started=await local.deployRelay(configuration);expect(started.state).toBe('running');
  await expect(local.deployRelay(configuration)).rejects.toThrow('already running');
  await expect.poll(async()=>(await local.deploymentStatus()).state).toBe('succeeded');
  expect(starts()).toBe(1);expect(core.store.sessions()).toHaveLength(1);expect(JSON.stringify(await local.deploymentStatus())).not.toContain(secret);
  expect((await local.call('events.list'))).toEqual({events:expect.any(Array),cursor:expect.any(Number)});
  // @ts-expect-error Administration methods must not be available through typed RPC.
  await expect(local.call('deployment.start',configuration)).rejects.toThrow();
});
it('CLI, TUI command dispatcher and terminal form call the same local deployment service',async()=>{
  const {dir,local,url,token,starts}=await setup();const file=join(dir,'private.json');await writeFile(file,JSON.stringify(configuration),{mode:0o600});
  vi.spyOn(console,'log').mockImplementation(()=>{});
  await createProgram({url,token,json:true}).parseAsync(['deploy','--config',file],{from:'user'});
  const commands=[`deploy --config '${file}'`,'quit'];await runTui(args=>createProgram({url,token,json:true}).parseAsync(args,{from:'user'}),'',{ask:async()=>commands.shift(),write:()=>{}});
  const form=[file];await deploymentMenu(local,{ask:async()=>form.shift(),write:()=>{}});
  expect(starts()).toBe(3);expect((await local.deploymentStatus()).config?.sshUser).toBe(configuration.sshUser);
});
it('marks an interrupted daemon deployment as recoverable and rejects concurrent restarts',async()=>{
  const {core,remote}=await setup();core.store.setSetting('relay-deployment',{state:'running',message:'old process',steps:[],config:normalizeConfig(configuration)});
  const restored=new DeploymentController(core.store,async()=>{throw new Error('unused');},remote,remote.activity);
  expect(restored.status().state).toBe('interrupted');expect(restored.status().config?.host).toBe(configuration.host);
});
