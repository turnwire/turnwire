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
export function execute(command: string, args: string[], options: { input?: string | Buffer; line?: (text:string)=>void; signal?: AbortSignal; timeoutMs?: number; killGraceMs?: number } = {}) {
  return new Promise<string>((resolve,reject)=>{
    // Do not use spawn's signal option: its AbortError precedes actual process close.
    if (options.signal?.aborted) { reject(options.signal.reason); return; }
    const child=spawn(command,args,{env:{...deploymentEnvironment(),...(command==='tar'?{COPYFILE_DISABLE:'1'}:{})},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',pending='';
    let failure: unknown; let failed=false; let closed=false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill=(signal: NodeJS.Signals)=>{
      try { child.kill(signal); } catch(error) {
        // Failed signalling cannot prove termination. Retain ownership until close,
        // preserving the triggering failure and the cleanup diagnostic together.
        failure=new AggregateError([failure,error], 'Deployment termination failed; waiting for local process close');
      }
    };
    const stop=(error: unknown)=>{
      if (closed || failed) return;
      failed=true; failure=error;
      kill('SIGTERM');
      // Bound the graceful phase, not ownership: even after KILL only close releases
      // the owner. A stuck kernel process must not allow an overlapping retry.
      escalation=setTimeout(()=>{ kill('SIGKILL'); }, Math.max(0, Math.min(options.killGraceMs ?? 1000, 5000)));
    };
    const timer=setTimeout(()=>stop(new Error('Deployment operation timed out; check the server state before retrying')),options.timeoutMs ?? 60_000);
    const abort=()=>stop(options.signal?.reason ?? new Error('Deployment aborted'));
    options.signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',value=>{
      const text=String(value);stdout=(stdout+text).slice(-2_000_000);
      if (failed) return;
      pending+=text;
      try { let index;while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);options.line?.(line);} }
      catch(error) { stop(error); }
      pending=pending.slice(-2_000_000);
    });
    child.stderr.on('data',value=>{stderr=(stderr+value).slice(-4000);});
    child.stdin.on('error',stop);
    child.stdout.on('error',stop); child.stderr.on('error',stop);
    child.once('error',stop);
    child.once('close',code=>{
      closed=true;clearTimeout(timer);clearTimeout(escalation);options.signal?.removeEventListener('abort',abort);
      if(failed)reject(failure);
      else if(code===0)resolve(stdout.trim());
      else if(/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(stderr))reject(new Error('SSH host key verification failed; check the private known_hosts file and the server identity'));
      else if(/Permission denied|password is required|sudo:/.test(stderr))reject(new Error('SSH authentication or passwordless sudo is unavailable; check the account, key or SSH agent'));
      else reject(new Error(`${command} failed (${code ?? 'connection lost'})`));
    });
    child.stdin.end(options.input);
    if(options.signal?.aborted)abort();
  });
}
