// Native wire tests use an isolated daemon. The installer fixture never opens SSH or changes a server.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TurnwireCore, Store } from '../packages/core/src/index.ts';
import { DemoRuntime } from '../packages/runtime/src/index.ts';
import { randomSecret } from '../packages/sdk/src/index.ts';
import { RemoteController } from '../apps/daemon/src/remote-control.ts';
import { DeploymentController } from '../apps/daemon/src/deployment.ts';
import { startRelay } from '../apps/relay/src/server.ts';
import { startDaemonServer } from '../apps/daemon/src/server.ts';

const directory=await mkdtemp(join(tmpdir(),'turnwire-native-live-'));
const core=new TurnwireCore(new Store(':memory:'),[new DemoRuntime()],{id:crypto.randomUUID(),name:'Native isolated fixture'});await core.start();
const fixtureReply=await core.handle({v:1,id:crypto.randomUUID(),method:'session.create',params:{cwd:directory,title:'Long history fixture',runtimeId:'demo'}});
if(!fixtureReply.ok)throw new Error('Fixture creation failed');
const historySession=fixtureReply.result;
for(let i=0;i<90;i++)core.store.append({type:'message.user',sessionId:historySession.id,messageId:'history-'+i,text:'Earlier record '+i});
for(let i=0;i<4000;i++)core.store.append({type:'message.delta',sessionId:historySession.id,messageId:'long-answer',text:'a'});
core.store.append({type:'tool.started',sessionId:historySession.id,callId:'question',tool:'ask_user_question',detail:'fixture input'});
core.store.append({type:'message.completed',sessionId:historySession.id,messageId:'long-answer',text:'Already finished'});
core.store.append({type:'tool.finished',sessionId:historySession.id,callId:'question',tool:'result',detail:'fixture failure',isError:true});
const secret=randomSecret(),token=randomSecret();const relay=await startRelay({port:0,token:secret});
const remote=new RemoteController(core,{directory,webRoot:directory,providers:['localhost-run','cpolar','cloudflare'].map(id=>({id,name:id,description:'Isolated test',requiresToken:id==='cpolar',start:async()=>{throw new Error('No real tunnels in native fixture');}}))});
const deployment=new DeploymentController(core.store,async(c,progress)=>{progress('隔离测试：读取配置');await new Promise(r=>setTimeout(r,100));return {publicUrl:'https://'+c.publicAddress,release:'/opt/turnwire-relay/releases/fixture',token:randomSecret()};},remote);
const server=await startDaemonServer({core,token,port:0,remoteAccess:remote,deployment});
const config=join(directory,'client.json');await writeFile(config,JSON.stringify({url:'http://127.0.0.1:'+server.port,token}),{mode:0o600});
try {
  const child=spawn('swift',['test'],{cwd:fileURLToPath(new URL('../../turnwire-desktop/',import.meta.url)),env:{...process.env,TURNWIRE_TEST_DAEMON_CONFIG:config,TURNWIRE_TEST_RELAY_URL:'http://127.0.0.1:'+relay.port,TURNWIRE_TEST_RELAY_TOKEN:secret,TURNWIRE_TEST_DEPLOYMENT:'1',TURNWIRE_TEST_HISTORY_SESSION:historySession.id},stdio:'inherit'});
  process.exitCode=await new Promise((resolve,reject)=>{child.once('exit',code=>resolve(code??1));child.once('error',reject);});
} finally {await deployment.close();await remote.close();await server.close();await relay.close();await core.dispose();await rm(directory,{recursive:true,force:true});}
