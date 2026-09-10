import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import { join, delimiter } from 'node:path';
import { createHash } from 'node:crypto';

import type { TunnelHandle, TunnelOptions } from '../tunnel.js';
export const cloudflareNotice = '临时隧道使用 Cloudflare；国内网络可能无法连接或不稳定。长期使用建议选择在目标网络实测可达的自托管 Relay。';
export const cloudflareNamedNotice = '命名隧道指向你自己 Cloudflare 账号下已存在的隧道和域名；入口由第三方解析，长期使用仍建议在目标网络实测可达的自托管 Relay。';
const run = promisify(execFile);

async function executable(path: string) { try { await access(path, constants.X_OK); return true; } catch { return false; } }
async function cloudflared(directory: string, signal: AbortSignal, progress: (message: string) => void) {
  const binary = join(directory, 'tools', 'cloudflared');
  const candidates = [process.env.TURNWIRE_CLOUDFLARED_PATH, binary, ...(process.env.PATH ?? '').split(delimiter).map(path => join(path, 'cloudflared'))];
  for (const candidate of candidates) if (candidate && await executable(candidate)) return candidate;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : undefined;
  if (!arch || !['darwin', 'linux'].includes(process.platform)) throw new Error('请先安装 cloudflared，并将它加入 PATH');
  progress('首次使用，正在下载 Cloudflare 隧道组件…');
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  const release = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', { signal: requestSignal, headers: { accept: 'application/vnd.github+json' } });
  if (!release.ok) throw new Error('无法获取隧道组件，请检查网络后重试，或先安装 cloudflared');
  const metadata = await release.json() as { assets?: Array<{ name: string; browser_download_url: string; digest?: string }> };
  const name = `cloudflared-${process.platform}-${arch}${process.platform === 'darwin' ? '.tgz' : ''}`;
  const asset = metadata.assets?.find(asset => asset.name === name);
  if (!asset?.digest?.match(/^sha256:[a-f0-9]{64}$/) || !asset.browser_download_url.startsWith('https://github.com/cloudflare/cloudflared/releases/download/')) throw new Error('无法验证官方隧道组件，请先安装 cloudflared');
  const response = await fetch(asset.browser_download_url, { signal: requestSignal });
  if (!response.ok || !response.body) throw new Error('隧道组件下载失败，请重试');
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  try { while (true) {
    const { value: chunk, done } = await reader.read(); if (done) break;
    size += chunk.length;
    if (size > 128 * 1024 * 1024) { await reader.cancel(); throw new Error('隧道组件下载大小异常'); }
    chunks.push(chunk);
  } } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) throw new Error('隧道组件校验失败，请重试');
  await mkdir(join(directory, 'tools'), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(directory, 'tools', 'download-'));
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
  const binary = await cloudflared(directory, signal, progress);
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
  progress('正在创建临时公网地址…');
  return new Promise<TunnelHandle>((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error('创建临时地址超时，请检查网络后重新开启')); void close(); }, 60_000);
    const consume = (chunk: Buffer) => {
      log.write(chunk); tail = (tail + chunk.toString()).slice(-16_384);
      publicUrl ??= tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
      registered ||= tail.includes('Registered tunnel connection');
      if (publicUrl && registered && !settled && !signal.aborted) { settled = true; clearTimeout(timeout); resolve({ url: publicUrl, close }); }
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.on('error', () => { clearTimeout(timeout); reject(new Error('无法启动隧道组件，请检查 cloudflared 安装')); });
    child.on('close', () => {
      clearTimeout(timeout); log.end(); signal.removeEventListener('abort', abort); resolveClosed();
      if (!settled) reject(new Error(signal.aborted ? '临时访问启动已取消' : '临时通道启动失败，请检查网络后重试'));
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
  if (!namedTunnel) throw new Error('命名隧道需要先填写隧道名称、公开域名和凭证文件');
  const { name, hostname, credentialsFile, protocol } = namedTunnel;
  const binary = await cloudflared(directory, signal, progress);
  signal.throwIfAborted();
  await mkdir(join(directory, 'tunnel'), { recursive: true, mode: 0o700 });
  const slug = name.replace(/[^A-Za-z0-9_.-]/g, '_');
  const config = join(directory, 'tunnel', `named-${slug}.yml`);
  await writeFile(config, [
    `tunnel: ${JSON.stringify(name)}`,
    `credentials-file: ${JSON.stringify(credentialsFile)}`,
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
  const args = ['tunnel', '--config', config, '--no-autoupdate', ...(protocol === 'auto' ? [] : ['--protocol', protocol]), 'run', name];
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
  progress(`正在连接命名隧道 ${name}…`);
  const url = `https://${hostname}`;
  return new Promise<TunnelHandle>((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error('连接命名隧道超时，请检查凭证文件和网络后重试')); void close(); }, 60_000);
    const consume = (chunk: Buffer) => {
      log.write(chunk); tail = (tail + chunk.toString()).slice(-16_384);
      registered ||= tail.includes('Registered tunnel connection');
      if (registered && !settled && !signal.aborted) { settled = true; clearTimeout(timeout); resolve({ url, close }); }
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.on('error', () => { clearTimeout(timeout); reject(new Error('无法启动隧道组件，请检查 cloudflared 安装')); });
    child.on('close', () => {
      clearTimeout(timeout); log.end(); signal.removeEventListener('abort', abort); resolveClosed();
      if (!settled) reject(new Error(signal.aborted ? '远程访问启动已取消' : `命名隧道 ${name} 启动失败，请检查凭证文件、域名和网络`));
      else if (!stopping && !signal.aborted) exited();
    });
    if (signal.aborted) abort();
  });
}
