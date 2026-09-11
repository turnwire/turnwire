import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import type { RuntimeEvent } from '@turnwire/runtime';
import { imageInputSchema, methodSchemas, MAX_IMAGE_BYTES } from '@turnwire/protocol';
import type { ImageAttachment, ImageInput, Session } from '@turnwire/protocol';
const data = Buffer.from('test image bytes').toString('base64');
const image: ImageInput = { mediaType: 'image/png', data };
const ref: ImageAttachment = { attachmentId: 'native-image', mediaType: 'image/png', bytes: Buffer.from(data,'base64').length, width: 1, height: 1 };
class Images extends DemoRuntime {
  listener?: (event: RuntimeEvent) => void;
  mode: 'early'|'late'|'missing'|'reject' = 'early';
  override capabilities() { return { ...super.capabilities(), imageInput: true }; }
  override subscribe(_id: string, listener: (event: RuntimeEvent) => void) { this.listener = listener; return () => {}; }
  override async sendMessage(_id: string, input: {id:string;text:string;images?:ImageInput[]}) {
    if (this.mode === 'reject') throw new Error('Model does not support images');
    this.listener?.({ type: 'message.user', messageId: input.id, text: input.text, ...(this.mode === 'early' ? {images:[ref]} : {}) });
    if (this.mode === 'missing') return;
    return [ref];
  }
  async readImage(_id:string, _attachmentId:string) { return { attachment: ref, data }; }
}
const active: TurnwireCore[]=[];
afterEach(async()=>{ for(const core of active.splice(0)) await core.dispose(); });
const call=(core:TurnwireCore,id:string,method:string,params:unknown)=>core.handle({v:1,id,method,params});
async function setup(runtime = new Images()) { const store=new Store(':memory:'); const core=new TurnwireCore(store,[runtime],{id:'test',name:'test'}); active.push(core); const result=await call(core,'create','session.create',{cwd:process.cwd(),runtimeId:'demo'}); if(!result.ok) throw Error(result.error.message); return {core,store,runtime,session:result.result as Session}; }
it('enforces decoded limits, canonical base64, MIME and nonempty message rules',()=>{
  expect(imageInputSchema.safeParse({...image,data:Buffer.alloc(MAX_IMAGE_BYTES).toString('base64')}).success).toBe(true);
  for(const input of [{...image,data:Buffer.alloc(MAX_IMAGE_BYTES+1).toString('base64')},{...image,data:'AB=='},{...image,data:'AAAA\n'},{...image,mediaType:'image/svg+xml'},{...image,data:'data:image/png;base64,AAAA'}]) expect(imageInputSchema.safeParse(input).success).toBe(false);
  const schema=methodSchemas['session.message'];
  expect(schema.safeParse({sessionId:'s',text:' ',images:[image]}).success).toBe(true);
  for(const input of [{text:''},{text:'',images:[]},{text:'',images:[image,image,image]},{text:'x'.repeat(16001),images:[image]}]) expect(schema.safeParse({sessionId:'s',...input}).success).toBe(false);
});
for(const mode of ['early','late'] as const) it(`publishes exactly one complete ref-bearing user event with ${mode} echo, not bytes`,async()=>{
  const {core,store,runtime,session}=await setup();runtime.mode=mode;
  const params={sessionId:session.id,text:'',images:[image]};
  expect((await call(core,'image','session.message',params)).ok).toBe(true);
  expect((await call(core,'image','session.message',params)).ok).toBe(true);
  runtime.listener?.({type:'message.user',messageId:'image',text:'',images:[ref]});
  const users=store.events(0,100).filter(e=>e.data.type==='message.user');
  expect(users).toHaveLength(1);expect(users[0]!.data).toMatchObject({images:[ref]});
  expect(JSON.stringify(store.history(session.id,100))).not.toContain(data);
  expect(JSON.stringify(store.request('image'))).not.toContain(data);
});
it('rejects missing refs, unsupported runtimes and model rejection explicitly',async()=>{
  const {core,store,runtime,session}=await setup(); runtime.mode='missing';
  expect(await call(core,'missing','session.message',{sessionId:session.id,text:'',images:[image]})).toMatchObject({ok:false,error:{code:'OUTCOME_UNKNOWN'}});
  expect(store.events(0,100).filter(e=>e.data.type==='message.user')).toHaveLength(0);
  runtime.mode='reject'; expect((await call(core,'reject','session.message',{sessionId:session.id,text:'',images:[image]})).ok).toBe(false);
  vi.spyOn(runtime,'capabilities').mockReturnValue({...runtime.capabilities(),imageInput:false});
  expect(await call(core,'unsupported','session.message',{sessionId:session.id,text:'',images:[image]})).toMatchObject({ok:false,error:{code:'IMAGE_INPUT_UNSUPPORTED'}});
});
it('authorizes durable session user refs before reading and never receipts image bytes',async()=>{
  const {core,store,runtime,session}=await setup(); const read=vi.spyOn(runtime,'readImage');
  const params={sessionId:session.id,attachmentId:ref.attachmentId};
  expect(await call(core,'unknown','session.image',params)).toMatchObject({ok:false,error:{code:'IMAGE_NOT_FOUND'}});expect(read).not.toHaveBeenCalled();
  await call(core,'send','session.message',{sessionId:session.id,text:'',images:[image]});
  expect(await call(core,'chunk','session.image',{...params,limit:4})).toMatchObject({ok:true,result:{data:data.slice(0,4),offset:0,nextOffset:4}});
  expect(read).toHaveBeenCalledWith(session.runtimeSessionId,ref.attachmentId); expect(store.request('chunk')).toBeUndefined();
  expect(await call(core,'end','session.image',{...params,offset:data.length})).toMatchObject({ok:true,result:{data:'',nextOffset:null}});
  expect(await call(core,'bad','session.image',{...params,offset:data.length+1})).toMatchObject({ok:false,error:{code:'INVALID_CURSOR'}});
  const second=await call(core,'create2','session.create',{cwd:process.cwd(),runtimeId:'demo'});if(!second.ok)throw Error();
  read.mockClear();expect(await call(core,'foreign','session.image',{...params,sessionId:(second.result as Session).id})).toMatchObject({ok:false,error:{code:'IMAGE_NOT_FOUND'}});expect(read).not.toHaveBeenCalled();
  read.mockResolvedValue({attachment:ref,data:'AB=='});expect(await call(core,'invalid','session.image',params)).toMatchObject({ok:false,error:{code:'INVALID_IMAGE'}});
});
it('authorizes image references after reopening durable history',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'turnwire-images-'));
  const path=join(dir,'store.db'); const store=new Store(path);
  store.append({type:'message.user',sessionId:'root',messageId:'m',text:'',images:[ref]},'echo');
  store.close(); const reopened=new Store(path);
  try { expect(reopened.imageAttachment('root',ref.attachmentId)).toEqual(ref); expect(reopened.imageAttachment('other',ref.attachmentId)).toBeUndefined(); expect(reopened.history('root',10).events[0]!.data).toMatchObject({images:[ref]}); } finally { reopened.close(); await rm(dir,{recursive:true,force:true}); }
});
it('rejects text editing image queued prompts explicitly',async()=>{
  const {core,session}=await setup();await call(core,'send','session.message',{sessionId:session.id,text:'',images:[image]});
  expect(await call(core,'edit','session.queueAction',{sessionId:session.id,messageId:'send',action:{kind:'edit',text:'replacement'}})).toMatchObject({ok:false,error:{code:'IMAGE_QUEUE_EDIT_UNSUPPORTED'}});
});
