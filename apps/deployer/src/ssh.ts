import { spawn } from 'node:child_process';
import type { DeploymentConfig } from '../../../packages/protocol/src/deployment.js';
import { shellQuote } from './config.js';

export function deploymentEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH','HOME','LANG','LC_ALL','SSH_AUTH_SOCK'].flatMap(key => env[key] ? [[key,env[key]!]] : []));
}
export function sshArguments(c: DeploymentConfig, knownHosts: string, identity?: string) {
  return ['-F','/dev/null','-p',String(c.sshPort),'-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-o','StrictHostKeyChecking=accept-new','-o',`UserKnownHostsFile=${knownHosts}`,...(identity?['-o','IdentitiesOnly=yes','-i',identity]:[]),'-l',c.sshUser,c.host];
}
export function privilegedCommand(command: string) { return `if [ "$(id -u)" -eq 0 ]; then exec sh -c ${shellQuote(command)}; else exec sudo -n sh -c ${shellQuote(command)}; fi`; }
export function execute(command: string, args: string[], options: { input?: string | Buffer; line?: (text:string)=>void; signal?: AbortSignal; timeoutMs?: number } = {}) {
  return new Promise<string>((resolve,reject)=>{
    const child=spawn(command,args,{env:{...deploymentEnvironment(),...(command==='tar'?{COPYFILE_DISABLE:'1'}:{})},stdio:['pipe','pipe','pipe'],signal:options.signal});
    let stdout='',stderr='',pending='';const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('部署操作超时；请检查服务器状态后重试'));},options.timeoutMs ?? 60_000);
    child.stdout.on('data',value=>{const text=String(value);stdout=(stdout+text).slice(-2_000_000);pending+=text;let index;while((index=pending.indexOf('\n'))>=0){options.line?.(pending.slice(0,index));pending=pending.slice(index+1);}});
    child.stderr.on('data',value=>{stderr=(stderr+value).slice(-4000);});
    child.stdin.on('error',()=>{});child.stdin.end(options.input);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);if(code===0)resolve(stdout.trim());else if(/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(stderr))reject(new Error('SSH 主机指纹校验失败，请检查私有 known_hosts 与服务器身份'));else if(/Permission denied|password is required|sudo:/.test(stderr))reject(new Error('SSH 认证或免密 sudo 不可用；请检查账号、密钥或 SSH agent'));else reject(new Error(`${command} 执行失败（${code ?? '连接中断'}）`));});
  });
}
