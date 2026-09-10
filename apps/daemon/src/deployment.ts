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
    this.current=store.setting<DeploymentStatus>('relay-deployment') ?? {state:'idle',message:'填写服务器配置后，一键部署 Relay',steps:[]};
    if(this.current.state==='running') {this.current={...this.current,state:'interrupted',message:'daemon 上次在部署中退出；请检查服务器状态或使用相同配置重试'};this.save();}
  }
  status() {return structuredClone(this.current);}
  private save() {this.store.setSetting('relay-deployment',this.current);}
  start(value:unknown) {
    if(this.operation)throw new Error('已有部署正在进行；关闭客户端页面不会停止部署');
    const config=normalizeConfig(value);const aborter=new AbortController();this.aborter=aborter;
    this.current={id:randomUUID(),state:'running',message:'正在准备部署',phase:'准备',config,startedAt:new Date().toISOString(),steps:[]};this.save();
    const progress=(message:string)=>{this.current.message=message;this.current.phase=message;this.current.steps=[...this.current.steps,{time:new Date().toISOString(),message}].slice(-80);this.save();};
    this.operation=Promise.resolve().then(async()=>{
      const result=await this.runner(config,progress,aborter.signal);
      this.current.publicUrl=result.publicUrl;this.current.release=result.release;
      if(config.connectAfterDeploy) {
        progress('配置本机并验证 Relay 注册');this.remote.configure({mode:'relay',serverUrl:result.publicUrl,token:result.token});
        const deadline=Date.now()+30_000;while(this.remote.status().state!=='online' && Date.now()<deadline){aborter.signal.throwIfAborted();await new Promise(r=>setTimeout(r,300));}
        if(this.remote.status().state!=='online')throw new Error('服务器已部署，本机 Relay 尚未连通；连接配置已保存，可在远程控制中重试');
      }
      this.current.state='succeeded';this.current.message=config.connectAfterDeploy?'部署完成，本机已连接。可以生成手机配对二维码。':'部署完成，公网入口已验证';
    }).catch(error=>{this.current.state=aborter.signal.aborted?'interrupted':'failed';this.current.message=error instanceof Error?error.message:'部署失败';}).finally(()=>{this.current.finishedAt=new Date().toISOString();this.save();this.operation=undefined;});
    return this.status();
  }
  async close() {this.aborter?.abort();await this.operation;}
}
