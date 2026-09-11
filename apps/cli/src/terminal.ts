import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import QRCode from 'qrcode';
import type { LocalClient } from '@turnwire/sdk';
import type { PairingResult, RemoteStatus, DeploymentConfig, DeploymentStatus } from '@turnwire/protocol';
import { localizedError, messageForError, t } from './i18n.js';

export function safe(text: string) { return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''); }
export function printRemote(status: RemoteStatus) {
  console.log(`${status.mode}${status.mode === 'temporary' ? ' / ' + (status.provider ?? 'cloudflare') : ''} · ${status.state}\n${safe(status.message)}`);
  if (status.remoteUrl) console.log(t('terminal.entry', { url: safe(status.remoteUrl) }));
  if (status.health) for (const [stage, state] of Object.entries(status.health)) console.log(`${stage}: ${safe(state)}`);
  for (const notice of status.notices) console.log(safe(notice));
}
export interface TerminalIO {
  ask(prompt: string, secret?: boolean): Promise<string | undefined>;
  write(text: string): void;
}
export const terminalIO: TerminalIO = {
  write: text => console.log(text),
  ask: (prompt, secret = false) => new Promise(resolveAnswer => {
    if (!process.stdin.isTTY) throw localizedError('CLI_PROMPT_TTY');
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
  console.log(pairing.url ? t('pairing.link', { text }) : t('pairing.code', { text }));
  if (options.qr && pairing.url) {
    const width = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules.size + 8;
    if (process.stdout.isTTY && process.stdout.columns < width) console.log(t('pairing.qrTooNarrow', { width }));
    else console.log(await QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'M', margin: 4 }));
  }
  if (options.qrFile) {
    if (!pairing.url) throw localizedError('CLI_RELAY_URL_REQUIRED');
    const target = resolve(options.qrFile);
    const buffer = await QRCode.toBuffer(text, { type: 'png', errorCorrectionLevel: 'M', margin: 4, scale: 6 });
    await writeFile(target, buffer, { flag: 'wx', mode: 0o600 });
    console.log(t('pairing.qrSaved', { path: target }));
  }
}

/** Input and rendering only; all decisions, credentials and lifecycle live in the daemon. */
export async function remoteMenu(client: LocalClient, io: TerminalIO = terminalIO) {
  while (true) {
    const status = await client.remoteStatus();
    io.write(t('remote.title', { mode: status.mode, provider: status.mode === 'temporary' ? ' / ' + (status.provider ?? 'cloudflare') : '', state: status.state, message: safe(status.message) }));
    for (const notice of status.notices) io.write(safe(notice));
    if (status.remoteUrl) io.write(t('terminal.entry', { url: safe(status.remoteUrl) }));
    io.write(t('remote.menu'));
    const choice = await io.ask(t('remote.choose'));
    if (choice === undefined || choice.trim() === '0') return;
    try {
      switch (choice.trim()) {
        case '1': {
          const providers = status.providers.length ? status.providers : [{ id: 'cloudflare' as const, name: 'Cloudflare', description: '', requiresToken: false }];
          providers.forEach((provider, index) => io.write(`${index + 1} ${provider.name} · ${provider.description}`));
          const answer = await io.ask(t('remote.chooseProvider')); if (!answer?.trim()) break;
          const provider = providers[Number(answer) - 1]; if (!provider) throw localizedError('CLI_TUNNEL_SELECTION');
          let token: string | undefined; if (provider.requiresToken) { token = await io.ask(status.hasCpolarToken ? t('remote.cpolarTokenSaved') : t('remote.cpolarToken'), true); if (token === undefined) break; }
          // A named tunnel already exists under the operator's account, so only its reference is collected.
          let namedTunnel: { name: string; hostname: string; credentialsFile: string; protocol: 'auto' | 'http2' | 'quic' } | undefined;
          if (provider.id === 'cloudflare-named') {
            const name = await io.ask(t('remote.tunnelName')); if (name === undefined) break;
            const hostname = await io.ask(t('remote.tunnelHostname')); if (hostname === undefined) break;
            const credentialsFile = await io.ask(t('remote.tunnelCredentials')); if (credentialsFile === undefined) break;
            const transport = (await io.ask(t('remote.tunnelProtocol')))?.trim() || 'http2';
            if (!name.trim() || !hostname.trim() || !credentialsFile.trim()) { io.write(t('remote.namedTunnelFields')); break; }
            if (!['auto', 'http2', 'quic'].includes(transport)) { io.write(t('remote.tunnelProtocolInvalid')); break; }
            namedTunnel = { name: name.trim(), hostname: hostname.trim(), credentialsFile: credentialsFile.trim(), protocol: transport as 'auto' | 'http2' | 'quic' };
          }
          await client.configureRemote({ mode: 'temporary', provider: provider.id, ...(token?.trim() ? { cpolarToken: token.trim() } : {}), ...(namedTunnel ? { namedTunnel } : {}) }); break;
        }
        case '2': {
          const serverUrl = await io.ask(t('remote.relayServer', { saved: status.relayServerUrl ? t('remote.relayServerSaved', { url: safe(status.relayServerUrl) }) : '' }));
          if (serverUrl === undefined) break;
          const token = await io.ask(t('remote.relayToken'), true);
          if (token === undefined) break;
          await client.configureRemote({ mode: 'relay', serverUrl: serverUrl.trim() || status.relayServerUrl || '', ...(token.trim() ? { token: token.trim() } : {}) });
          break;
        }
        case '9': await directMenu(client, io); break;
        case '10': await notificationsMenu(client, io); break;
        case '11': { const devices = await client.devices(); devices.forEach((device, index) => io.write(`${index + 1} ${safe(device.name)} · v${device.protocol ?? 1}`)); const selected = await io.ask(t('remote.upgradeDevice')); if (!selected?.trim()) break; const device = devices[Number(selected) - 1]; if (!device) throw localizedError('CLI_DEVICE_SELECTION'); await printPairing(await client.upgradeDevice(device.id), { qr: true }); break; }
        case '3': await client.configureRemote({ mode: 'off' }); break;
        case '4': {
          const name = await io.ask(t('remote.deviceName', { default: t('device.defaultName') }));
          if (name !== undefined) await printPairing(await client.pairDevice(name.trim() || t('device.defaultName')), { qr: true });
          break;
        }
        case '5': for (const device of await client.devices()) io.write(`${device.id}  ${safe(device.name)}  ${device.connection ?? 'unconfirmed'}${device.lastConfirmedAt ? t('remote.deviceConfirmed', { time: device.lastConfirmedAt }) : t('remote.deviceUnconfirmed')}`); break;
        case '6': {
          const devices = await client.devices();
          devices.forEach((device, index) => io.write(`${index + 1}  ${safe(device.name)}  ${device.id}`));
          const selected = await io.ask(t('remote.revokeDevice'));
          if (!selected?.trim()) break;
          const device = devices[Number(selected.trim()) - 1];
          if (!device) throw localizedError('CLI_DEVICE_SELECTION');
          await client.revokeDevice(device.id); break;
        }
        case '7': break;
        case '8': await deploymentMenu(client,io); break;
        default: io.write(t('remote.choiceRange'));
      }
    } catch (error) { io.write(safe(messageForError((error as { code?: string }).code, error instanceof Error ? error.message : String(error)))); }
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
  if(status.state==='running'){io.write(t('deploy.running'));await watchDeployment(client,io);return;}
  io.write(t('deploy.intro'));
  const file=await io.ask(t('deploy.configPath'));if(file===undefined)return;
  let config:Partial<DeploymentConfig>;
  if(file.trim())config=JSON.parse(await readFile(resolve(file.trim()),'utf8')) as Partial<DeploymentConfig>;
  else {
    config={...status.config};
    for(const [key,label] of [['host','deploy.label.host'],['sshUser','deploy.label.sshUser'],['identityFile','deploy.label.identityFile'],['publicAddress','deploy.label.publicAddress'],['email','deploy.label.email']] as const) {
      const answer=await io.ask(`${t(label)}${config[key]?t('deploy.saved',{value:safe(String(config[key]))}):''} > `);if(answer===undefined)return;
      if(answer.trim())config[key]=answer.trim();
    }
    const port=await io.ask(t('deploy.port', { port: config.sshPort ?? 22 }));if(port===undefined)return;if(port.trim())config.sshPort=Number(port);
    const connect=await io.ask(t('deploy.connectAfter'));if(connect===undefined)return;config.connectAfterDeploy=connect.trim().toLowerCase()!=='n';
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
  if (escaped || quote) throw localizedError('CLI_PARSE_INCOMPLETE');
  if (started) words.push(word);
  return words;
}

export async function runTui(run: (args: string[]) => Promise<unknown>, help: string, io: TerminalIO = terminalIO) {
  io.write(t('tui.intro'));
  io.write(help);
  while (true) {
    const line = await io.ask(t('tui.prompt'));
    if (line === undefined) return;
    try {
      const args = commandWords(line.trim());
      if (!args.length) continue;
      if (args.length === 1 && ['quit', 'exit'].includes(args[0]!)) return;
      if (args[0] === 'tui') { io.write(t('tui.already')); continue; }
      await run(args);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!['commander.help', 'commander.helpDisplayed', 'commander.version'].includes(code ?? '')) io.write(safe(messageForError(code, error instanceof Error ? error.message : String(error))));
    }
  }
}

export async function directMenu(client: LocalClient, io: TerminalIO = terminalIO) {
  const status = await client.directStatus(); io.write(t('direct.title', { message: status.message, addresses: status.candidates.join(', ') || t('direct.none') }));
  const enabled = await io.ask(t('direct.choose'));
  if (enabled === '2') { io.write(JSON.stringify(await client.configureDirect({ enabled: false }), null, 2)); return; }
  if (enabled !== '1') return;
  const fields = [['url', 'direct.field.url'], ['listenHost', 'direct.field.listenHost'], ['port', 'direct.field.port'], ['certificatePath', 'direct.field.certificatePath'], ['privateKeyPath', 'direct.field.privateKeyPath']] as const;
  const value: Record<string, unknown> = { enabled: true };
  for (const [key, label] of fields) { const answer = await io.ask(t(label) + ' > '); if (answer === undefined) return; if (answer.trim()) value[key] = key === 'port' ? Number(answer) : answer.trim(); }
  io.write(JSON.stringify(await client.configureDirect(value as Parameters<LocalClient['configureDirect']>[0]), null, 2));
}
export async function notificationsMenu(client: LocalClient, io: TerminalIO = terminalIO) {
  const status = await client.notificationStatus(); io.write(t('notifications.title', { message: status.message, queued: status.queued }));
  const choice = await io.ask(t('notifications.choose'));
  if (choice === '1' || choice === '2') io.write(JSON.stringify(await client.configureNotifications(choice === '1'), null, 2));
}
