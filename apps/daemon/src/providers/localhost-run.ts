import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TunnelOptions } from '../tunnel.js';
import { processTunnel, publicOrigin } from './process.js';

export function localhostAddress(line: string): string | undefined {
  // Only machine-readable tunnel announcements; ignore documentation / account links in the banner.
  if (!line.startsWith('{')) return;
  let event: Record<string, unknown>; try { event = JSON.parse(line); } catch { return; }
  if (event.event !== 'tcpip-forward' || event.status !== 'success' || event.tls_termination !== true || event.type !== 'opened') return;
  const values = JSON.stringify(event).match(/(?:https:\/\/)?[a-z0-9-]+\.(?:lhr\.life|lhr\.rocks|localhost\.run)/gi) ?? [];
  for (const value of values) { if (value.includes('admin.localhost.run')) continue; const url = publicOrigin(value.startsWith('https://') ? value : 'https://' + value); if (url) return url; }
}
export async function startLocalhostTunnel(options: TunnelOptions) {
  const directory = join(options.directory, 'tunnel', 'localhost-run'); await mkdir(directory, { recursive: true, mode: 0o700 });
  options.progress('正在通过 localhost.run 创建免注册地址…');
  return processTunnel(options, process.env.TURNWIRE_SSH_PATH ?? '/usr/bin/ssh', [
    '-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityFile=none',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=' + join(directory, 'known_hosts'), '-o', 'ConnectTimeout=15', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', '-R', `80:127.0.0.1:${options.port}`, 'nokey@localhost.run', '--', '--output', 'json',
  ], localhostAddress, 'localhost.run 连接失败，请检查网络或选择其他通道');
}
