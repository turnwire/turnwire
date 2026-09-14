#!/usr/bin/env node
import { mkdir, writeFile, readFile, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolveTurnwirePaths } from '../../../packages/sdk/src/node-paths.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, TurnwireCore, validateStorageFile } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import { DshRuntime } from '@turnwire/runtime-dsh';
import { startDaemonServer } from './server.js';
import { daemonIdentity } from './identity.js';
import { RemoteController } from './remote-control.js';
import { startCloudflareTunnel, startCloudflareNamedTunnel, cloudflareNotice, cloudflareNamedNotice } from './providers/cloudflare.js';
import { startLocalhostTunnel } from './providers/localhost-run.js';
import { startCpolarTunnel } from './providers/cpolar.js';
import { DeploymentController } from './deployment.js';
import { createDeploymentRunner } from '../../deployer/src/engine.js';
const providers = [
  { id: 'localhost-run' as const, name: 'localhost.run', description: 'Free and registration-free, using the system SSH client; the free channel is rate-limited and its address may change.', requiresToken: false, start: startLocalhostTunnel },
  { id: 'cpolar' as const, name: 'cpolar', description: 'Candidate for routes in mainland China; requires an account Auth Token on first use. The free tier is 1 Mbps with a random address, and speed depends on the actual network.', requiresToken: true, start: startCpolarTunnel },
  { id: 'cloudflare' as const, name: 'Cloudflare', description: cloudflareNotice, requiresToken: false, start: startCloudflareTunnel },
  { id: 'cloudflare-named' as const, name: 'Cloudflare named tunnel', description: cloudflareNamedNotice, requiresToken: false, start: startCloudflareNamedTunnel },
];

if (process.argv.includes('--build-identity')) { console.log(JSON.stringify(daemonIdentity)); process.exit(0); }
const paths = resolveTurnwirePaths();
const directory = paths.state;
// Deployment executes this exact replacement artifact, without locks, writers or services.
if (process.argv.includes('--check-storage')) {
  try { validateStorageFile(join(directory, 'state.db')); }
  catch { console.error('Storage preflight failed; database is unreadable or unsupported. No migration is available.'); process.exit(1); }
  process.exit(0);
}
const database = join(directory, 'state.db');
if (existsSync(database)) validateStorageFile(database);
await mkdir(directory, { recursive: true, mode: 0o700 });
await mkdir(paths.config, { recursive: true, mode: 0o700 });
const lock = join(directory, 'daemon.pid');
try {
  const pid = Number(await readFile(lock, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid daemon.pid; inspect the Turnwire state directory');
  try { process.kill(pid, 0); throw new Error(`turnwire-host is already running (PID ${pid})`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; await unlink(lock); }
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
let store: Store;
try { store = new Store(database); }
catch (error) { await unlink(lock).catch(() => {}); throw error; }
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
  remote = new RemoteController(core, { directory, toolsDirectory: join(paths.cache, 'tools'), webRoot, providers, ...(process.env.TURNWIRE_RELAY_URL ? { initialRelay: { relayUrl: process.env.TURNWIRE_RELAY_URL, token: process.env.TURNWIRE_RELAY_TOKEN ?? '', remoteUrl: process.env.TURNWIRE_REMOTE_URL } } : {}) });
  await core.start();
  deployment = new DeploymentController(store, createDeploymentRunner({ directory, artifactRoot: fileURLToPath(new URL('../../', import.meta.url)) }), remote, remote.activity);
  const server = await startDaemonServer({ identity: daemonIdentity, core, token, port: Number(process.env.TURNWIRE_PORT ?? 9898), webRoot, allowedOrigins: (process.env.TURNWIRE_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(','), remoteAccess: remote, deployment });
  const url = `http://127.0.0.1:${server.port}`;
  await writeFile(paths.clientConfig, JSON.stringify({ url, token, device }, null, 2) + '\n', { mode: 0o600 });
  await chmod(paths.clientConfig, 0o600);
  remote?.start();
  console.log(`Turnwire daemon: ${url}\nRuntime: ${runtime.name}\nClient config: ${paths.clientConfig}\nUse “npm run turnwire -- connect” to get the local connection token.`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; core.seal(); remote?.activity.stopIntake(); const serverClosed = server.close(); await deployment?.close(); await remote?.close(); await remote?.activity.drain(); await serverClosed; await core.dispose(); await unlink(lock).catch(() => {}); process.exit(0); };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop(); });
} catch (error) { core.seal(); remote?.activity.stopIntake(); await deployment?.close(); await remote?.close(); await remote?.activity.drain(); await core.dispose(); await unlink(lock).catch(() => {}); throw error; }
