import { isIP } from 'node:net';
import { deploymentConfigSchema, type DeploymentConfig } from '../../../packages/protocol/src/deployment.js';

export function normalizeConfig(value: unknown): DeploymentConfig {
  const parsed = deploymentConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；'));
  for (const address of [parsed.data.host, parsed.data.publicAddress]) {
    if (!isIP(address) && (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(address) || /^[\d.]+$/.test(address))) throw new Error('服务器地址必须是有效 IP 或完整域名');
  }
  const c = parsed.data;
  if (c.serviceUser === 'root') throw new Error('Relay 运行账号必须是非 root 系统账号');
  for (const folder of [c.installDir, c.configDir, c.certbotDir]) if (folder.split('/').length < 3) throw new Error('安装目录不能覆盖系统顶层目录');
  if (c.installDir === c.configDir || c.caddyfile.startsWith(c.installDir + '/')) throw new Error('安装目录、私有配置和共享 Caddy 配置必须分开');
  return c;
}
export function publicURL(c: Pick<DeploymentConfig, 'publicAddress'>, scheme = 'https') { return `${scheme}://${isIP(c.publicAddress) === 6 ? '[' + c.publicAddress + ']' : c.publicAddress}`; }
export function shellQuote(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
export function serverConfig(c: DeploymentConfig) { const { identityFile, ...server } = c; return server; }
export const NODE_VERSION = '22.23.2';
export const CERTBOT_VERSION = '5.8.0';
