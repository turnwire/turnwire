import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
const exec = promisify(execFile);
export function versionParts(value) {
  if (typeof value !== 'string' || value.length > 160) throw Error('Invalid DSH registry version');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match.slice(1,4).some(n => !Number.isSafeInteger(Number(n))) || match[4]?.split('.').some(n => /^\d+$/.test(n) && n.length > 1 && n.startsWith('0'))) throw Error('Invalid DSH registry version');
  return { core: match.slice(1,4).map(Number), pre: match[4]?.split('.') };
}
export function compareVersions(a,b) {
  const x=versionParts(a), y=versionParts(b);
  for (let i=0;i<3;i++) if(x.core[i]!==y.core[i]) return x.core[i]>y.core[i]?1:-1;
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for(let i=0;i<Math.max(x.pre.length,y.pre.length);i++) { const p=x.pre[i],q=y.pre[i]; if(p===q) continue; if(p===undefined)return -1;if(q===undefined)return 1; const pn=/^\d+$/.test(p),qn=/^\d+$/.test(q); if(pn&&qn)return BigInt(p)>BigInt(q)?1:-1; if(pn!==qn)return pn?-1:1;return p>q?1:-1; }
  return 0;
}
export async function installedVersion(entry) {
  try { const stat=await lstat(entry); if(!stat.isFile())throw Error('Managed DSH entry must be a regular file'); }
  catch(error){if(error.code==='ENOENT')return undefined;throw error;}
  const manifest=JSON.parse(await readFile(join(dirname(entry),'../package.json'),'utf8'));
  if(manifest.name!=='@deepseek-ai/dsh')throw Error('Managed entry does not belong to @deepseek-ai/dsh');
  versionParts(manifest.version);return manifest.version;
}
export async function selectedEntry(paths, env, privateJson) {
  if(env.TURNWIRE_DSH_ENTRY)return paths.dshEntry;
  let saved;try{saved=await privateJson(join(paths.config,'managed-dsh.json'));}catch(error){if(error.code==='ENOENT')return paths.dshEntry;throw error;}
  const base=join(paths.data,'runtime','dsh-versions');
  if(typeof saved.entry!=='string' || relative(base,saved.entry).startsWith('..') || resolve(saved.entry)!==saved.entry || !saved.entry.endsWith('/node_modules/@deepseek-ai/dsh/lib/bin.js'))throw Error('Invalid managed DSH selection');
  if(!await installedVersion(saved.entry))throw Error('Selected managed DSH installation is missing');return saved.entry;
}
export async function resolveLatest(env) {
  const {stdout}=await exec('npm',['view','@deepseek-ai/dsh@latest','version','--json','--registry=https://registry.npmjs.org'],{env,timeout:30000,maxBuffer:16384});
  const value=JSON.parse(stdout);versionParts(value);return value;
}
async function freePort(){const server=createServer();await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});const port=server.address().port;await new Promise(ok=>server.close(ok));return String(port);}
export async function smokeDsh(entry,root,probe) {
  const home=await mkdtemp(join(tmpdir(),'turnwire-dsh-probe-'));
  let child,closed,timer;let stopped=false;const abort=()=>{stopped=true;child?.kill('SIGTERM');};
  process.on('SIGINT',abort);process.on('SIGTERM',abort);
  try {
    const env={PATH:process.env.PATH,HOME:home,DSH_HOME:join(home,'dsh'),XDG_CONFIG_HOME:join(home,'config'),XDG_STATE_HOME:join(home,'state'),XDG_DATA_HOME:join(home,'data'),XDG_CACHE_HOME:join(home,'cache'),TURNWIRE_HARNESS_DEEPSEEK_API_KEY:'turnwire-isolated-probe-not-a-real-key',DO_NOT_TRACK:'1'};
    child=spawn(process.execPath,[entry,'--patch',join(root,'config/dsh-deepseek.patch.yml'),'--profile','web','--no-open','--host','127.0.0.1','--port',await freePort()],{env,cwd:home,stdio:['ignore','pipe','pipe']});
    closed=new Promise(ok=>child.once('close',ok));
    const launch=await new Promise((ok,fail)=>{let text='';timer=setTimeout(()=>fail(Error('Staged DSH readiness timed out')),45000);child.once('error',()=>fail(Error('Staged DSH failed to start')));child.once('close',()=>fail(Error('Staged DSH exited before readiness')));const capture=data=>{text=(text+data.toString()).slice(-32768);const match=/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\x1b]+)/.exec(text);if(match)ok(match[1]);};child.stdout.on('data',capture);child.stderr.on('data',capture);});
    clearTimeout(timer);if(stopped)throw Error('Update cancelled');await probe(launch);if(stopped)throw Error('Update cancelled');
  } finally {
    clearTimeout(timer);
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    const kill=setTimeout(()=>child?.kill('SIGKILL'),5000);if(closed)await closed;clearTimeout(kill);
    await rm(home,{recursive:true,force:true});
    process.off('SIGINT',abort);process.off('SIGTERM',abort);
    if(stopped)throw Error('Update cancelled');
  }
}
export async function stageAndActivate({paths,version,root,env,runChild,probe,smoke=smokeDsh}) {
  versionParts(version);const base=join(paths.data,'runtime','dsh-versions');await mkdir(base,{recursive:true,mode:0o700});
  const prefix=await mkdtemp(join(base,version+'-'));let activated=false;
  try {
    const result=await runChild('npm',['install','--prefix',prefix,'--registry=https://registry.npmjs.org','--no-audit','--no-fund','--ignore-scripts','--save-exact',`@deepseek-ai/dsh@${version}`],{env:{...env,npm_config_cache:join(paths.cache,'npm')},cwd:prefix,quiet:true});
    if(result!==0)throw Error('Staged DSH installation failed; current installation unchanged');
    const entry=join(prefix,'node_modules/@deepseek-ai/dsh/lib/bin.js');if(await installedVersion(entry)!==version)throw Error('Staged DSH version mismatch');
    await smoke(entry,root,probe);
    await mkdir(paths.config,{recursive:true,mode:0o700});const target=join(paths.config,'managed-dsh.json'),temp=target+'.'+process.pid+'.tmp';
    let wrote=false;try{await writeFile(temp,JSON.stringify({entry,version})+'\n',{flag:'wx',mode:0o600});wrote=true;await rename(temp,target);}finally{if(wrote)await rm(temp,{force:true});}
    activated=true;return entry;
  }finally{if(!activated)await rm(prefix,{recursive:true,force:true});}
}
