import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, delimiter } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TunnelOptions } from '../tunnel.js';
import { processTunnel, providerEnvironment, publicOrigin } from './process.js';
const run = promisify(execFile);
// Official probezy/homebrew-core Formula/cpolar.rb, version 3.3.18.
const digests: Record<string, string> = { arm64: 'f733f2bfa09e3428254d2239121bdd4dd7fe301b4b1c901cb0a89ddbe71bf01f', x64: '524aea23e8f59e0f1acb1c71bf2ec56e571193d7b470a336934857a58f3f015e' };
export async function cpolarBinary(options: TunnelOptions): Promise<string> {
  const binary = join(options.directory, 'tools', 'cpolar');
  for (const path of [process.env.TURNWIRE_CPOLAR_PATH, binary, ...(process.env.PATH ?? '').split(delimiter).map(p => join(p, 'cpolar'))]) {
    if (path) { try { await access(path, constants.X_OK); return path; } catch {} }
  }
  if (process.platform !== 'darwin' || !digests[process.arch]) throw new Error('请安装 cpolar 并加入 PATH，或设置 TURNWIRE_CPOLAR_PATH');
  options.progress('首次使用，正在下载并校验 cpolar 组件…');
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(180_000)]);
  const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
  const response = await fetch(`https://www.cpolar.com/static/downloads/releases/3.3.18/cpolar-stable-darwin-${arch}.zip`, { signal });
  if (!response.ok || !response.body) throw new Error('cpolar 组件下载失败，请检查网络');
  const chunks: Uint8Array[] = []; let size = 0; const reader = response.body.getReader();
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 128 * 1024 * 1024) { await reader.cancel(); throw new Error('cpolar 下载大小异常'); } chunks.push(value); } } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== digests[process.arch]) throw new Error('cpolar 官方组件校验失败，请重试');
  await mkdir(join(options.directory, 'tools'), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(options.directory, 'tools', 'cpolar-download-'));
  try { const zip = join(temporary, 'release.zip'); await writeFile(zip, bytes, { mode: 0o600 }); await run('/usr/bin/unzip', ['-o', zip, 'cpolar', '-d', temporary], { signal, env: providerEnvironment() }); options.signal.throwIfAborted(); await chmod(join(temporary, 'cpolar'), 0o700); await rename(join(temporary, 'cpolar'), binary); }
  finally { await rm(temporary, { recursive: true, force: true }); }
  return binary;
}
export function cpolarAddress(line: string): string | undefined {
  if (/authentication failed|failed to authenticate|authToken auth failed|invalid authtoken|ERR_CPOLAR|认证失败|验证失败/i.test(line)) throw new Error('cpolar 认证或通道启动失败，请检查 Token、账号额度及网络');
  // cpolar 3.x emits its HTTPS public address in tunnel startup logs.
  const urls = line.match(/https:\/\/[a-z0-9.-]+(?::[0-9]+)?/gi) ?? [];
  for (const value of urls) { const url = publicOrigin(value); if (url && /\.(?:cpolar\.(?:cn|com|io|top)|cpolar\.vip)$/.test(new URL(url).hostname) && !/^https:\/\/(?:www|dashboard|svip)\./.test(url)) return url; }
}
export async function startCpolarTunnel(options: TunnelOptions) {
  if (!options.token) throw new Error('首次使用 cpolar，请填写账号的 Auth Token');
  const binary = await cpolarBinary(options); options.signal.throwIfAborted();
  const directory = join(options.directory, 'tunnel', 'cpolar'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const runDirectory = await mkdtemp(join(directory, 'run-'));
  const config = join(runDirectory, 'config.yml');
  await writeFile(config, `authtoken: ${JSON.stringify(options.token)}\nregion: cn\nweb_addr: 127.0.0.1:0\ninspect_db_size: -1\nupdate: false\n`, { mode: 0o600 }); await chmod(config, 0o600);
  options.progress('正在连接 cpolar 国内通道…');
  // 3.3.18 treats inspect-addr=false as :0; bind explicitly to loopback instead.
  try { return await processTunnel(options, binary, ['http', '-config=' + config, '-daemon=off', '-dashboard=off', '-processMode=single', '-inspect-addr=127.0.0.1:0', '-proto=https', '-log=stdout', '-log-level=INFO', '-region=cn', '-tunnelName=turnwire', `127.0.0.1:${options.port}`], cpolarAddress, 'cpolar 未能建立通道，请检查 Token、免费账号在线进程额度和网络', () => rm(runDirectory, { recursive: true, force: true })); }
  catch (error) { await rm(runDirectory, { recursive: true, force: true }); throw error; }
}
