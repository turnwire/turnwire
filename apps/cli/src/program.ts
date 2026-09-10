import { Command, InvalidArgumentError } from 'commander';
import { readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { LocalClient, RemoteClient, decodePairing, encodePairing, loadHistoryPage, loadSubagentHistoryPage, loadHistory, conversation, transcriptMarkdown } from '@turnwire/sdk';
import type { TurnwireClient } from '@turnwire/sdk';
import { eventSessionId, tunnelProviderSchema } from '@turnwire/protocol';
import type { TurnwireEvent, Session, Snapshot, ModelCatalog, SubagentView, WorkspaceListing } from '@turnwire/protocol';
import { safe, printRemote, printPairing, remoteMenu, runTui, deploymentMenu, watchDeployment, directMenu, notificationsMenu } from './terminal.js';
import { detectLocale, isLocale, localeFromArgv, localizedError, padEnd, setLocale, t, textIn } from './i18n.js';
import type { Locale } from './i18n.js';

export interface CliOptions { url?: string; token?: string; pairing?: string; json?: boolean; lang?: string }

/** `--lang` (or a re-dispatched TUI call) wins over TURNWIRE_LANG / LC_ALL / LANG detection. */
function resolveLocale(defaults: CliOptions): Locale {
  if (isLocale(defaults.lang)) return defaults.lang;
  return localeFromArgv() ?? detectLocale();
}
/** Parse the `provider/model` form the model catalog prints, so ids are never hand-built. */
function modelSelection(spec: string, reasoningEffort?: string) {
  const index = spec.indexOf('/');
  if (index < 1 || index === spec.length - 1) throw localizedError('CLI_MODEL_SPEC');
  return { provider: spec.slice(0, index), model: spec.slice(index + 1), ...(reasoningEffort ? { reasoningEffort } : {}) };
}
function showModel(session: Session) {
  return session.model ? `${session.model.provider}/${session.model.model}${session.model.reasoningEffort ? ' · ' + session.model.reasoningEffort : ''}` : t('model.unset');
}
export function createProgram(defaults: CliOptions = {}) {
setLocale(resolveLocale(defaults));
const program = new Command().name('turnwire').description(t('program.description')).version('0.1.0').exitOverride();
program.option('--url <url>', t('option.url'), defaults.url).option('--token <token>', t('option.token'), defaults.token).option('--pairing <file>', t('option.pairing'), defaults.pairing).option('--json', t('option.json'), defaults.json).option('--lang <locale>', t('option.lang'), defaults.lang);
interface Config { url: string; token: string }
async function config(): Promise<Config> {
  const opts = program.opts();
  if (opts.url && opts.token) return { url: String(opts.url), token: String(opts.token) };
  let saved: Config;
  try { saved = JSON.parse(await readFile(join(process.env.TURNWIRE_HOME ?? join(homedir(), '.turnwire'), 'client.json'), 'utf8')) as Config; }
  catch { throw localizedError('CLI_MISSING_CONFIG'); }
  return { url: opts.url as string ?? saved.url, token: opts.token as string ?? saved.token };
}
async function client(): Promise<TurnwireClient> { const path = program.opts().pairing as string | undefined; if (path) return new RemoteClient(decodePairing(await readFile(path, 'utf8')), { persistPairing: async pairing => { const temporary = path + '.next'; await writeFile(temporary, encodePairing(pairing), { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, path); } }); const c = await config(); return new LocalClient(c.url, c.token); }
function print(value: unknown) { console.log(JSON.stringify(value, null, 2)); }
/** How long an agent has been working, rounded the way a person reads a stopwatch. */
function duration(ms: number) { const seconds = Math.round(ms / 1000); return seconds < 60 ? t('agents.seconds', { value: seconds }) : t('agents.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 }); }
async function withClient(action: (client: TurnwireClient) => Promise<void>) { const c = await client(); try { await action(c); } finally { c.close(); } }
program.command('status').description(t('command.status')).action(() => withClient(async c => { const snapshot = await c.request<Snapshot>('system.snapshot'); if (program.opts().json) print(snapshot); else { console.log(t('status.summary', { device: snapshot.device.name, count: snapshot.sessions.length })); for (const runtime of snapshot.runtimes) console.log(`${runtime.online ? '●' : '○'} ${runtime.name}: ${safe(runtime.message)}`); } }));
program.command('ls').description(t('command.ls')).option('--archived', t('option.archived')).option('--all', t('option.all')).option('--search <query>', t('option.search')).action((options: { archived?: boolean; all?: boolean; search?: string }) => withClient(async c => {
  const snapshot = await c.request<Snapshot>('system.snapshot'); const query = options.search?.toLocaleLowerCase();
  const sessions = snapshot.sessions.filter(s => (options.all || !!s.archived === !!options.archived) && (!query || (s.title + ' ' + s.cwd).toLocaleLowerCase().includes(query)));
  if (program.opts().json) print(sessions); else for (const s of sessions) console.log(`${s.id}  ${padEnd(s.archived ? t('session.archived') : s.status, 17)} ${safe(s.title)}  ${safe(s.cwd)}`);
}));
program.command('rename <session> <title>').description(t('command.rename')).action((sessionId: string, title: string) => withClient(async c => print(await c.request('session.rename', { sessionId, title }))));
for (const archived of [true, false]) program.command(`${archived ? 'archive' : 'unarchive'} <session>`).description(archived ? t('command.archive') : t('command.unarchive')).action((sessionId: string) => withClient(async c => print(await c.request('session.archive', { sessionId, archived }))));
program.command('new [prompt]').description(t('command.new')).option('--cwd <path>', t('option.cwd'), process.cwd()).option('--title <title>', t('option.title'), t('new.title.default')).option('--runtime <id>', t('option.runtime'), 'dsh').option('--model <provider/model>', t('option.model')).option('--effort <id>', t('option.effort')).action((prompt: string | undefined, options: { cwd: string; title: string; runtime: string; model?: string; effort?: string }) => withClient(async c => {
  const s = await c.request<Session>('session.create', { cwd: resolve(options.cwd), title: options.title, runtimeId: options.runtime, ...(options.model ? { model: modelSelection(options.model, options.effort) } : {}) });
  if (prompt) await c.request('session.message', { sessionId: s.id, text: prompt });
  if (program.opts().json) print(s); else console.log(t('new.success', { id: s.id, model: showModel(s) }));
}));
/** The terminal's half of the phone's folder picker: list one level of the host, then `new --cwd`. */
program.command('dirs [path]').description(t('command.dirs')).action((path: string | undefined) => withClient(async c => {
  const listing = await c.request<WorkspaceListing>('workspace.list', path ? { path: resolve(path) } : {});
  if (program.opts().json) print(listing);
  else { console.log(safe(listing.path)); if (!listing.entries.length) console.log(t('dirs.empty')); else for (const entry of listing.entries) console.log(`  ${safe(entry.name)}`); }
}));
program.command('models').description(t('command.models')).action(() => withClient(async c => {
  const catalog = await c.request<ModelCatalog>('model.catalog', {});
  if (program.opts().json) { print(catalog); return; }
  console.log(t('models.default', { model: `${catalog.default.provider}/${catalog.default.model}${catalog.default.reasoningEffort ? ' · ' + catalog.default.reasoningEffort : ''}` }));
  for (const group of catalog.groups) {
    if (!catalog.routableProviders.includes(group.id)) console.log(t('models.groupNotRoutable', { name: group.name, id: group.id }));
    else console.log(t('models.group', { name: group.name, id: group.id }));
    for (const model of group.models) {
      const efforts = model.reasoning?.efforts.length ? t('models.effort', { efforts: model.reasoning.efforts.map(e => e.id).join('/'), default: model.reasoning.defaultEffort ? t('models.effortDefault', { effort: model.reasoning.defaultEffort }) : '' }) : '';
      console.log(`  ${group.id}/${model.id}  ${model.name}${efforts}`);
    }
  }
  for (const failure of catalog.failures) console.log(t('models.failure', { name: failure.name, id: failure.id, message: failure.message }));
}));
program.command('model <session> <spec>').description(t('command.model')).option('--effort <id>', t('option.effort')).action((sessionId: string, spec: string, options: { effort?: string }) => withClient(async c => {
  // The daemon returns what the runtime resolved, which can differ from the request.
  const updated = await c.request<Session>('session.setModel', { sessionId, ...modelSelection(spec, options.effort) });
  if (program.opts().json) print(updated); else console.log(`${updated.id} · ${showModel(updated)}`);
}));
function historyInteger(flag: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  return (value: string) => {
    const number = Number(value);
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum || number > maximum) {
      throw new InvalidArgumentError(t('agents.integerError', { flag, minimum, maximum }));
    }
    return number;
  };
}
program.command('agents <session>').description(t('command.agents'))
  .option('--detail <child>', t('agents.detailOption'))
  .option('--before <cursor>', t('option.before'), historyInteger('--before', 0))
  .option('--cursor <cursor>', t('agents.cursorOption'), historyInteger('--cursor', -1))
  .option('--limit <count>', t('option.limit'), historyInteger('--limit', 1, 100))
  .action(async (sessionId: string, options: { detail?: string; before?: number; cursor?: number; limit?: number }) => {
    if (options.detail === undefined && (options.before !== undefined || options.cursor !== undefined || options.limit !== undefined)) {
      throw new Error(t('agents.detailRequired'));
    }
    await withClient(async c => {
  if (options.detail !== undefined) {
    const page = await loadSubagentHistoryPage(c, { sessionId, subagentId: options.detail, before: options.before, cursor: options.cursor, limit: options.limit ?? 50 });
    if (program.opts().json) { print(page); return; }
    console.log(`${safe(page.subagent.label)}  [${safe(page.subagent.id)}] · ${t(page.subagent.activity === 'running' ? 'agents.activityRunning' : 'agents.activityInactive')}`);
    for (const record of page.records) {
      console.log(`\n${safe(record.tool ?? t(({ user: 'agents.roleUser', assistant: 'agents.roleAssistant', tool: 'agents.roleTool', error: 'agents.roleError' } as const)[record.role]))} · ${safe(record.time)}${record.isError ? t('history.failed') : ''}${record.complete ? '' : ' · ' + t('history.pending')}`);
      if (record.text) console.log(safe(record.text));
      if (record.input !== undefined) console.log(safe(t('history.io', { input: record.input, output: record.output ?? t('history.pending') })));
      else if (record.output !== undefined) console.log(safe(record.output));
    }
    console.log(`\ncursor=${page.cursor} · nextBefore=${page.nextBefore ?? 'null'} · hasMore=${page.hasMore}`);
    if (page.hasMore && page.nextBefore !== null) console.log(`turnwire agents ${safe(sessionId)} --detail ${safe(options.detail)} --before ${page.nextBefore} --limit ${options.limit ?? 50}`);
    return;
  }
  const { subagents } = await c.request<{ subagents: SubagentView[] }>('subagent.list', { sessionId });
  if (program.opts().json) { print(subagents); return; }
  if (!subagents.length) { console.log(t('agents.empty')); return; }
  const byId = new Map(subagents.map(agent => [agent.id, agent]));
  for (const agent of subagents) {
    const current = agent.todos.find(todo => todo.status === 'in_progress');
    const done = agent.todos.filter(todo => todo.status === 'completed').length;
    // The running child leads with the tool it is on; a finished one keeps the state it ended in.
    const steps = current ? t('agents.current', { done, total: agent.todos.length, content: current.content }) : agent.todos.length ? t('agents.steps', { done, total: agent.todos.length }) : '';
    const indent = '  '.repeat(agent.depth - 1);
    const parent = byId.get(agent.parentId);
    const where = parent ? t('agents.under', { label: safe(parent.label) }) : t('agents.depth', { depth: agent.depth });
    console.log(`${agent.activity === 'running' ? '●' : '○'} ${indent}${safe(agent.label)} [${safe(agent.id)}]${agent.elapsedMs === undefined ? '' : '  ' + duration(agent.elapsedMs)}${steps ? '  ' + steps : ''}`);
    // The same detail the phone shows when a row is opened: what this child is, and its own plan.
    console.log(`${indent}  ${agent.mode === 'continuable' ? t('agents.modeContinuable') : t('agents.modeOneShot')} · ${where}`);
    if (!agent.todos.length) console.log(`${indent}  ${t('agents.noPlan')}`);
    else {
      console.log(`${indent}  ${t('agents.plan')}`);
      for (const todo of agent.todos) {
        const mark = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○';
        const state = t(todo.status === 'completed' ? 'agents.todoCompleted' : todo.status === 'in_progress' ? 'agents.todoInProgress' : 'agents.todoPending');
        console.log(`${indent}    ${mark} ${state.padEnd(12)}${safe(todo.content)}`);
      }
    }
  }
  });
});
program.command('history <session>').description(t('command.history'))
  .option('--before <cursor>', t('option.before'), Number).option('--limit <count>', t('option.limit'), Number, 40)
  .option('--all', t('option.allTranscript'))
  .action((sessionId: string, options: { before?: number; limit: number; all?: boolean }) => withClient(async c => {
    const page = options.all ? { events: await loadHistory(c, sessionId), hasMore: false, nextBefore: null } : await loadHistoryPage(c, sessionId, options.before, options.limit);
    if (program.opts().json) print(page);
    else { for (const message of conversation(page.events, sessionId)) console.log(`\n${safe(message.tool ?? message.role)}${message.steer ? t('history.steer') : message.queued ? t('history.queued') : ''}\n${safe(message.input !== undefined ? t('history.io', { input: message.input, output: message.output ?? t('history.pending') }) : message.text)}`);
      if (page.hasMore) console.log('\n' + t('history.earlier', { session: sessionId, cursor: page.nextBefore ?? '' }));
    }
  }));
program.command('export <session>').description(t('command.export')).requiredOption('--output <path>', t('option.output')).action((sessionId: string, options: { output: string }) => withClient(async c => {
  const snapshot = await c.request<Snapshot>('system.snapshot'); const session = snapshot.sessions.find(s => s.id === sessionId); if (!session) throw localizedError('SESSION_NOT_FOUND');
  const messages = conversation(await loadHistory(c, sessionId), sessionId); const path = resolve(options.output);
  await writeFile(path, transcriptMarkdown(session, messages), { flag: 'wx', mode: 0o600 }); print({ path });
}));
program.command('send <session> <prompt>').description(t('command.send')).option('--steer', t('option.steer'))
  .action((sessionId: string, text: string, options: { steer?: boolean }) => withClient(async c => print(await c.request('session.message', { sessionId, text, ...(options.steer ? { steer: true } : {}) }))));
program.command('resume <session>').description(t('command.resume')).action((sessionId: string) => withClient(async c => print(await c.request('session.resume', { sessionId }))));
program.command('stop <session>').description(t('command.stop')).action((sessionId: string) => withClient(async c => print(await c.request('session.cancel', { sessionId }))));
program.command('result <id>').description(t('command.result')).action((requestId: string) => withClient(async c => print(await c.request('request.result', { requestId }))));
program.command('inbox').description(t('command.inbox')).option('--all', t('option.inboxAll')).option('--before <cursor>', t('option.inboxBefore'), Number).action((options: { all?: boolean; before?: number }) => withClient(async c => print(await c.request('inbox.page', { status: options.all ? 'all' : 'pending', before: options.before }))));
program.command('approvals').description(t('command.approvals')).action(() => withClient(async c => print((await c.request<Snapshot>('system.snapshot')).approvals)));
for (const decision of ['approve', 'reject'] as const) program.command(`${decision} <approval>`).description(decision === 'approve' ? t('command.approve') : t('command.reject')).action((approvalId: string) => withClient(async c => print(await c.request('approval.decide', { approvalId, decision: decision === 'approve' ? 'approved' : 'rejected' }))));
program.command('questions').description(t('command.questions')).action(() => withClient(async c => {
  const snapshot = await c.request<Snapshot>('system.snapshot');
  if (program.opts().json) print(snapshot.questions);
  else if (!snapshot.questions.length) console.log(t('questions.none'));
  else for (const question of snapshot.questions) for (const item of question.questions) console.log(`${question.id}  ${safe(item.question)}${item.options ? '  [' + item.options.map(option => option.label).join(' | ') + ']' : ''}`);
}));
program.command('answer <question> <option...>').description(t('command.answer')).option('--text <answer>', t('option.answerText')).action((questionId: string, options: string[], flags: { text?: string }) => withClient(async c => {
  const snapshot = await c.request<Snapshot>('system.snapshot');
  const question = snapshot.questions.find(candidate => candidate.id === questionId);
  if (!question) throw localizedError('QUESTION_EXPIRED');
  // The runtime answers a batch at once, so each question in it takes the options it was given,
  // falling back to the same labels for every question when only one was named.
  const answers = question.questions.map((item, index) => ({ id: item.id, selected: question.questions.length === 1 ? options : (options[index] === undefined ? [] : [options[index]!]), ...(flags.text === undefined ? {} : { custom: flags.text }) }));
  print(await c.request('question.answer', { questionId, answers }));
}));
program.command('approve-for-me <session>').description(t('command.autoApprove')).option('--off', t('option.off')).action((sessionId: string, options: { off?: boolean }) => withClient(async c => {
  const result = await c.request<{ enabled: boolean }>('session.autoApprove', { sessionId, enabled: options.off !== true });
  if (program.opts().json) print(result); else console.log(result.enabled ? t('autoApprove.on') : t('autoApprove.off'));
}));
program.command('attach <session>').description(t('command.attach')).action(async (sessionId: string) => {
  const c = await client(); const snapshot = await c.request<Snapshot>('system.snapshot');
  if (!snapshot.sessions.some(s => s.id === sessionId)) { c.close(); throw localizedError('SESSION_NOT_FOUND'); }
  const page = await loadHistoryPage(c, sessionId); const history = page.events;
  if (page.hasMore && !program.opts().json) console.log(t('history.earlier', { session: sessionId, cursor: page.nextBefore ?? '' }));
  if (program.opts().json) for (const event of history) print(event);
  else for (const message of conversation(history, sessionId)) console.log(`\n${message.role === 'user' ? t('role.you') : message.role === 'tool' ? message.tool : message.role === 'error' ? t('role.error') : message.role === 'question' ? t('role.question') : t('role.assistant')}${message.isError ? t('history.failed') : ''}\n${safe(message.input !== undefined ? t('history.io', { input: message.input, output: message.output ?? t('history.pending') }) : message.text)}${message.role === 'question' && message.question?.answers?.length ? `\n${t('history.answered')}: ${safe(message.question.answers.map(entry => [...entry.selected, ...(entry.custom ? [entry.custom] : [])].join(', ')).join(' · '))}` : ''}`);
  const rendered = new Map(conversation(history, sessionId).map(m => [m.id, m.text]));
  const cursor = page.cursor;
  const unsubscribe = c.subscribe((event: TurnwireEvent) => {
    const d = event.data;
    if ('sessionId' in d && d.sessionId !== sessionId) return;
    if (eventSessionId(d) !== sessionId) return;
    if ('session' in d && d.session.id !== sessionId) return;
    if (program.opts().json) { print(event); return; }
    if (d.type === 'message.delta') { const prior = rendered.get(d.messageId) ?? ''; if (!rendered.has(d.messageId)) process.stdout.write(`\n${t('role.assistant')}\n`); process.stdout.write(safe(d.text)); rendered.set(d.messageId, prior + d.text); }
    if (d.type === 'message.completed') { const prior = rendered.get(d.messageId) ?? ''; console.log(safe(d.text.startsWith(prior) ? d.text.slice(prior.length) : d.text)); rendered.set(d.messageId, d.text); }
    if (d.type === 'message.user') console.log(`\n${t('role.you')}\n${safe(d.text)}`);
    if (d.type === 'approval.requested') console.log(t('attach.approval', { tool: safe(d.approval.tool), reason: safe(d.approval.reason), id: d.approval.id }));
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
program.command('connection').description(t('command.connection')).action(() => withClient(async c => { if (c instanceof RemoteClient) print(await c.checkConnection()); else { const started = Date.now(); const snapshot = await c.request<Snapshot>('system.snapshot'); print({ phase: 'connected', message: textIn('en', 'connection.verified'), hostId: snapshot.device.id, latencyMs: Date.now() - started, lastVerifiedAt: new Date().toISOString() }); } }));
program.command('connect').description(t('command.connect')).action(async () => print(await config()));
async function localClient(): Promise<LocalClient> {
  if (program.opts().pairing) throw localizedError('CLI_LOCAL_CONNECTION_REQUIRED');
  const c = await config(); return new LocalClient(c.url, c.token);
}
const devices = program.command('devices').description(t('command.devices'));
devices.command('list').option('--watch', t('option.watchDevices')).action(async (options: { watch?: boolean }) => { const c = await localClient(); let stopped = false; const stop = () => { stopped = true; }; process.once('SIGINT', stop); try { do { print(await c.devices()); if (!options.watch) break; await new Promise(resolve => setTimeout(resolve, 2000)); } while (!stopped); } finally { process.off('SIGINT', stop); c.close(); } });
devices.command('pair').option('--name <name>', t('option.deviceName'), t('device.defaultName')).option('--qr', t('option.qr')).option('--qr-file <path>', t('option.qrFile')).action(async (options: { name: string; qr?: boolean; qrFile?: string }) => {
  if (program.opts().json && (options.qr || options.qrFile)) throw localizedError('CLI_QR_JSON_CONFLICT');
  const pairing = await (await localClient()).pairDevice(options.name);
  if (program.opts().json) print(pairing); else await printPairing(pairing, options);
});
devices.command('upgrade <id>').description(t('command.devices.upgrade')).option('--qr', t('option.qrNew')).action(async (id: string, options: { qr?: boolean }) => { const result = await (await localClient()).upgradeDevice(id); if (program.opts().json) print(result); else await printPairing(result, options); });
devices.command('revoke <id>').action(async (id: string) => { await (await localClient()).revokeDevice(id); print({ removed: true }); });
const remote = program.command('remote').description(t('command.remote'));
program.command('deploy').description(t('command.deploy'))
  .option('--config <path>', t('option.deployConfig'))
  .option('--status', t('option.status'))
  .option('--no-wait', t('option.noWait'))
  .action(async (options: { config?: string; status?: boolean; wait: boolean }) => {
    const c = await localClient();
    try {
      if (options.status) { print(await c.deploymentStatus()); return; }
      if (!options.config) { if (process.stdin.isTTY && !program.opts().json) { await deploymentMenu(c); return; } throw localizedError('CLI_DEPLOY_CONFIG_REQUIRED'); }
      const value = JSON.parse(await readFile(resolve(options.config), 'utf8')) as Parameters<LocalClient['deployRelay']>[0];
      const status = await c.deployRelay(value);
      if (!options.wait) { print(status); return; }
      const result = await watchDeployment(c, program.opts().json ? { write: () => {}, ask: async () => undefined } : undefined);
      if (program.opts().json) print(result);
      if (result.state === 'failed' || result.state === 'interrupted') throw new Error(result.message);
    } finally { c.close(); }
  });
function showRemote(status: Awaited<ReturnType<LocalClient['remoteStatus']>>) { if (program.opts().json) print(status); else printRemote(status); }
remote.command('status').option('--watch', t('option.watchRemote')).action(async (options: { watch?: boolean }) => {
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
remote.command('temporary').description(t('command.remote.temporary')).option('--provider <provider>', t('option.provider')).option('--tunnel-name <name>', t('option.tunnelName')).option('--tunnel-hostname <hostname>', t('option.tunnelHostname')).option('--tunnel-credentials <path>', t('option.tunnelCredentials')).option('--tunnel-protocol <protocol>', t('option.tunnelProtocol'), 'http2').action(async (options: { provider?: string; tunnelName?: string; tunnelHostname?: string; tunnelCredentials?: string; tunnelProtocol?: string }) => {
  const provider = options.provider ? tunnelProviderSchema.parse(options.provider) : undefined;
  const c = await localClient();
  const selected = provider ?? (await c.remoteStatus()).provider ?? 'cloudflare';
  // Every named-tunnel value belongs to the operator; nothing is created on their behalf.
  if (selected === 'cloudflare-named' && !(options.tunnelName && options.tunnelHostname && options.tunnelCredentials)) throw localizedError('CLI_NAMED_TUNNEL_INCOMPLETE');
  const namedTunnel = selected === 'cloudflare-named' ? { name: options.tunnelName!, hostname: options.tunnelHostname!, credentialsFile: options.tunnelCredentials!, protocol: (options.tunnelProtocol ?? 'http2') as 'auto' | 'http2' | 'quic' } : undefined;
  showRemote(await c.configureRemote({ mode: 'temporary', provider: selected, ...(selected === 'cpolar' && process.env.TURNWIRE_CPOLAR_AUTH_TOKEN ? { cpolarToken: process.env.TURNWIRE_CPOLAR_AUTH_TOKEN } : {}), ...(namedTunnel ? { namedTunnel } : {}) }));
});
remote.command('relay <serverUrl>').description(t('command.remote.relay')).action(async (serverUrl: string) => showRemote(await (await localClient()).configureRemote({ mode: 'relay', serverUrl, ...(process.env.TURNWIRE_RELAY_TOKEN ? { token: process.env.TURNWIRE_RELAY_TOKEN } : {}) })));
const direct = remote.command('direct').description(t('command.direct'));
direct.command('status').action(async () => print(await (await localClient()).directStatus()));
direct.command('off').action(async () => print(await (await localClient()).configureDirect({ enabled: false })));
direct.command('configure').requiredOption('--config <path>', t('option.jsonConfig')).action(async (options: { config: string }) => print(await (await localClient()).configureDirect(JSON.parse(await readFile(resolve(options.config), 'utf8')))));
direct.action(async () => { const c = await localClient(); try { if (process.stdin.isTTY && !program.opts().json) await directMenu(c); else print(await c.directStatus()); } finally { c.close(); } });
const notifications = program.command('notifications').description(t('command.notifications'));
notifications.command('status').action(() => withClient(async c => print(await c.request('notifications.status'))));
for (const enabled of [true, false]) notifications.command(enabled ? 'on' : 'off').action(async () => print(await (await localClient()).configureNotifications(enabled)));
notifications.action(async () => { const c = await localClient(); try { if (process.stdin.isTTY && !program.opts().json) await notificationsMenu(c); else print(await c.notificationStatus()); } finally { c.close(); } });
remote.command('off').description(t('command.remote.off')).action(async () => showRemote(await (await localClient()).configureRemote({ mode: 'off' })));
remote.action(async () => { if (program.opts().json) showRemote(await (await localClient()).remoteStatus()); else if (process.stdin.isTTY) await remoteMenu(await localClient()); else remote.outputHelp(); });
program.command('tui').description(t('command.tui')).action(async () => {
  if (!process.stdin.isTTY || program.opts().json) throw localizedError('CLI_TUI_REQUIRES_TTY');
  const defaults = { ...program.opts<CliOptions>() };
  await runTui(args => createProgram(defaults).parseAsync(args, { from: 'user' }), program.helpInformation());
});
program.action(() => program.help());
return program;
}
