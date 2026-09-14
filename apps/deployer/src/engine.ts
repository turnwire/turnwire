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
    signal.throwIfAborted();
    const c=normalizeConfig(input);const state=join(options.directory,'deployments');await mkdir(state,{recursive:true,mode:0o700});
    const working=await mkdtemp(join(state,'work-'));await chmod(working,0o700);
    const knownHosts=join(state,'known_hosts');await writeFile(knownHosts,'',{flag:'a',mode:0o600});await chmod(knownHosts,0o600);
    let remoteStage:string|undefined;let ssh:string[]|undefined;let remoteError:string|undefined;
    const release=new Date().toISOString().replace(/[^0-9]/g,'')+'-'+randomUUID().slice(0,8);
    try {
      progress('Preparing the standalone Relay and phone web app release package');
      const root=options.artifactRoot;
      const relay=join(root,'relay/dist/standalone.mjs'),installer=join(root,'deployer/dist/installer.mjs'),web=join(root,'remote-web/dist');
      await Promise.all([access(relay),access(installer),access(join(web,'index.html'))]).catch(()=>{throw new Error('Deployment artifacts are not built yet; run npm run build and update the daemon first');});
      const payload=join(working,'payload');await mkdir(join(payload,'release'),{recursive:true,mode:0o755});
      await cp(relay,join(payload,'release/relay.mjs'));await cp(web,join(payload,'release/web'),{recursive:true,filter:p=>!p.endsWith('.map')});await cp(installer,join(payload,'installer.mjs'));
      const files:Record<string,string>={};
      async function inventory(dir:string,prefix='') { for(const entry of await readdir(dir,{withFileTypes:true})) {if(entry.isSymbolicLink())throw new Error('Symlinks are not allowed in deployment artifacts');const name=prefix+entry.name;const path=join(dir,entry.name);if(entry.isDirectory())await inventory(path,name+'/');else files[name]=createHash('sha256').update(await readFile(path)).digest('hex');} }
      await inventory(join(payload,'release'));await writeFile(join(payload,'release/manifest.json'),JSON.stringify({files,node:'>=22.13'}));
      let identity:string|undefined;
      if(c.identityFile) {identity=join(working,'identity');await writeFile(identity,await readFile(c.identityFile),{mode:0o600});}
      ssh=sshArguments(c,knownHosts,identity);
      progress('Connecting to the server and checking administrator privileges');
      remoteStage=await execute('ssh',[...ssh,privilegedCommand('umask 077; mktemp -d /tmp/turnwire-deploy.XXXXXXXX')],{signal});
      if(!/^\/tmp\/turnwire-deploy\.[A-Za-z0-9]+$/.test(remoteStage))throw new Error('The server returned an invalid temporary directory');
      await writeFile(join(payload,'config.json'),JSON.stringify({config:serverConfig(c),release}),{mode:0o600});
      await writeFile(join(payload,'bootstrap.sh'),bootstrap(c,remoteStage),{mode:0o700});
      const archive=join(working,'payload.tar.gz');await execute('tar',['-czf',archive,'-C',payload,'.'],{signal});
      progress('Uploading and verifying release files');
      await execute('ssh',[...ssh,privilegedCommand(`umask 077; cat > ${shellQuote(remoteStage+'/payload.tar.gz')}`)],{input:await readFile(archive),signal,timeoutMs:180_000});
      let result:DeploymentResult|undefined;
      signal.throwIfAborted();
      await execute('ssh',[...ssh,privilegedCommand(`cd ${shellQuote(remoteStage)} && tar -xzf payload.tar.gz && sh bootstrap.sh`)],{signal,timeoutMs:30*60_000,line:line=>{
        let message:{step?:unknown;result?:DeploymentResult;error?:unknown};try{message=JSON.parse(line);}catch{return;}
        if(typeof message.step==='string')progress(message.step.slice(0,300));
        if(typeof message.error==='string')remoteError=message.error.slice(0,500);
        if(message.result && message.result.publicUrl===publicURL(c) && message.result.release===c.installDir+'/releases/'+release && /^[a-zA-Z0-9_.-]{32,500}$/.test(message.result.token))result=message.result;
      }}).catch(error=>{throw new Error(`${remoteError ?? (error instanceof Error ? error.message : 'Installer connection interrupted')}. Remote installer outcome is unknown; stopping the local SSH process does not confirm remote cancellation. Check the server deployment log before retrying.`, {cause:error});});
      if(!result)throw new Error('Remote installer outcome is unknown: no deployment result received; check the server deployment log before retrying');
      progress('Verifying public HTTPS from this machine');
      const response=await fetch(result.publicUrl+'/health',{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
      if(!response.ok || (await response.json() as {status:string}).status!=='ok')throw new Error('The service is installed but this machine cannot verify public HTTPS; check the network and retry');
      await execute('ssh',[...ssh,privilegedCommand(`rm -rf -- ${shellQuote(remoteStage)}`)],{signal});remoteStage=undefined;
      return result;
    } catch(error) {
      // Diagnostics callbacks must not replace the original failure (including unknown remote outcome).
      if(remoteStage)try { progress(`Server diagnostics directory: ${remoteStage} (readable by administrators only)`); } catch {}
      throw error;
    } finally {await rm(working,{recursive:true,force:true});}
  };
}
