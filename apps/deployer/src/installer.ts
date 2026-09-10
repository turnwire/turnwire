import { spawn } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, lstat, chmod, cp, readlink, unlink, appendFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { isIP } from 'node:net';
import { normalizeConfig, publicURL, CERTBOT_VERSION } from './config.js';
import { caddySite, mergeCaddy, relayService, renewHook, renewService, renewTimer } from './templates.js';
import { FileTransaction, pointRelease } from './transaction.js';

const stage = process.cwd();
const emit = (step: string) => console.log(JSON.stringify({ step }));
async function run(command: string, args: string[], allowFailure = false) {
  return new Promise<string>((accept, reject) => {
    const child = spawn(command, args, { env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', b => { out = (out + b).slice(-100_000); }); child.stderr.on('data', b => { err = (err + b).slice(-100_000); });
    child.once('error', reject);
    child.once('close', code => { void appendFile(join(stage, 'install.log'), `${command} ${args.join(' ')}\n${out}\n${err}\n`, { mode: 0o600 }).then(() => { if (code === 0 || allowFailure) accept(out.trim()); else reject(new Error(`${command} 执行失败；详情见服务器部署目录的 install.log`)); }); });
  });
}
async function exists(path: string) { return !!await lstat(path).catch(() => undefined); }
async function health(url: string) { for (let i = 0; i < 30; i++) { try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (r.ok && (await r.json() as {status:string}).status === 'ok') return; } catch {} await new Promise(r => setTimeout(r,500)); } throw new Error('Relay 健康检查失败'); }

export async function verifyRelease(root: string) {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { files: Record<string,string> };
  if (!manifest.files?.['relay.mjs'] || !manifest.files['web/index.html']) throw new Error('发布包缺少 Relay 或手机页面');
  const found = new Set<string>();
  async function walk(folder: string) { for (const entry of await readdir(folder, { withFileTypes: true })) { const path=join(folder, entry.name); if (entry.isDirectory()) { await chmod(path,0o755); await walk(path); } else {
    const name=relative(root,path); if (!entry.isFile()) throw new Error('发布包不允许符号链接');
    if(name==='manifest.json')continue;
    if(name.endsWith('.map') || createHash('sha256').update(await readFile(path)).digest('hex')!==manifest.files[name]) throw new Error(`发布文件校验失败：${name}`);
    found.add(name);await chmod(path,0o644);
  } } }
  await walk(root);
  if (found.size !== Object.keys(manifest.files).length) throw new Error('发布清单与文件不一致');
  await chmod(root,0o755);
}

async function main() {
  if(process.getuid?.()!==0)throw new Error('需要管理员权限或免密 sudo');
  const input=JSON.parse(await readFile(resolve(process.argv[2] ?? 'config.json'),'utf8')) as {config:unknown;release:string};
  const c=normalizeConfig(input.config);const releaseId=input.release;
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(releaseId))throw new Error('发布 ID 无效');
  await verifyRelease(join(stage,'release'));
  const base=c.installDir, config=c.configDir, certbot=join(c.certbotDir,'bin/certbot');
  const site=join(dirname(c.caddyfile),'turnwire-relay.caddy'), lineage=join(config,'acme/live',c.certName);
  const stateFile=join(config,'deployment.json');
  if(await exists(stateFile)) { const old=JSON.parse(await readFile(stateFile,'utf8')) as {config:typeof c}; for(const key of ['publicAddress','installDir','configDir','relayPort','serviceUser','caddyfile','certbotDir','certName','acmeWebroot'] as const) if(old.config[key]!==c[key])throw new Error(`已部署配置的 ${key} 不同；请为现有实例保留该设置`); }
  let caddyWasActive=(await run('systemctl',['is-active',c.caddyService],true))==='active';
  // Port ownership is checked before installing a proxy or changing a site.
  const listeners=await run('ss',['-lntp']);
  for(const line of listeners.split('\n')) if(/:(80|443)\s/.test(line) && !line.includes('"caddy"'))throw new Error('80/443 已被其他 Web 服务占用；请先为 Relay 安排独立入口');
  if(listeners.split('\n').some(line=>line.includes(`:${c.relayPort} `)) && !(await exists(join(config,'relay.env'))))throw new Error('Relay 端口已被其他服务占用');
  if(!(await exists('/usr/bin/caddy'))) { emit('安装 Caddy');await run('apt-get',['update','-qq']);await run('apt-get',['install','-y','--no-install-recommends','caddy']);caddyWasActive=false; }
  if(!(await exists(certbot))) { emit('安装证书客户端');await run('apt-get',['update','-qq']);await run('apt-get',['install','-y','--no-install-recommends','python3-venv']);await run('python3',['-m','venv',c.certbotDir]);await run(join(c.certbotDir,'bin/pip'),['install','--disable-pip-version-check',`certbot==${CERTBOT_VERSION}`]); }
  const version=await run(certbot,['--version']);const match=version.match(/(\d+)\.(\d+)/);if(!match || Number(match[1])<5 || (Number(match[1])===5 && Number(match[2])<4))throw new Error('Certbot 需要 5.4 或更新版本');
  if(!(await run('getent',['passwd',c.serviceUser],true)))await run('useradd',['--system','--user-group','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',c.serviceUser]);
  if(!(await run('getent',['group',c.caddyGroup],true)))throw new Error('找不到 Caddy 读取证书所用的用户组');
  await mkdir(config,{recursive:true,mode:0o755});await mkdir(join(base,'releases'),{recursive:true,mode:0o755});
  const tx=new FileTransaction(join(config,'backups',releaseId));
  const oldRelease=await readlink(join(base,'current')).catch(()=>undefined);
  const originalCaddy=await readFile(c.caddyfile,'utf8').catch(()=> '');
  const merged=mergeCaddy(originalCaddy,c,site);
  const newRelease=join(base,'releases',releaseId);
  const relayWasActive=(await run('systemctl',['is-active','turnwire-relay'],true))==='active';
  const timerWasActive=(await run('systemctl',['is-active','turnwire-certbot-renew.timer'],true))==='active';
  const relayWasEnabled=(await run('systemctl',['is-enabled','turnwire-relay'],true))==='enabled';
  const timerWasEnabled=(await run('systemctl',['is-enabled','turnwire-certbot-renew.timer'],true))==='enabled';
  let switched=false;
  try {
    emit('保存私有配置并准备服务');
    await mkdir(join(base,'state'),{recursive:true,mode:0o700});
    await chmod(join(base,'state'),0o700);
    await run('chown',[`${c.serviceUser}:${c.serviceUser}`,join(base,'state')]);
    let token=randomBytes(32).toString('hex');
    if(await exists(join(config,'relay.env'))) { const env=await readFile(join(config,'relay.env'),'utf8');const saved=env.match(/^TURNWIRE_RELAY_TOKEN=(.+)$/m)?.[1];if(!saved || !/^[A-Za-z0-9_.-]{32,500}$/.test(saved))throw new Error('已有 Relay 密钥格式无效；未替换旧凭据');token=saved; }
    await tx.write(join(config,'relay.env'),`TURNWIRE_RELAY_TOKEN=${token}\nTURNWIRE_RELAY_HOST=127.0.0.1\nPORT=${c.relayPort}\nTURNWIRE_REMOTE_WEB_ROOT=${base}/current/web\nTURNWIRE_PUSH_DB=${base}/state/push.db\nTURNWIRE_VAPID_SUBJECT=${publicURL(c)}\n`,0o600);
    await tx.write('/etc/systemd/system/turnwire-relay.service',relayService(c));
    await tx.write('/etc/systemd/system/turnwire-certbot-renew.service',renewService(c));
    await tx.write('/etc/systemd/system/turnwire-certbot-renew.timer',renewTimer);
    await tx.write(join(config,'renew-hook'),renewHook(c),0o700);
    await run('systemd-analyze',['verify','/etc/systemd/system/turnwire-relay.service','/etc/systemd/system/turnwire-certbot-renew.service','/etc/systemd/system/turnwire-certbot-renew.timer']);
    await run('systemctl',['daemon-reload']);
    const challenge=join(c.acmeWebroot,'.well-known/acme-challenge');await mkdir(challenge,{recursive:true,mode:0o755});
    for(const dir of [base,c.acmeWebroot,dirname(challenge),challenge])await chmod(dir,0o755);
    let valid=false;
    if(await exists(join(lineage,'fullchain.pem'))) { const cert=new X509Certificate(await readFile(join(lineage,'fullchain.pem')));valid=!!(isIP(c.publicAddress)?cert.checkIP(c.publicAddress):cert.checkHost(c.publicAddress)) && Date.parse(cert.validTo)>Date.now()+86_400_000; }
    if(!valid) {
      emit('验证公网入口并申请 HTTPS 证书');
      if(!oldRelease)await tx.write(site,caddySite(c,false));
      else if(!await exists(site))throw new Error('现有 Relay 缺少对应 Caddy 配置；请先检查实例配置');
      await tx.write(c.caddyfile,merged);
      await run('caddy',['validate','--config',c.caddyfile]);
      await run('systemctl',[caddyWasActive?'reload':'start',c.caddyService]);
      const proof=randomBytes(16).toString('hex');await writeFile(join(challenge,'turnwire-probe'),proof,{mode:0o644});
      try { const response=await fetch(publicURL(c,'http')+'/.well-known/acme-challenge/turnwire-probe',{signal:AbortSignal.timeout(15000),redirect:'error'});if(!response.ok || await response.text()!==proof)throw new Error('公网 80 端口未到达本服务器的证书验证目录'); } finally {await unlink(join(challenge,'turnwire-probe')).catch(()=>{});}
      const issue=(staging:boolean)=>run(certbot,['certonly','--non-interactive','--agree-tos',...(c.email?['--email',c.email]:['--register-unsafely-without-email']),...(staging?['--staging']:[]),'--webroot','--webroot-path',c.acmeWebroot,...(isIP(c.publicAddress)?['--preferred-profile','shortlived','--ip-address',c.publicAddress]:['-d',c.publicAddress]),'--cert-name',c.certName,'--config-dir',join(config,staging?'acme-staging':'acme'),'--work-dir',join(base,staging?'certbot-stage-work':'certbot-work'),'--logs-dir',join(base,staging?'certbot-stage-logs':'certbot-logs')]);
      await issue(true);await issue(false);
    }
    emit('启用 HTTPS、开机启动和自动续期');
    const tls=join(config,'tls');await mkdir(tls,{recursive:true,mode:0o750});
    await run('chown',[`root:${c.caddyGroup}`,tls]);await chmod(tls,0o750);
    await tx.write(join(tls,'fullchain.pem'),await readFile(join(lineage,'fullchain.pem')),0o644);
    await tx.write(join(tls,'privkey.pem'),await readFile(join(lineage,'privkey.pem')),0o640);
    await run('chown',[`root:${c.caddyGroup}`,join(tls,'fullchain.pem'),join(tls,'privkey.pem')]);
    await tx.write(site,caddySite(c,true));await tx.write(c.caddyfile,merged);
    await run('caddy',['validate','--config',c.caddyfile]);
    // /tmp may be a separate filesystem. Copy and verify before the atomic symlink switch.
    await cp(join(stage,'release'),newRelease,{recursive:true,errorOnExist:true,force:false});await verifyRelease(newRelease);
    await pointRelease(join(base,'current'),newRelease);switched=true;
    await run('systemctl',['enable','turnwire-relay',c.caddyService,'turnwire-certbot-renew.timer']);
    await run('systemctl',['restart','turnwire-relay']);await health(`http://127.0.0.1:${c.relayPort}/health`);
    await run('systemctl',[caddyWasActive?'reload':'restart',c.caddyService]);
    await run('systemctl',['start','turnwire-certbot-renew.timer']);await health(publicURL(c)+'/health');
    await tx.write(stateFile,JSON.stringify({config:c,release:newRelease,previousRelease:oldRelease,updatedAt:new Date().toISOString()},null,2)+'\n',0o600);
    // Only this structured result contains the Relay credential; the daemon consumes it privately.
    console.log(JSON.stringify({result:{publicUrl:publicURL(c),release:newRelease,token}}));
  } catch(error) {
    emit('部署失败，恢复原有服务配置');
    await tx.rollback();
    if(switched) {if(oldRelease)await pointRelease(join(base,'current'),oldRelease);else await unlink(join(base,'current')).catch(()=>{});}
    await run('systemctl',['daemon-reload'],true);
    await run('systemctl',[relayWasActive?'restart':'stop','turnwire-relay'],true);
    await run('systemctl',[relayWasEnabled?'enable':'disable','turnwire-relay'],true);
    await run('systemctl',[timerWasActive?'restart':'stop','turnwire-certbot-renew.timer'],true);
    await run('systemctl',[timerWasEnabled?'enable':'disable','turnwire-certbot-renew.timer'],true);
    if(originalCaddy)await run('systemctl',[caddyWasActive?'reload':'stop',c.caddyService],true);
    throw error;
  }
}
if(process.argv[1]?.endsWith('installer.mjs'))void main().catch(error=>{console.log(JSON.stringify({error:error instanceof Error?error.message:'部署失败'}));process.exitCode=1;});
