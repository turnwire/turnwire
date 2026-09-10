import { z } from 'zod';

const host = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9][A-Za-z0-9.:-]*$/, '填写 IP 或域名，不含协议、端口或路径');
const account = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, '账号格式无效');
const path = z.string().regex(/^\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/, '服务器路径必须是绝对路径，且不含空格或特殊字符');
export const deploymentConfigSchema = z.object({
  host, sshUser: account, sshPort: z.number().int().min(1).max(65535).default(22),
  identityFile: z.string().max(4000).refine(value => value.startsWith('/') && !/[\r\n\0]/.test(value), 'SSH 密钥必须是本机绝对路径').optional(),
  publicAddress: host, email: z.string().email().optional(),
  relayPort: z.number().int().min(1024).max(65535).default(9899),
  serviceUser: account.default('turnwire-relay'),
  installDir: path.default('/opt/turnwire-relay'), configDir: path.default('/etc/turnwire-relay'),
  caddyfile: path.default('/etc/caddy/Caddyfile'), caddyService: account.default('caddy'), caddyGroup: account.default('caddy'),
  certbotDir: path.default('/opt/turnwire-certbot'), certName: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).default('turnwire-relay'),
  acmeWebroot: path.default('/var/lib/turnwire-acme'),
  connectAfterDeploy: z.boolean().default(true),
}).strict();
export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;
export const deploymentStatusSchema = z.object({
  id: z.string().optional(), state: z.enum(['idle', 'running', 'succeeded', 'failed', 'interrupted']),
  message: z.string(), phase: z.string().optional(), startedAt: z.string().optional(), finishedAt: z.string().optional(),
  config: deploymentConfigSchema.optional(), publicUrl: z.string().optional(), release: z.string().optional(),
  steps: z.array(z.object({ time: z.string(), message: z.string() })).default([]),
});
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;
