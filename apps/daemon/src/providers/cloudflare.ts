import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import { join, delimiter } from 'node:path';
import { createHash } from 'node:crypto';

import type { TunnelHandle, TunnelOptions } from '../tunnel.js';
export const cloudflareNotice = 'The temporary tunnel uses Cloudflare; networks in mainland China may fail to connect or be unstable. For long-term use, prefer a self-hosted Relay measured as reachable from the target network.';
export const cloudflareNamedNotice = 'A named tunnel points at a tunnel and hostname that already exist in your own Cloudflare account; the endpoint is resolved by a third party, so for long-term use a self-hosted Relay measured as reachable from the target network is still recommended.';
const run = promisify(execFile);

async function executable(path: string) { try { await access(path, constants.X_OK); return true; } catch { return false; } }
async function cloudflared(directory: string, signal: AbortSignal, progress: (message: string) => void, toolsDirectory = join(directory, 'tools')) {
  const binary = join(toolsDirectory, 'cloudflared');
  const candidates = [process.env.TURNWIRE_CLOUDFLARED_PATH, binary, ...(process.env.PATH ?? '').split(delimiter).map(path => join(path, 'cloudflared'))];
  for (const candidate of candidates) if (candidate && await executable(candidate)) return candidate;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : undefined;
  if (!arch || !['darwin', 'linux'].includes(process.platform)) throw new Error('Install cloudflared first and add it to PATH');
  progress('First run: downloading the Cloudflare tunnel component…');
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  const release = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', { signal: requestSignal, headers: { accept: 'application/vnd.github+json' } });
  if (!release.ok) throw new Error('Cannot fetch the tunnel component; check the network and retry, or install cloudflared first');
  const metadata = await release.json() as { assets?: Array<{ name: string; browser_download_url: string; digest?: string }> };
  const name = `cloudflared-${process.platform}-${arch}${process.platform === 'darwin' ? '.tgz' : ''}`;
  const asset = metadata.assets?.find(asset => asset.name === name);
  if (!asset?.digest?.match(/^sha256:[a-f0-9]{64}$/) || !asset.browser_download_url.startsWith('https://github.com/cloudflare/cloudflared/releases/download/')) throw new Error('Cannot verify the official tunnel component; install cloudflared first');
  const response = await fetch(asset.browser_download_url, { signal: requestSignal });
  if (!response.ok || !response.body) throw new Error('Tunnel component download failed; try again');
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  try { while (true) {
    const { value: chunk, done } = await reader.read(); if (done) break;
    size += chunk.length;
    if (size > 128 * 1024 * 1024) { await reader.cancel(); throw new Error('Unexpected tunnel component download size'); }
    chunks.push(chunk);
  } } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) throw new Error('Tunnel component verification failed; try again');
  await mkdir(toolsDirectory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(toolsDirectory, 'download-'));
  try {
    const downloaded = join(temporary, process.platform === 'darwin' ? 'release.tgz' : 'cloudflared');
    await writeFile(downloaded, bytes, { mode: 0o600 });
    if (process.platform === 'darwin') await run('tar', ['-xzf', downloaded, '-C', temporary, 'cloudflared'], { signal });
    signal.throwIfAborted();
    await chmod(join(temporary, 'cloudflared'), 0o700);
    await rename(join(temporary, 'cloudflared'), binary);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return binary;
}

export async function startCloudflareTunnel(options: TunnelOptions): Promise<TunnelHandle> {
  const { directory, port, signal, progress, exited } = options;
  const binary = await cloudflared(directory, signal, progress, options.toolsDirectory);
  signal.throwIfAborted();
  await mkdir(join(directory, 'tunnel'), { recursive: true, mode: 0o700 });
  const config = join(directory, 'tunnel', 'config.yml');
  await writeFile(config, '{}\n', { mode: 0o600 });
  const log = createWriteStream(join(directory, 'tunnel', 'cloudflared.log'), { flags: 'a', mode: 0o600 });
  log.on('error', () => {});
  // Provider processes do not need Turnwire tokens or model credentials.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(binary, ['tunnel', '--config', config, '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stopping = false; let settled = false; let tail = ''; let publicUrl: string | undefined; let registered = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const close = async () => {
    if (!stopping) { stopping = true; child.kill('SIGTERM'); }
    const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 4000);
    force.unref(); await closed; clearTimeout(force);
  };
  const abort = () => { void close(); };
  signal.addEventListener('abort', abort, { once: true });
  progress('Creating a temporary public address…');
  return new Promise<TunnelHandle>((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error('Creating the temporary address timed out; check the network and turn it on again')); void close(); }, 60_000);
    const consume = (chunk: Buffer) => {
      log.write(chunk); tail = (tail + chunk.toString()).slice(-16_384);
      publicUrl ??= tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
      registered ||= tail.includes('Registered tunnel connection');
      if (publicUrl && registered && !settled && !signal.aborted) { settled = true; clearTimeout(timeout); resolve({ url: publicUrl, close }); }
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.on('error', () => { clearTimeout(timeout); reject(new Error('Cannot start the tunnel component; check the cloudflared installation')); });
    child.on('close', () => {
      clearTimeout(timeout); log.end(); signal.removeEventListener('abort', abort); resolveClosed();
      if (!settled) reject(new Error(signal.aborted ? 'Temporary access startup was cancelled' : 'Temporary channel startup failed; check the network and try again'));
      else if (!stopping && !signal.aborted) exited();
    });
    if (signal.aborted) abort();
  });
}

/**
 * Runs an existing tunnel that the operator already created under their own account. Unlike the
 * quick tunnel, the public address is configured rather than discovered, so it survives restarts
 * and a paired client keeps working.
 *
 * The generated ingress goes in the daemon's own state directory, never in
 * `~/.cloudflared/config.yml`: cloudflared shares that file with the operator's other tunnels, so
 * writing it here would replace their ingress.
 */
export async function startCloudflareNamedTunnel(options: TunnelOptions): Promise<TunnelHandle> {
  const { directory, port, signal, progress, exited, namedTunnel } = options;
  if (!namedTunnel) throw new Error('A named tunnel requires a tunnel name, public hostname, and credentials file first');
  const { name, hostname, credentialsFile, protocol } = namedTunnel;
  const binary = await cloudflared(directory, signal, progress, options.toolsDirectory);
  signal.throwIfAborted();
  await mkdir(join(directory, 'tunnel'), { recursive: true, mode: 0o700 });
  const slug = name.replace(/[^A-Za-z0-9_.-]/g, '_');
  const config = join(directory, 'tunnel', `named-${slug}.yml`);
  await writeFile(config, [
    `tunnel: ${JSON.stringify(name)}`,
    `credentials-file: ${JSON.stringify(credentialsFile)}`,
    // Written here rather than passed as a flag: this is the form measured to connect on a
    // network where cloudflared's default transport failed. `auto` omits it entirely.
    ...(protocol === 'auto' ? [] : [`protocol: ${protocol}`]),
    'ingress:',
    `  - hostname: ${JSON.stringify(hostname)}`,
    `    service: http://127.0.0.1:${port}`,
    '  - service: http_status:404',
    '',
  ].join('\n'), { mode: 0o600 });
  const log = createWriteStream(join(directory, 'tunnel', `cloudflared-${slug}.log`), { flags: 'a', mode: 0o600 });
  log.on('error', () => {});
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) if (process.env[key]) env[key] = process.env[key];
  const args = ['tunnel', '--config', config, '--no-autoupdate', 'run', name];
  const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stopping = false; let settled = false; let tail = ''; let registered = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const close = async () => {
    if (!stopping) { stopping = true; child.kill('SIGTERM'); }
    const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 4000);
    force.unref(); await closed; clearTimeout(force);
  };
  const abort = () => { void close(); };
  signal.addEventListener('abort', abort, { once: true });
  progress(`Connecting to the named tunnel ${name}…`);
  const url = `https://${hostname}`;
  return new Promise<TunnelHandle>((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error('Connecting to the named tunnel timed out; check the credentials file and network, then retry')); void close(); }, 60_000);
    const consume = (chunk: Buffer) => {
      log.write(chunk); tail = (tail + chunk.toString()).slice(-16_384);
      registered ||= tail.includes('Registered tunnel connection');
      if (registered && !settled && !signal.aborted) { settled = true; clearTimeout(timeout); resolve({ url, close }); }
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.on('error', () => { clearTimeout(timeout); reject(new Error('Cannot start the tunnel component; check the cloudflared installation')); });
    child.on('close', () => {
      clearTimeout(timeout); log.end(); signal.removeEventListener('abort', abort); resolveClosed();
      if (!settled) reject(new Error(signal.aborted ? 'Remote access startup was cancelled' : `Named tunnel ${name} failed to start; check the credentials file, hostname, and network`));
      else if (!stopping && !signal.aborted) exited();
    });
    if (signal.aborted) abort();
  });
}
