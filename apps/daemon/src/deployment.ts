import type { Store } from '@turnwire/core';
import type { DeploymentStatus } from '@turnwire/protocol';
import { normalizeConfig } from '../../deployer/src/config.js';
import type { DeploymentRunner } from '../../deployer/src/engine.js';
import type { RemoteAccess } from './remote-control.js';
import { randomUUID } from 'node:crypto';

export interface DeploymentAccess { status(): DeploymentStatus; start(value:unknown): DeploymentStatus }
export class DeploymentController implements DeploymentAccess {
  private current:DeploymentStatus;private operation?:Promise<void>;private aborter?:AbortController;
  constructor(private store:Store,private runner:DeploymentRunner,private remote:RemoteAccess) {
    this.current=store.setting<DeploymentStatus>('relay-deployment') ?? {state:'idle',message:'Fill in the server configuration to deploy Relay in one click',steps:[]};
    if(this.current.state==='running') {this.current={...this.current,state:'interrupted',message:'The daemon exited during the last deployment; check the server state or retry with the same configuration'};this.save();}
  }
  status() {return structuredClone(this.current);}
  private save() {this.store.setSetting('relay-deployment',this.current);}
  start(value:unknown) {
    if(this.operation)throw new Error('A deployment is already running; closing the client page will not stop it');
    const config=normalizeConfig(value);const aborter=new AbortController();this.aborter=aborter;
    this.current={id:randomUUID(),state:'running',message:'Preparing deployment',phase:'Preparing',config,startedAt:new Date().toISOString(),steps:[]};this.save();
    const progress=(message:string)=>{this.current.message=message;this.current.phase=message;this.current.steps=[...this.current.steps,{time:new Date().toISOString(),message}].slice(-80);this.save();};
    this.operation=Promise.resolve().then(async()=>{
      const result=await this.runner(config,progress,aborter.signal);
      this.current.publicUrl=result.publicUrl;this.current.release=result.release;
      if(config.connectAfterDeploy) {
        progress('Configuring this machine and verifying Relay registration');this.remote.configure({mode:'relay',serverUrl:result.publicUrl,token:result.token});
        const deadline=Date.now()+30_000;while(this.remote.status().state!=='online' && Date.now()<deadline){aborter.signal.throwIfAborted();await new Promise(r=>setTimeout(r,300));}
        if(this.remote.status().state!=='online')throw new Error('The server is deployed but this machine is not connected to Relay yet; the connection settings were saved and can be retried in remote control');
      }
      this.current.state='succeeded';this.current.message=config.connectAfterDeploy?'Deployment complete and this machine is connected. You can generate a phone pairing QR code.':'Deployment complete; the public endpoint is verified';
    }).catch(error=>{this.current.state=aborter.signal.aborted?'interrupted':'failed';this.current.message=error instanceof Error?error.message:'Deployment failed';}).finally(()=>{this.current.finishedAt=new Date().toISOString();this.save();this.operation=undefined;});
    return this.status();
  }
  async close() {this.aborter?.abort();await this.operation;}
}
