import { expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as processes from 'node:child_process';
import { execute } from '../apps/deployer/src/ssh.js';
import { DeploymentController } from '../apps/daemon/src/deployment.js';
import { HostActivity } from '../apps/daemon/src/host-activity.js';
import type { Store } from '@turnwire/core';
import type { RemoteAccess } from '../apps/daemon/src/remote-control.js';
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {...actual, spawn: vi.fn(actual.spawn)};
});

afterEach(() => { vi.mocked(processes.spawn).mockReset(); vi.restoreAllMocks(); vi.useRealTimers(); });
function child() {
  const p = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  vi.mocked(processes.spawn).mockReturnValueOnce(p as unknown as processes.ChildProcessWithoutNullStreams);
  return p;
}
for (const trigger of ['timeout', 'abort', 'callback', 'error'] as const) it(`${trigger} retains ownership until actual close, escalating TERM to KILL`, async () => {
  vi.useFakeTimers(); const p = child(); const aborter = new AbortController(); const failure = new Error('injected');
  let settled = false;
  const result = execute('ssh', [], { input: trigger === 'abort' ? Buffer.alloc(128 * 1024) : undefined, timeoutMs: 100, killGraceMs: 20, signal: aborter.signal, line: () => { throw failure; } });
  const observed = result.catch(error => { settled = true; return error; });
  if (trigger === 'timeout') await vi.advanceTimersByTimeAsync(100);
  if (trigger === 'abort') aborter.abort(failure);
  if (trigger === 'callback') p.stdout.emit('data', 'progress\n');
  if (trigger === 'error') { p.stderr.emit('data', 'Permission denied'); p.emit('error', failure); }
  await Promise.resolve(); expect(settled).toBe(false); expect(p.kill).toHaveBeenCalledWith('SIGTERM');
  await vi.advanceTimersByTimeAsync(20); expect(p.kill).toHaveBeenCalledWith('SIGKILL'); expect(settled).toBe(false);
  p.emit('close', null, 'SIGKILL'); const error = await observed;
  if (trigger === 'timeout') expect(error.message).toContain('timed out'); else expect(error).toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
});
it('owns signalling errors without releasing a still-live child', async () => {
  vi.useFakeTimers(); const p=child(); p.kill.mockImplementation(()=>{throw new Error('EPERM');});
  let settled=false; const observed=execute('ssh',[],{timeoutMs:10,killGraceMs:10}).catch(error=>{settled=true;return error;});
  await vi.advanceTimersByTimeAsync(20); expect(settled).toBe(false); expect(p.kill).toHaveBeenCalledTimes(2);
  p.emit('close',1); const error=await observed; expect(error).toBeInstanceOf(AggregateError); expect(error.errors[1].message).toBe('EPERM');
});
it('does not spawn pre-aborted work', async () => {
  const p = child(); const aborter = new AbortController(); aborter.abort();
  await expect(execute('ssh', [], {signal:aborter.signal})).rejects.toThrow(); expect(processes.spawn).not.toHaveBeenCalled(); expect(p.kill).not.toHaveBeenCalled();
});
it('holds controller activity and rejects retries throughout abort cleanup', async () => {
  vi.useFakeTimers(); const p=child(); let owners=0;
  const activity=new HostActivity(()=>{owners++;return ()=>{owners--;};});
  const store={setting:()=>undefined,setSetting:vi.fn()} as unknown as Store;
  const controller=new DeploymentController(store,async (_config,_progress,signal)=>{
    await execute('ssh',[],{signal,killGraceMs:20}); throw new Error('unreachable');
  },{} as RemoteAccess,activity);
  const config={host:'203.0.113.20',sshUser:'deployer',publicAddress:'relay.example.com',connectAfterDeploy:false};
  controller.start(config); await Promise.resolve();
  let closed=false; const close=controller.close().then(()=>{closed=true;});
  await vi.advanceTimersByTimeAsync(20); expect(owners).toBe(1); expect(closed).toBe(false); expect(()=>controller.start(config)).toThrow();
  p.emit('close',null,'SIGKILL'); await close; await activity.drain(); expect(owners).toBe(0); expect(controller.status().state).toBe('interrupted');
});
it('reaps a real local child that ignores TERM before returning timeout failure', async () => {
  let pid = 0;
  const result = execute(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)"], {timeoutMs:500,killGraceMs:30,line:line=>{pid=Number(line);}});
  await expect(result).rejects.toThrow('timed out'); expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
});
