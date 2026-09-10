import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import QRCode from 'qrcode';
import type { LocalClient } from '@turnwire/sdk';
import type { PairingResult, RemoteStatus, DeploymentConfig, DeploymentStatus } from '@turnwire/protocol';

export function safe(text: string) { return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''); }
export function printRemote(status: RemoteStatus) {
  console.log(`${status.mode}${status.mode === 'temporary' ? ' / ' + (status.provider ?? 'cloudflare') : ''} · ${status.state}\n${safe(status.message)}`);
  if (status.remoteUrl) console.log(`手机入口：${safe(status.remoteUrl)}`);
  for (const notice of status.notices) console.log(safe(notice));
}
export interface TerminalIO {
  ask(prompt: string, secret?: boolean): Promise<string | undefined>;
  write(text: string): void;
}
export const terminalIO: TerminalIO = {
  write: text => console.log(text),
  ask: (prompt, secret = false) => new Promise(resolveAnswer => {
    if (!process.stdin.isTTY) throw new Error('交互界面需要终端；脚本请使用 turnwire 的子命令');
    const output = secret ? new Writable({ write(_chunk, _encoding, callback) { callback(); } }) : process.stdout;
    const input = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
    if (secret) process.stdout.write(prompt);
    input.once('close', () => { if (secret) process.stdout.write('\n'); resolveAnswer(undefined); });
    input.once('SIGINT', () => input.close());
    input.question(secret ? '' : prompt, answer => { resolveAnswer(answer); input.close(); });
  }),
};

export async function printPairing(pairing: PairingResult, options: { qr?: boolean; qrFile?: string } = {}) {
  const text = pairing.url ?? pairing.code;
  console.log(pairing.url ? `手机配对链接：\n${text}` : `配对码（粘贴到手机页面）：\n${text}`);
  if (options.qr && pairing.url) {
    const width = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules.size + 8;
    if (process.stdout.isTTY && process.stdout.columns < width) console.log(`二维码需要至少 ${width} 列。请放大终端，或使用 --qr-file pairing.png。`);
    else console.log(await QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'M', margin: 4 }));
  }
  if (options.qrFile) {
    if (!pairing.url) throw new Error('Relay 尚未配置手机网页地址，请使用配对码');
    const target = resolve(options.qrFile);
    const buffer = await QRCode.toBuffer(text, { type: 'png', errorCorrectionLevel: 'M', margin: 4, scale: 6 });
    await writeFile(target, buffer, { flag: 'wx', mode: 0o600 });
    console.log(`配对二维码：${target}`);
  }
}

/** Input and rendering only; all decisions, credentials and lifecycle live in the daemon. */
export async function remoteMenu(client: LocalClient, io: TerminalIO = terminalIO) {
  while (true) {
    const status = await client.remoteStatus();
    io.write(`\n远程控制 · ${status.mode}${status.mode === 'temporary' ? ' / ' + (status.provider ?? 'cloudflare') : ''} · ${status.state}\n${safe(status.message)}`);
    for (const notice of status.notices) io.write(safe(notice));
    if (status.remoteUrl) io.write(`手机入口：${safe(status.remoteUrl)}`);
    io.write('1 临时隧道   2 自托管 Relay   3 关闭远程访问\n4 配对手机   5 已配对设备   6 撤销设备   7 刷新状态   8 一键部署服务器   9 局域网直连   10 通知   11 升级设备配对   0 返回');
    const choice = await io.ask('选择 > ');
    if (choice === undefined || choice.trim() === '0') return;
    try {
      switch (choice.trim()) {
        case '1': {
          const providers = status.providers.length ? status.providers : [{ id: 'cloudflare' as const, name: 'Cloudflare', description: '', requiresToken: false }];
          providers.forEach((provider, index) => io.write(`${index + 1} ${provider.name} · ${provider.description}`));
          const answer = await io.ask('选择临时通道（留空返回）> '); if (!answer?.trim()) break;
          const provider = providers[Number(answer) - 1]; if (!provider) throw new Error('通道序号无效');
          let token: string | undefined; if (provider.requiresToken) { token = await io.ask(status.hasCpolarToken ? 'cpolar Auth Token（已保存，可留空）> ' : 'cpolar Auth Token > ', true); if (token === undefined) break; }
          await client.configureRemote({ mode: 'temporary', provider: provider.id, ...(token?.trim() ? { cpolarToken: token.trim() } : {}) }); break;
        }
        case '2': {
          const serverUrl = await io.ask(`服务器地址${status.relayServerUrl ? '（留空使用 ' + safe(status.relayServerUrl) + '）' : ''} > `);
          if (serverUrl === undefined) break;
          const token = await io.ask('Relay 连接密钥（已保存的同一服务器可留空）> ', true);
          if (token === undefined) break;
          await client.configureRemote({ mode: 'relay', serverUrl: serverUrl.trim() || status.relayServerUrl || '', ...(token.trim() ? { token: token.trim() } : {}) });
          break;
        }
        case '9': await directMenu(client, io); break;
        case '10': await notificationsMenu(client, io); break;
        case '11': { const devices = await client.devices(); devices.forEach((device, index) => io.write(`${index + 1} ${safe(device.name)} · v${device.protocol ?? 1}`)); const selected = await io.ask('升级设备序号（原配对将失效，留空返回）> '); if (!selected?.trim()) break; const device = devices[Number(selected) - 1]; if (!device) throw new Error('设备序号无效'); await printPairing(await client.upgradeDevice(device.id), { qr: true }); break; }
        case '3': await client.configureRemote({ mode: 'off' }); break;
        case '4': {
          const name = await io.ask('设备名称（默认：我的手机）> ');
          if (name !== undefined) await printPairing(await client.pairDevice(name.trim() || '我的手机'), { qr: true });
          break;
        }
        case '5': for (const device of await client.devices()) io.write(`${device.id}  ${safe(device.name)}  ${device.connection ?? 'unconfirmed'}${device.lastConfirmedAt ? ' · 最近确认 ' + device.lastConfirmedAt : ' · 尚未确认手机连通'}`); break;
        case '6': {
          const devices = await client.devices();
          devices.forEach((device, index) => io.write(`${index + 1}  ${safe(device.name)}  ${device.id}`));
          const selected = await io.ask('撤销设备序号（留空返回）> ');
          if (!selected?.trim()) break;
          const device = devices[Number(selected.trim()) - 1];
          if (!device) throw new Error('设备序号无效');
          await client.revokeDevice(device.id); break;
        }
        case '7': break;
        case '8': await deploymentMenu(client,io); break;
        default: io.write('请选择 0–8');
      }
    } catch (error) { io.write(safe(error instanceof Error ? error.message : String(error))); }
  }
}

export async function watchDeployment(client: LocalClient, io: TerminalIO = terminalIO): Promise<DeploymentStatus> {
  let stopped=false,previous='';const stop=()=>{stopped=true;};process.once('SIGINT',stop);
  try { while(true) {
    const status=await client.deploymentStatus();
    if(status.message!==previous){io.write(`${status.state} · ${safe(status.message)}`);previous=status.message;}
    if(status.state!=='running' || stopped)return status;
    await new Promise(resolve=>setTimeout(resolve,500));
  } } finally {process.off('SIGINT',stop);}
}
export async function deploymentMenu(client: LocalClient, io: TerminalIO = terminalIO) {
  const status=await client.deploymentStatus();
  if(status.state==='running'){io.write('部署在 daemon 中继续；Ctrl+C 只退出进度查看。');await watchDeployment(client,io);return;}
  io.write('一键部署 Relay · Debian/Ubuntu + systemd\n使用 SSH 私钥或 agent，账号需要管理员权限或免密 sudo。配置保存在本机私有状态，服务器生成并保留连接密钥。');
  const file=await io.ask('私有 JSON 配置路径（留空填写表单；Ctrl+C 返回）> ');if(file===undefined)return;
  let config:Partial<DeploymentConfig>;
  if(file.trim())config=JSON.parse(await readFile(resolve(file.trim()),'utf8')) as Partial<DeploymentConfig>;
  else {
    config={...status.config};
    for(const [key,label] of [['host','SSH 服务器 IP / 域名'],['sshUser','SSH 登录账号'],['identityFile','SSH 私钥绝对路径（留空使用 agent）'],['publicAddress','手机入口 IP / 域名'],['email','证书邮箱（可选）']] as const) {
      const answer=await io.ask(`${label}${config[key]?' [已保存：'+safe(String(config[key]))+']':''} > `);if(answer===undefined)return;
      if(answer.trim())config[key]=answer.trim();
    }
    const port=await io.ask(`SSH 端口 [${config.sshPort ?? 22}] > `);if(port===undefined)return;if(port.trim())config.sshPort=Number(port);
    const connect=await io.ask('部署后连接本机？[Y/n] > ');if(connect===undefined)return;config.connectAfterDeploy=connect.trim().toLowerCase()!=='n';
  }
  await client.deployRelay(config);await watchDeployment(client,io);
}

/** Quotes group arguments; no shell expansion, pipes or subprocess evaluation. */
export function commandWords(line: string): string[] {
  const words: string[] = []; let word = ''; let quote: string | undefined; let escaped = false; let started = false;
  for (const char of line) {
    if (escaped) { word += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = undefined; else word += char; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) { if (started) { words.push(word); word = ''; started = false; } continue; }
    word += char; started = true;
  }
  if (escaped || quote) throw new Error('引号或转义尚未结束');
  if (started) words.push(word);
  return words;
}

export async function runTui(run: (args: string[]) => Promise<unknown>, help: string, io: TerminalIO = terminalIO) {
  io.write('Turnwire 交互终端\n命令与 CLI 相同；输入 remote 打开远程设置，attach <会话 ID> 接续对话。\n输入 help 查看命令，quit 退出。退出不会停止任务。');
  io.write(help);
  while (true) {
    const line = await io.ask('turnwire > ');
    if (line === undefined) return;
    try {
      const args = commandWords(line.trim());
      if (!args.length) continue;
      if (args.length === 1 && ['quit', 'exit'].includes(args[0]!)) return;
      if (args[0] === 'tui') { io.write('当前已在交互终端中'); continue; }
      await run(args);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!['commander.help', 'commander.helpDisplayed', 'commander.version'].includes(code ?? '')) io.write(safe(error instanceof Error ? error.message : String(error)));
    }
  }
}

export async function directMenu(client: LocalClient, io: TerminalIO = terminalIO) {
  const status = await client.directStatus(); io.write(`${status.message}\n本机候选地址：${status.candidates.join(', ') || '暂无'}`);
  const enabled = await io.ask('1 配置并开启局域网直连   2 关闭   0 返回 > ');
  if (enabled === '2') { io.write(JSON.stringify(await client.configureDirect({ enabled: false }), null, 2)); return; }
  if (enabled !== '1') return;
  const fields = [['url', 'WSS 地址（域名解析到局域网主机）'], ['listenHost', '监听地址（默认 0.0.0.0）'], ['port', '监听端口（留空使用 WSS 地址端口）'], ['certificatePath', '浏览器信任的证书路径'], ['privateKeyPath', '私钥路径']] as const;
  const value: Record<string, unknown> = { enabled: true };
  for (const [key, label] of fields) { const answer = await io.ask(label + ' > '); if (answer === undefined) return; if (answer.trim()) value[key] = key === 'port' ? Number(answer) : answer.trim(); }
  io.write(JSON.stringify(await client.configureDirect(value as Parameters<LocalClient['configureDirect']>[0]), null, 2));
}
export async function notificationsMenu(client: LocalClient, io: TerminalIO = terminalIO) {
  const status = await client.notificationStatus(); io.write(`${status.message}\n待投递：${status.queued}`);
  const choice = await io.ask('1 允许手机订阅通知   2 关闭主机通知   0 返回 > ');
  if (choice === '1' || choice === '2') io.write(JSON.stringify(await client.configureNotifications(choice === '1'), null, 2));
}
