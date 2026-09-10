import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, rm, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DeploymentConfig } from '../../../packages/protocol/src/deployment.js';
import { normalizeConfig, publicURL, serverConfig, shellQuote } from './config.js';
import { bootstrap } from './templates.js';
import { sshArguments, privilegedCommand, execute } from './ssh.js';

export interface DeploymentResult { publicUrl: string; release: string; token: string }
export type DeploymentRunner = (config: DeploymentConfig, progress: (message: string) => void, signal: AbortSignal) => Promise<DeploymentResult>;
export function createDeploymentRunner(options: { directory: string; artifactRoot: string }): DeploymentRunner {
  return async (input,progress,signal) => {
    const c=normalizeConfig(input);const state=join(options.directory,'deployments');await mkdir(state,{recursive:true,mode:0o700});
    const working=await mkdtemp(join(state,'work-'));await chmod(working,0o700);
    const knownHosts=join(state,'known_hosts');await writeFile(knownHosts,'',{flag:'a',mode:0o600});await chmod(knownHosts,0o600);
    let remoteStage:string|undefined;let ssh:string[]|undefined;let remoteError:string|undefined;
    const release=new Date().toISOString().replace(/[^0-9]/g,'')+'-'+randomUUID().slice(0,8);
    try {
      progress('准备独立 Relay 和手机页面发布包');
      const root=options.artifactRoot;
      const relay=join(root,'relay/dist/standalone.mjs'),installer=join(root,'deployer/dist/installer.mjs'),web=join(root,'remote-web/dist');
      await Promise.all([access(relay),access(installer),access(join(web,'index.html'))]).catch(()=>{throw new Error('部署产物尚未构建，请先运行 npm run build 并更新 daemon');});
      const payload=join(working,'payload');await mkdir(join(payload,'release'),{recursive:true,mode:0o755});
      await cp(relay,join(payload,'release/relay.mjs'));await cp(web,join(payload,'release/web'),{recursive:true,filter:p=>!p.endsWith('.map')});await cp(installer,join(payload,'installer.mjs'));
      const files:Record<string,string>={};
      async function inventory(dir:string,prefix='') { for(const entry of await readdir(dir,{withFileTypes:true})) {if(entry.isSymbolicLink())throw new Error('部署产物不允许符号链接');const name=prefix+entry.name;const path=join(dir,entry.name);if(entry.isDirectory())await inventory(path,name+'/');else files[name]=createHash('sha256').update(await readFile(path)).digest('hex');} }
      await inventory(join(payload,'release'));await writeFile(join(payload,'release/manifest.json'),JSON.stringify({files,node:'>=22.13'}));
      let identity:string|undefined;
      if(c.identityFile) {identity=join(working,'identity');await writeFile(identity,await readFile(c.identityFile),{mode:0o600});}
      ssh=sshArguments(c,knownHosts,identity);
      progress('连接服务器并检查管理员权限');
      remoteStage=await execute('ssh',[...ssh,privilegedCommand('umask 077; mktemp -d /tmp/turnwire-deploy.XXXXXXXX')],{signal});
      if(!/^\/tmp\/turnwire-deploy\.[A-Za-z0-9]+$/.test(remoteStage))throw new Error('服务器返回了无效的临时目录');
      await writeFile(join(payload,'config.json'),JSON.stringify({config:serverConfig(c),release}),{mode:0o600});
      await writeFile(join(payload,'bootstrap.sh'),bootstrap(c,remoteStage),{mode:0o700});
      const archive=join(working,'payload.tar.gz');await execute('tar',['-czf',archive,'-C',payload,'.'],{signal});
      progress('上传并校验发布文件');
      await execute('ssh',[...ssh,privilegedCommand(`umask 077; cat > ${shellQuote(remoteStage+'/payload.tar.gz')}`)],{input:await readFile(archive),signal,timeoutMs:180_000});
      let result:DeploymentResult|undefined;
      await execute('ssh',[...ssh,privilegedCommand(`cd ${shellQuote(remoteStage)} && tar -xzf payload.tar.gz && sh bootstrap.sh`)],{signal,timeoutMs:30*60_000,line:line=>{
        let message:{step?:unknown;result?:DeploymentResult;error?:unknown};try{message=JSON.parse(line);}catch{return;}
        if(typeof message.step==='string')progress(message.step.slice(0,300));
        if(typeof message.error==='string')remoteError=message.error.slice(0,500);
        if(message.result && message.result.publicUrl===publicURL(c) && message.result.release===c.installDir+'/releases/'+release && /^[a-zA-Z0-9_.-]{32,500}$/.test(message.result.token))result=message.result;
      }}).catch(error=>{throw new Error(remoteError ?? error.message);});
      if(!result)throw new Error('未收到部署完成结果；请检查服务器部署日志后重试');
      progress('从本机验证公网 HTTPS');
      const response=await fetch(result.publicUrl+'/health',{signal:AbortSignal.timeout(15000)});
      if(!response.ok || (await response.json() as {status:string}).status!=='ok')throw new Error('服务已安装，但本机无法验证公网 HTTPS；请检查网络后重试');
      await execute('ssh',[...ssh,privilegedCommand(`rm -rf -- ${shellQuote(remoteStage)}`)]);remoteStage=undefined;
      return result;
    } catch(error) {
      if(remoteStage)progress(`服务器诊断目录：${remoteStage}（仅管理员可读）`);
      throw error;
    } finally {await rm(working,{recursive:true,force:true});}
  };
}
