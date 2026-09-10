import { Command } from 'commander';
import { readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { LocalClient, RemoteClient, decodePairing, encodePairing, loadHistoryPage, loadHistory, conversation, transcriptMarkdown } from '@turnwire/sdk';
import type { TurnwireClient } from '@turnwire/sdk';
import { tunnelProviderSchema } from '@turnwire/protocol';
import type { TurnwireEvent, Session, Snapshot, ModelCatalog } from '@turnwire/protocol';
import { safe, printRemote, printPairing, remoteMenu, runTui, deploymentMenu, watchDeployment, directMenu, notificationsMenu } from './terminal.js';

export interface CliOptions { url?: string; token?: string; pairing?: string; json?: boolean }
/** Parse the `provider/model` form the model catalog prints, so ids are never hand-built. */
function modelSelection(spec: string, reasoningEffort?: string) {
  const index = spec.indexOf('/');
  if (index < 1 || index === spec.length - 1) throw new Error('模型请用 provider/model 形式，例如 deepseek-official/deepseek-v4-flash');
  return { provider: spec.slice(0, index), model: spec.slice(index + 1), ...(reasoningEffort ? { reasoningEffort } : {}) };
}
function showModel(session: Session) {
  return session.model ? `${session.model.provider}/${session.model.model}${session.model.reasoningEffort ? ' · ' + session.model.reasoningEffort : ''}` : '未指定（使用运行时默认）';
}
export function createProgram(defaults: CliOptions = {}) {
const program = new Command().name('turnwire').description('Turnwire: one local agent session, every device.').version('0.1.0').exitOverride();
program.option('--url <url>', 'daemon URL', defaults.url).option('--token <token>', 'local daemon token', defaults.token).option('--pairing <file>', 'remote pairing file', defaults.pairing).option('--json', 'machine-readable output', defaults.json);
interface Config { url: string; token: string }
async function config(): Promise<Config> {
  const opts = program.opts();
  if (opts.url && opts.token) return { url: String(opts.url), token: String(opts.token) };
  let saved: Config;
  try { saved = JSON.parse(await readFile(join(process.env.TURNWIRE_HOME ?? join(homedir(), '.turnwire'), 'client.json'), 'utf8')) as Config; }
  catch { throw new Error('找不到 daemon 配置。请先运行 npm run dev，或通过 --url 和 --token 连接。'); }
  return { url: opts.url as string ?? saved.url, token: opts.token as string ?? saved.token };
}
async function client(): Promise<TurnwireClient> { const path = program.opts().pairing as string | undefined; if (path) return new RemoteClient(decodePairing(await readFile(path, 'utf8')), { persistPairing: async pairing => { const temporary = path + '.next'; await writeFile(temporary, encodePairing(pairing), { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, path); } }); const c = await config(); return new LocalClient(c.url, c.token); }
function print(value: unknown) { console.log(JSON.stringify(value, null, 2)); }
async function withClient(action: (client: TurnwireClient) => Promise<void>) { const c = await client(); try { await action(c); } finally { c.close(); } }
program.command('status').description('Show daemon, device and runtime status').action(() => withClient(async c => { const snapshot = await c.request<Snapshot>('system.snapshot'); if (program.opts().json) print(snapshot); else { console.log(`${snapshot.device.name} · ${snapshot.sessions.length} sessions`); for (const runtime of snapshot.runtimes) console.log(`${runtime.online ? '●' : '○'} ${runtime.name}: ${safe(runtime.message)}`); } }));
program.command('ls').description('List shared sessions').option('--archived', 'show archived sessions').option('--all', 'include archived sessions').option('--search <query>', 'filter by title or workspace').action((options: { archived?: boolean; all?: boolean; search?: string }) => withClient(async c => {
  const snapshot = await c.request<Snapshot>('system.snapshot'); const query = options.search?.toLocaleLowerCase();
  const sessions = snapshot.sessions.filter(s => (options.all || !!s.archived === !!options.archived) && (!query || (s.title + ' ' + s.cwd).toLocaleLowerCase().includes(query)));
  if (program.opts().json) print(sessions); else for (const s of sessions) console.log(`${s.id}  ${(s.archived ? 'archived' : s.status).padEnd(17)} ${safe(s.title)}  ${safe(s.cwd)}`);
}));
program.command('rename <session> <title>').description('Rename a shared session').action((sessionId: string, title: string) => withClient(async c => print(await c.request('session.rename', { sessionId, title }))));
for (const archived of [true, false]) program.command(`${archived ? 'archive' : 'unarchive'} <session>`).description(archived ? 'Archive an inactive session without deleting history' : 'Return an archived session to the workspace').action((sessionId: string) => withClient(async c => print(await c.request('session.archive', { sessionId, archived }))));
program.command('new [prompt]').description('Create a session in a workspace').option('--cwd <path>', 'workspace directory', process.cwd()).option('--title <title>', 'session title', '新会话').option('--runtime <id>', 'runtime id (dsh or demo)', 'dsh').option('--model <provider/model>', 'model to run the session on; see: turnwire models').option('--effort <id>', 'reasoning effort id for the chosen model').action((prompt: string | undefined, options: { cwd: string; title: string; runtime: string; model?: string; effort?: string }) => withClient(async c => {
  const s = await c.request<Session>('session.create', { cwd: resolve(options.cwd), title: options.title, runtimeId: options.runtime, ...(options.model ? { model: modelSelection(options.model, options.effort) } : {}) });
  if (prompt) await c.request('session.message', { sessionId: s.id, text: prompt });
  if (program.opts().json) print(s); else console.log(`Session ${s.id}\nModel: ${showModel(s)}\nAttach: turnwire attach ${s.id}`);
}));
program.command('models').description('List the models this host can run and the default for new sessions').action(() => withClient(async c => {
  const catalog = await c.request<ModelCatalog>('model.catalog', {});
  if (program.opts().json) { print(catalog); return; }
  console.log(`默认：${catalog.default.provider}/${catalog.default.model}${catalog.default.reasoningEffort ? ' · ' + catalog.default.reasoningEffort : ''}`);
  for (const group of catalog.groups) {
    if (!catalog.routableProviders.includes(group.id)) console.log(`\n${group.name} (${group.id}) · 当前不可服务`);
    else console.log(`\n${group.name} (${group.id})`);
    for (const model of group.models) {
      const efforts = model.reasoning?.efforts.length ? `  effort: ${model.reasoning.efforts.map(e => e.id).join('/')}${model.reasoning.defaultEffort ? ` (默认 ${model.reasoning.defaultEffort})` : ''}` : '';
      console.log(`  ${group.id}/${model.id}  ${model.name}${efforts}`);
    }
  }
  for (const failure of catalog.failures) console.log(`\n不可用：${failure.name} (${failure.id}) — ${failure.message}`);
}));
program.command('model <session> <spec>').description('Choose the model a session runs on (provider/model; see: turnwire models)').option('--effort <id>', 'reasoning effort id for the chosen model').action((sessionId: string, spec: string, options: { effort?: string }) => withClient(async c => {
  // The daemon returns what the runtime resolved, which can differ from the request.
  const updated = await c.request<Session>('session.setModel', { sessionId, ...modelSelection(spec, options.effort) });
  if (program.opts().json) print(updated); else console.log(`${updated.id} · ${showModel(updated)}`);
}));
program.command('history <session>').description('Read recent complete records; load earlier records with --before')
  .option('--before <cursor>', 'load the page before this cursor', Number).option('--limit <count>', 'records per page (1–100)', Number, 40)
  .option('--all', 'explicitly load the complete transcript')
  .action((sessionId: string, options: { before?: number; limit: number; all?: boolean }) => withClient(async c => {
    const page = options.all ? { events: await loadHistory(c, sessionId), hasMore: false, nextBefore: null } : await loadHistoryPage(c, sessionId, options.before, options.limit);
    if (program.opts().json) print(page);
    else { for (const message of conversation(page.events, sessionId)) console.log(`\n${safe(message.tool ?? message.role)}\n${safe(message.input !== undefined ? '输入：\n' + message.input + '\n输出：\n' + (message.output ?? '尚未返回') : message.text)}`);
      if (page.hasMore) console.log(`\n更早记录：turnwire history ${sessionId} --before ${page.nextBefore}`);
    }
  }));
program.command('export <session>').description('Export the shared transcript as Markdown').requiredOption('--output <path>', 'write a private file without overwriting an existing file').action((sessionId: string, options: { output: string }) => withClient(async c => {
  const snapshot = await c.request<Snapshot>('system.snapshot'); const session = snapshot.sessions.find(s => s.id === sessionId); if (!session) throw new Error('会话不存在');
  const messages = conversation(await loadHistory(c, sessionId), sessionId); const path = resolve(options.output);
  await writeFile(path, transcriptMarkdown(session, messages), { flag: 'wx', mode: 0o600 }); print({ path });
}));
program.command('send <session> <prompt>').description('Send a follow-up prompt').action((sessionId: string, text: string) => withClient(async c => print(await c.request('session.message', { sessionId, text }))));
program.command('resume <session>').description('Resume a persisted session').action((sessionId: string) => withClient(async c => print(await c.request('session.resume', { sessionId }))));
program.command('stop <session>').description('Cancel the current agent turn').action((sessionId: string) => withClient(async c => print(await c.request('session.cancel', { sessionId }))));
program.command('result <id>').description('Query a command result after a lost response').action((requestId: string) => withClient(async c => print(await c.request('request.result', { requestId }))));
program.command('inbox').description('Persistent approval inbox').option('--all', 'include resolved and expired items').option('--before <cursor>', 'load older items', Number).action((options: { all?: boolean; before?: number }) => withClient(async c => print(await c.request('inbox.page', { status: options.all ? 'all' : 'pending', before: options.before }))));
program.command('approvals').description('List pending approvals').action(() => withClient(async c => print((await c.request<Snapshot>('system.snapshot')).approvals)));
for (const decision of ['approve', 'reject'] as const) program.command(`${decision} <approval>`).description(`${decision} one pending operation`).action((approvalId: string) => withClient(async c => print(await c.request('approval.decide', { approvalId, decision: decision === 'approve' ? 'approved' : 'rejected' }))));
program.command('attach <session>').description('Follow output and send prompts; Ctrl+C detaches without stopping the agent').action(async (sessionId: string) => {
  const c = await client(); const snapshot = await c.request<Snapshot>('system.snapshot');
  if (!snapshot.sessions.some(s => s.id === sessionId)) { c.close(); throw new Error('会话不存在'); }
  const page = await loadHistoryPage(c, sessionId); const history = page.events;
  if (page.hasMore && !program.opts().json) console.log(`更早记录：turnwire history ${sessionId} --before ${page.nextBefore}`);
  if (program.opts().json) for (const event of history) print(event);
  else for (const message of conversation(history, sessionId)) console.log(`\n${message.role === 'user' ? 'You' : message.role === 'tool' ? message.tool : message.role === 'error' ? 'Error' : 'Turnwire'}${message.isError ? ' · 失败' : ''}\n${safe(message.input !== undefined ? '输入：\n' + message.input + '\n输出：\n' + (message.output ?? '尚未返回') : message.text)}`);
  const rendered = new Map(conversation(history, sessionId).map(m => [m.id, m.text]));
  const cursor = page.cursor;
  const unsubscribe = c.subscribe((event: TurnwireEvent) => {
    const d = event.data;
    if ('sessionId' in d && d.sessionId !== sessionId) return;
    if ('approval' in d && d.approval.sessionId !== sessionId) return;
    if ('session' in d && d.session.id !== sessionId) return;
    if (program.opts().json) { print(event); return; }
    if (d.type === 'message.delta') { const prior = rendered.get(d.messageId) ?? ''; if (!rendered.has(d.messageId)) process.stdout.write('\nTurnwire\n'); process.stdout.write(safe(d.text)); rendered.set(d.messageId, prior + d.text); }
    if (d.type === 'message.completed') { const prior = rendered.get(d.messageId) ?? ''; console.log(safe(d.text.startsWith(prior) ? d.text.slice(prior.length) : d.text)); rendered.set(d.messageId, d.text); }
    if (d.type === 'message.user') console.log(`\nYou\n${safe(d.text)}`);
    if (d.type === 'approval.requested') console.log(`\nApproval: ${safe(d.approval.tool)}\n${safe(d.approval.reason)}\nturnwire approve ${d.approval.id}\nturnwire reject ${d.approval.id}`);
    if (d.type === 'tool.started') console.log(`\n▶ ${safe(d.tool)}\n${safe(d.detail)}`);
    if (d.type === 'tool.finished') console.log(`\n${d.isError ? '✗' : '↳'} ${safe(d.tool)}\n${safe(d.detail)}`);
    if (d.type === 'session.error') console.error(safe(d.message));
  }, state => { if (!program.opts().json) process.stderr.write(`[${state}]\n`); }, cursor);
  const input = process.stdin.isTTY && !program.opts().json ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  input?.on('line', line => { if (!line.trim()) return; void c.request('session.message', { sessionId, text: line }).catch(error => console.error(safe(String(error)))); });
  await new Promise<void>(done => {
    const detach = () => { process.off('SIGINT', detach); process.off('SIGTERM', detach); input?.off('close', detach); done(); };
    process.once('SIGINT', detach); process.once('SIGTERM', detach); input?.once('close', detach);
  });
  unsubscribe(); input?.close(); c.close();
});
program.command('connection').description('Verify a fresh round trip to the host').action(() => withClient(async c => { if (c instanceof RemoteClient) print(await c.checkConnection()); else { const started = Date.now(); const snapshot = await c.request<Snapshot>('system.snapshot'); print({ phase: 'connected', message: '已验证连接到主机', hostId: snapshot.device.id, latencyMs: Date.now() - started, lastVerifiedAt: new Date().toISOString() }); } }));
program.command('connect').description('Print local connection details for the PWA').action(async () => print(await config()));
async function localClient(): Promise<LocalClient> {
  if (program.opts().pairing) throw new Error('远程访问配置和设备管理需要本机连接');
  const c = await config(); return new LocalClient(c.url, c.token);
}
const devices = program.command('devices').description('Pair and revoke remote devices (local authorization required)');
devices.command('list').option('--watch', 'follow verified device connection state').action(async (options: { watch?: boolean }) => { const c = await localClient(); let stopped = false; const stop = () => { stopped = true; }; process.once('SIGINT', stop); try { do { print(await c.devices()); if (!options.watch) break; await new Promise(resolve => setTimeout(resolve, 2000)); } while (!stopped); } finally { process.off('SIGINT', stop); c.close(); } });
devices.command('pair').option('--name <name>', 'device name', '我的手机').option('--qr', 'show a pairing QR in the terminal').option('--qr-file <path>', 'save a private PNG QR without overwriting files').action(async (options: { name: string; qr?: boolean; qrFile?: string }) => {
  if (program.opts().json && (options.qr || options.qrFile)) throw new Error('--json 不能与二维码输出选项同时使用');
  const pairing = await (await localClient()).pairDevice(options.name);
  if (program.opts().json) print(pairing); else await printPairing(pairing, options);
});
devices.command('upgrade <id>').description('Replace an existing pairing with a one-time v2 enrollment QR').option('--qr', 'show the new QR').action(async (id: string, options: { qr?: boolean }) => { const result = await (await localClient()).upgradeDevice(id); if (program.opts().json) print(result); else await printPairing(result, options); });
devices.command('revoke <id>').action(async (id: string) => { await (await localClient()).revokeDevice(id); print({ removed: true }); });
const remote = program.command('remote').description('Choose temporary access or a self-hosted Relay');
program.command('deploy').description('Deploy/update a Relay server through the local daemon')
  .option('--config <path>', 'private JSON deployment configuration')
  .option('--status', 'read deployment state without starting work')
  .option('--no-wait', 'return immediately; deployment continues in the daemon')
  .action(async (options: { config?: string; status?: boolean; wait: boolean }) => {
    const c = await localClient();
    try {
      if (options.status) { print(await c.deploymentStatus()); return; }
      if (!options.config) { if (process.stdin.isTTY && !program.opts().json) { await deploymentMenu(c); return; } throw new Error('使用 --config 指定私有 JSON 配置，或在终端运行 turnwire deploy 打开表单'); }
      const value = JSON.parse(await readFile(resolve(options.config), 'utf8')) as Parameters<LocalClient['deployRelay']>[0];
      const status = await c.deployRelay(value);
      if (!options.wait) { print(status); return; }
      const result = await watchDeployment(c, program.opts().json ? { write: () => {}, ask: async () => undefined } : undefined);
      if (program.opts().json) print(result);
      if (result.state === 'failed' || result.state === 'interrupted') throw new Error(result.message);
    } finally { c.close(); }
  });
function showRemote(status: Awaited<ReturnType<LocalClient['remoteStatus']>>) { if (program.opts().json) print(status); else printRemote(status); }
remote.command('status').option('--watch', 'follow connection status; Ctrl+C exits without changing access').action(async (options: { watch?: boolean }) => {
  const c = await localClient();
  if (!options.watch) { showRemote(await c.remoteStatus()); return; }
  let stopped = false; const stop = () => { stopped = true; }; let previous = '';
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { while (!stopped) {
    const status = await c.remoteStatus(); const current = JSON.stringify(status);
    if (current !== previous) { showRemote(status); previous = current; }
    await new Promise(resolve => setTimeout(resolve, 500));
  } } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); c.close(); }
});
remote.command('temporary').description('Start a temporary public address').option('--provider <provider>', 'localhost-run, cpolar or cloudflare; defaults to the saved provider').action(async (options: { provider?: string }) => { const provider = options.provider ? tunnelProviderSchema.parse(options.provider) : undefined; const c = await localClient(); const selected = provider ?? (await c.remoteStatus()).provider ?? 'cloudflare'; showRemote(await c.configureRemote({ mode: 'temporary', provider: selected, ...(selected === 'cpolar' && process.env.TURNWIRE_CPOLAR_AUTH_TOKEN ? { cpolarToken: process.env.TURNWIRE_CPOLAR_AUTH_TOKEN } : {}) })); });
remote.command('relay <serverUrl>').description('Connect a self-hosted Relay; reads TURNWIRE_RELAY_TOKEN or retains the saved key for this URL').action(async (serverUrl: string) => showRemote(await (await localClient()).configureRemote({ mode: 'relay', serverUrl, ...(process.env.TURNWIRE_RELAY_TOKEN ? { token: process.env.TURNWIRE_RELAY_TOKEN } : {}) })));
const direct = remote.command('direct').description('Configure the isolated TLS LAN bridge');
direct.command('status').action(async () => print(await (await localClient()).directStatus()));
direct.command('off').action(async () => print(await (await localClient()).configureDirect({ enabled: false })));
direct.command('configure').requiredOption('--config <path>', 'private JSON configuration').action(async (options: { config: string }) => print(await (await localClient()).configureDirect(JSON.parse(await readFile(resolve(options.config), 'utf8')))));
direct.action(async () => { const c = await localClient(); try { if (process.stdin.isTTY && !program.opts().json) await directMenu(c); else print(await c.directStatus()); } finally { c.close(); } });
const notifications = program.command('notifications').description('Manage host push delivery; phone permission is requested in the PWA');
notifications.command('status').action(() => withClient(async c => print(await c.request('notifications.status'))));
for (const enabled of [true, false]) notifications.command(enabled ? 'on' : 'off').action(async () => print(await (await localClient()).configureNotifications(enabled)));
notifications.action(async () => { const c = await localClient(); try { if (process.stdin.isTTY && !program.opts().json) await notificationsMenu(c); else print(await c.notificationStatus()); } finally { c.close(); } });
remote.command('off').description('Disable remote access while keeping local sessions running').action(async () => showRemote(await (await localClient()).configureRemote({ mode: 'off' })));
remote.action(async () => { if (program.opts().json) showRemote(await (await localClient()).remoteStatus()); else if (process.stdin.isTTY) await remoteMenu(await localClient()); else remote.outputHelp(); });
program.command('tui').description('Interactive terminal using the same commands and capabilities as CLI').action(async () => {
  if (!process.stdin.isTTY || program.opts().json) throw new Error('turnwire tui 需要交互式终端；脚本请使用 CLI 子命令');
  const defaults = { ...program.opts<CliOptions>() };
  await runTui(args => createProgram(defaults).parseAsync(args, { from: 'user' }), program.helpInformation());
});
program.action(() => program.help());
return program;
}
