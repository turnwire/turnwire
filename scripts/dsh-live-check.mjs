#!/usr/bin/env node
/**
 * Live DSH acceptance check: one real turn, one real approval, one real queued prompt.
 *
 * `scripts/dsh-model-probe.mjs` proves the Host answers the contract without a model; this proves the
 * parts that only exist during a turn — prompt delivery, the follow stream, assistant mapping, the
 * approval waterfall our `allowed-once` reply goes through, the runtime's own queue projection and the
 * host's record of when a waiting prompt starts. Run it after every DSH upgrade, before the Host that
 * serves people is restarted.
 *
 * Env: DSH_BIN (defaults to the pinned config/dsh-runtime install), DSH_PORT, DAEMON_PORT,
 *      TURNWIRE_HARNESS_DEEPSEEK_API_KEY (read from config/dsh.env.json when unset).
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalClient } from '../packages/sdk/src/index.ts';

const root = resolve(import.meta.dirname, '..');
const dshEntry = process.env.DSH_BIN ?? join(root, 'config/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
const dshPort = Number(process.env.DSH_PORT ?? 3293);
const daemonPort = Number(process.env.DAEMON_PORT ?? 19923);
const scratch = await mkdtemp(join(tmpdir(), 'turnwire-dsh-live-'));
const dshHome = join(scratch, 'dsh-state'); const state = join(scratch, 'daemon-state');
await mkdir(dshHome, { recursive: true, mode: 0o700 }); await mkdir(state, { recursive: true, mode: 0o700 });
const children = [];
const stop = () => { for (const child of children) child.kill('SIGKILL'); };
process.on('exit', stop);

async function until(check, what, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await Promise.resolve().then(check).catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 400));
  }
}

/** The credential only has to be present in the Host's environment; DSH resolves it per request. */
async function credential() {
  if (process.env.TURNWIRE_HARNESS_DEEPSEEK_API_KEY) return process.env.TURNWIRE_HARNESS_DEEPSEEK_API_KEY;
  const file = JSON.parse(await readFile(join(root, 'config/dsh.env.json'), 'utf8'));
  if (!file.TURNWIRE_HARNESS_DEEPSEEK_API_KEY) throw new Error('Set TURNWIRE_HARNESS_DEEPSEEK_API_KEY, or put it in config/dsh.env.json');
  return file.TURNWIRE_HARNESS_DEEPSEEK_API_KEY;
}

let client; let session; let outside;
try {
  console.log(`Starting an isolated DSH (${dshEntry}) on 127.0.0.1:${dshPort}`);
  const dsh = spawn(process.execPath, [dshEntry, '--patch', join(root, 'config/dsh-deepseek.patch.yml'), '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', String(dshPort)], { env: { ...process.env, DSH_HOME: dshHome, DO_NOT_TRACK: '1', TURNWIRE_HARNESS_DEEPSEEK_API_KEY: await credential() }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(dsh);
  let output = ''; let launch = '';
  dsh.stdout.on('data', chunk => { output += String(chunk); launch ||= /http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/.exec(output)?.[0] ?? ''; });
  dsh.stderr.on('data', chunk => { output += String(chunk); });
  dsh.on('exit', code => { if (code && !launch) console.error(output.slice(-2000)); });
  const dshUrl = await until(() => launch || undefined, 'the DSH launch URL');
  console.log('DSH answered with a launch URL (token not printed)');

  console.log(`Starting the Turnwire daemon on 127.0.0.1:${daemonPort}`);
  const daemon = spawn(process.execPath, ['--import', 'tsx', 'apps/daemon/src/main.ts'], { cwd: root, env: { ...process.env, TURNWIRE_STATE_HOME: join(state, 'state'), TURNWIRE_CONFIG_HOME: state, TURNWIRE_DATA_HOME: join(state, 'data'), TURNWIRE_CACHE_HOME: join(state, 'cache'), TURNWIRE_RUNTIME: 'dsh', TURNWIRE_DSH_URL: dshUrl, TURNWIRE_PORT: String(daemonPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(daemon);
  let logs = ''; daemon.stdout.on('data', chunk => { logs += String(chunk); }); daemon.stderr.on('data', chunk => { logs += String(chunk); });
  const config = await until(async () => JSON.parse(await readFile(join(state, 'client.json'), 'utf8')), `the daemon to publish client.json (${logs.slice(-400)})`);
  client = new LocalClient(config.url, config.token);

  const snapshot = await client.call('system.snapshot');
  if (!snapshot.runtimes.some(runtime => runtime.id === 'dsh' && runtime.online)) throw new Error(`DSH runtime is not online: ${JSON.stringify(snapshot.runtimes)}`);
  console.log('Daemon reached the Host and reports the dsh runtime online');

  session = await client.call('session.create', { cwd: scratch, title: 'DSH live check', runtimeId: 'dsh' });
  const text = await turn('Reply with exactly this word and nothing else: READY', 120_000);
  if (!/READY/.test(text)) throw new Error(`The turn did not answer as asked: ${JSON.stringify(text.slice(0, 200))}`);
  console.log('A real turn streamed an assistant message back');

  // The Host's default policy keeps commands inside the session's workspace and the system temp
  // directory, and escalates anything else, so a path in the home directory is what asks a person. That
  // also makes the second prompt deterministic: it is queued while the turn waits for the decision.
  outside = join(homedir(), `turnwire-dsh-live-${process.pid}.txt`);
  const before = await answers();
  await client.call('session.message', { sessionId: session.id, text: `Use the bash tool to write the text turnwire-live-check into ${outside}, then tell me whether it worked.` });
  const approval = await until(async () => (await client.call('system.snapshot')).approvals.find(entry => entry.sessionId === session.id), 'an approval request').catch(async error => {
    // A turn that never asks for approval is a contract difference worth seeing, so the events that did
    // arrive are printed instead of only the timeout.
    const page = await client.call('events.list', { sessionId: session.id, after: 0, limit: 200 });
    console.error('Events so far:', page.events.map(event => event.data.type === 'tool.started' ? `tool.started:${event.data.tool}` : event.data.type).join(', '));
    throw error;
  });
  console.log(`The Host asked for approval: ${approval.tool}`);

  const queued = await client.call('session.message', { sessionId: session.id, text: 'While that waits: reply with the word SECOND.' });
  if (queued.queued !== true) throw new Error('The second prompt was not reported as queued while the turn waited for approval');
  const waiting = await until(async () => { const items = (await client.call('session.queue', { sessionId: session.id })).items; return items.length ? items : undefined; }, 'the runtime queue to list the queued prompt');
  if (waiting[0]?.messageId !== queued.messageId) throw new Error(`The queue listed ${waiting[0]?.messageId}, expected ${queued.messageId}`);
  console.log('The runtime queue projection listed the waiting prompt');

  await client.call('approval.decide', { approvalId: approval.id, decision: 'approved' });
  await until(async () => (await answers()).length > before.length ? true : undefined, 'the approved turn to answer', 120_000);
  console.log('The approved turn finished and answered');

  const dispatched = await until(async () => {
    const page = await client.call('events.list', { sessionId: session.id, after: 0, limit: 1000 });
    return page.events.some(event => event.data.type === 'message.updated' && event.data.messageId === queued.messageId && event.data.queued === false) ? true : undefined;
  }, 'the host to record when the queued prompt started', 180_000);
  if (!dispatched) throw new Error('The queued prompt never started');
  console.log('The host recorded the moment the queued prompt started');
  // The runtime keeps its inbox entry after it has handed the prompt over, which is exactly why a
  // late cancel used to look like it worked: the removal was accepted and the answer came anyway.
  const listed = await client.call('session.queue', { sessionId: session.id });
  if (listed.items.some(item => item.messageId === queued.messageId)) throw new Error('The queue still lists a prompt that has started');
  let refused = '';
  await client.call('session.queueAction', { sessionId: session.id, messageId: queued.messageId, action: { kind: 'remove' } }).catch(error => { refused = error.code; });
  if (refused !== 'QUEUE_ITEM_STARTED') throw new Error(`Taking back a started prompt answered ${JSON.stringify(refused)}`);
  console.log('A started prompt has left the queue and cannot be taken back');

  await until(async () => (await answers()).some(text => /SECOND/.test(text)) ? true : undefined, 'the queued prompt to run', 180_000);
  console.log('The queued prompt ran and answered');
  console.log('\nDSH live check passed: prompt, streamed answer, approval waterfall, queue projection and dispatch record.');
} catch (error) {
  console.error(`\nDSH live check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  client?.close(); stop(); await rm(scratch, { recursive: true, force: true }); if (outside) await rm(outside, { force: true });
}

/** The session's completed assistant messages, in journal order. */
async function answers() {
  const page = await client.call('history.page', { sessionId: session.id, limit: 100 });
  return page.events.filter(event => event.data.type === 'message.completed' && event.data.text?.trim()).map(event => event.data.text);
}

/** Waits for the session's newest assistant message, so a turn is only read once it is complete. */
async function turn(prompt, timeoutMs) {
  await client.call('session.message', { sessionId: session.id, text: prompt });
  return until(async () => {
    const page = await client.call('history.page', { sessionId: session.id, limit: 100 });
    const answers = page.events.filter(event => event.data.type === 'message.completed' && event.data.text?.trim());
    return answers.length ? answers.at(-1).data.text ?? '' : undefined;
  }, 'the turn to answer', timeoutMs);
}
