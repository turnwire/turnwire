import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentRunner } from '../apps/deployer/src/engine.js';
import { execute } from '../apps/deployer/src/ssh.js';
vi.mock('../apps/deployer/src/ssh.js', async original => ({...await original<typeof import('../apps/deployer/src/ssh.js')>(),execute:vi.fn()}));
vi.mock('node:fs/promises',()=>({cp:vi.fn(),mkdir:vi.fn(),mkdtemp:vi.fn().mockResolvedValue('/virtual/work'),readFile:vi.fn().mockResolvedValue(Buffer.from('test')),readdir:vi.fn().mockResolvedValue([]),writeFile:vi.fn(),rm:vi.fn(),chmod:vi.fn(),access:vi.fn()}));
afterEach(()=>vi.clearAllMocks());
it('labels interrupted remote installer outcome unknown and preserves it when diagnostics callback throws',async()=>{
  vi.mocked(execute).mockResolvedValueOnce('/tmp/turnwire-deploy.test').mockResolvedValueOnce('').mockResolvedValueOnce('').mockRejectedValueOnce(new Error('SSH aborted'));
  const runner=createDeploymentRunner({directory:'/virtual',artifactRoot:'/virtual/artifacts'});
  await expect(runner({host:'203.0.113.20',sshUser:'deployer',publicAddress:'relay.example.com',connectAfterDeploy:false} as never,message=>{if(message.startsWith('Server diagnostics'))throw new Error('diagnostics unavailable');},new AbortController().signal)).rejects.toThrow('Remote installer outcome is unknown');
  expect(execute).toHaveBeenCalledTimes(4);
});
