#!/usr/bin/env node
import { mkdir, writeFile, readFile, unlink, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { DshRuntime } from '@turnwire/runtime-dsh';
import { startDaemonServer } from './server.js';
import { RemoteController } from './remote-control.js';
import { startCloudflareTunnel, cloudflareNotice } from './providers/cloudflare.js';
import { startLocalhostTunnel } from './providers/localhost-run.js';
import { startCpolarTunnel } from './providers/cpolar.js';
import { DeploymentController } from './deployment.js';
import { createDeploymentRunner } from '../../deployer/src/engine.js';
const providers = [
  { id: 'localhost-run' as const, name: 'localhost.run', description: '免费免注册，使用系统 SSH；免费通道有限速，地址可能变化。', requiresToken: false, start: startLocalhostTunnel },
  { id: 'cpolar' as const, name: 'cpolar', description: '国内线路候选；首次需要账号 Auth Token。免费版 1 Mbps、随机地址，速度取决于实际网络。', requiresToken: true, start: startCpolarTunnel },
  { id: 'cloudflare' as const, name: 'Cloudflare', description: cloudflareNotice, requiresToken: false, start: startCloudflareTunnel },
];

const directory = resolve(process.env.TURNWIRE_HOME ?? join(homedir(), '.turnwire'));
await mkdir(directory, { recursive: true, mode: 0o700 });
const lock = join(directory, 'daemon.pid');
try {
  const pid = Number(await readFile(lock, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid daemon.pid; inspect the Turnwire state directory');
  try { process.kill(pid, 0); throw new Error(`turnwire-host is already running (PID ${pid})`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; await unlink(lock); }
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
const store = new Store(join(directory, 'state.db'));
const token = store.setting<string>('local-token') ?? randomBytes(32).toString('hex'); store.setSetting('local-token', token);
const device = store.setting<{ id: string; name: string }>('device') ?? { id: randomUUID(), name: hostname() }; store.setSetting('device', device);
const runtimeName = process.env.TURNWIRE_RUNTIME ?? 'dsh';
if (!['dsh', 'demo'].includes(runtimeName)) throw new Error('TURNWIRE_RUNTIME must be dsh or demo');
const runtime = runtimeName === 'demo' ? new DemoRuntime() : new DshRuntime({ url: process.env.TURNWIRE_DSH_URL ?? 'http://127.0.0.1:3080', token: process.env.TURNWIRE_DSH_TOKEN, readCursor: id => store.setting<number>(`dsh-cursor:${id}`), saveCursor: (id, seq) => store.setSetting(`dsh-cursor:${id}`, seq) });
const core = new TurnwireCore(store, [runtime], device);
let remote: RemoteController | undefined;
let deployment: DeploymentController | undefined;
try {
  const webRoot = fileURLToPath(new URL('../../remote-web/dist/', import.meta.url));
  remote = new RemoteController(core, { directory, webRoot, providers, ...(process.env.TURNWIRE_RELAY_URL ? { initialRelay: { relayUrl: process.env.TURNWIRE_RELAY_URL, token: process.env.TURNWIRE_RELAY_TOKEN ?? '', remoteUrl: process.env.TURNWIRE_REMOTE_URL } } : {}) });
  await core.start();
  deployment = new DeploymentController(store, createDeploymentRunner({ directory, artifactRoot: fileURLToPath(new URL('../../', import.meta.url)) }), remote);
  const server = await startDaemonServer({ core, token, port: Number(process.env.TURNWIRE_PORT ?? 9898), webRoot, allowedOrigins: (process.env.TURNWIRE_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(','), remoteAccess: remote, deployment });
  const url = `http://127.0.0.1:${server.port}`;
  await writeFile(join(directory, 'client.json'), JSON.stringify({ url, token, device }, null, 2) + '\n', { mode: 0o600 });
  await chmod(join(directory, 'client.json'), 0o600);
  remote?.start();
  console.log(`Turnwire daemon: ${url}\nRuntime: ${runtime.name}\nClient config: ${join(directory, 'client.json')}\nUse “npm run turnwire -- connect” to get the local connection token.`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await deployment?.close(); await remote?.close(); await server.close(); await core.dispose(); await unlink(lock).catch(() => {}); process.exit(0); };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop(); });
} catch (error) { await deployment?.close(); await remote?.close(); await core.dispose(); await unlink(lock).catch(() => {}); throw error; }
