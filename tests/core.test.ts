import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { TurnwireCore, Store } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import type { RpcResponse, Session, WorkspaceListing } from '@turnwire/protocol';
import { conversation } from '@turnwire/sdk';

function value<T>(response: RpcResponse): T { if (!response.ok) throw new Error(response.error.message); return response.result as T; }
let cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup = []; });
function setup(store = new Store(':memory:')) { const runtime = new DemoRuntime(); const core = new TurnwireCore(store, [runtime], { id: 'mac', name: 'Test Mac' }); cleanup.push(() => core.dispose()); return { core, runtime, store }; }
const call = (core: TurnwireCore, id: string, method: string, params: unknown = {}) => core.handle({ v: 1, id, method, params });
/** Delegated approvals are granted off the event path, so a test waits for the outcome. */
async function until(check: () => boolean) { for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Timed out'); }
async function session(core: TurnwireCore) { return value<Session>(await call(core, 'create', 'session.create', { title: 'Test', cwd: process.cwd(), runtimeId: 'demo' })); }
describe('durable daemon ownership', () => {
  it('deduplicates concurrent commands and rejects reused ids with changed content', async () => {
    const { core, runtime, store } = setup(); const s = await session(core); const spy = vi.spyOn(runtime, 'sendMessage');
    const request = { sessionId: s.id, text: 'hello' };
    const [a, b] = await Promise.all([call(core, 'prompt', 'session.message', request), call(core, 'prompt', 'session.message', request)]);
    expect(a).toEqual(b); expect(a.ok).toBe(true); expect(spy).toHaveBeenCalledTimes(1);
    const conflict = await call(core, 'prompt', 'session.message', { ...request, text: 'different' }); expect(conflict.ok).toBe(false);
    expect(conversation(store.events(0, 100), s.id).map(m => m.role)).toEqual(['user', 'assistant']);
  });
  it('records that a prompt sent during a turn waits behind it instead of interrupting', async () => {
    const { core, store } = setup(); const s = await session(core);
    await call(core, 'first', 'session.message', { sessionId: s.id, text: 'approval' });
    expect(['running', 'waiting_approval']).toContain(store.session(s.id)?.status);
    await call(core, 'second', 'session.message', { sessionId: s.id, text: '排队的那一条' });
    const sent = store.events(0, 100).filter(e => e.data.type === 'message.user');
    expect(sent[0]?.data).not.toHaveProperty('queued');
    expect(sent.at(-1)?.data).toMatchObject({ text: '排队的那一条', queued: true });
  });
  it('marks where a queued prompt actually started, not where it was written', async () => {
    const { core, store } = setup(); const s = await session(core);
    await call(core, 'turn', 'session.message', { sessionId: s.id, text: 'approval' });
    await call(core, 'queued', 'session.message', { sessionId: s.id, text: '排队的那一条' });
    // While it waits it is the queue that owns it, and the flow is not the place for it.
    expect(value<{ items: unknown[] }>(await call(core, 'q', 'session.queue', { sessionId: s.id })).items).toHaveLength(1);
    await call(core, 'decide', 'approval.decide', { approvalId: value<{ approvals: Array<{ id: string }> }>(await call(core, 'snap', 'system.snapshot')).approvals[0]!.id, decision: 'approved' });
    // Settling the turn starts the prompt. The host says so at that moment, which is what moves the row
    // out of the middle of the answer it was waiting behind and into the turn that actually ran it.
    const started = store.events(0, 1000).filter(e => e.data.type === 'message.updated' && (e.data as { messageId?: string }).messageId === 'queued');
    expect(started).toHaveLength(1);
    expect(started[0]?.data).toMatchObject({ queued: false });
    const messages = conversation(store.events(0, 1000), s.id);
    const queued = messages.findIndex(message => message.id === 'queued');
    const firstAnswer = messages.findIndex(message => message.role === 'assistant');
    expect(queued).toBeGreaterThan(firstAnswer);
    expect(queued).toBeLessThan(messages.length - 1);
    expect(messages[queued]?.queued).toBeFalsy();
  });
  it('steers a running turn when asked instead of queueing behind it', async () => {
    const { core, store } = setup(); const s = await session(core);
    await call(core, 'first', 'session.message', { sessionId: s.id, text: 'approval' });
    await call(core, 'steer', 'session.message', { sessionId: s.id, text: '插话', steer: true });
    const sent = store.events(0, 100).filter(e => e.data.type === 'message.user');
    expect(sent.at(-1)?.data).toMatchObject({ text: '插话', steer: true });
    expect(sent.at(-1)?.data).not.toHaveProperty('queued');
  });
  it('makes approvals one-shot across competing clients', async () => {
    const { core, runtime, store } = setup(); const s = await session(core); await call(core, 'message', 'session.message', { sessionId: s.id, text: 'approval' });
    const approval = store.approvals()[0]!; const spy = vi.spyOn(runtime, 'approve');
    const results = await Promise.all([call(core, 'approve', 'approval.decide', { approvalId: approval.id, decision: 'approved' }), call(core, 'reject', 'approval.decide', { approvalId: approval.id, decision: 'rejected' })]);
    expect(results.filter(r => r.ok)).toHaveLength(1); expect(spy).toHaveBeenCalledTimes(1); expect(store.approval(approval.id)?.status).toBe('approved');
    expect(store.session(s.id)?.status).toBe('idle');
  });
  it('grants a delegated session approvals as they arrive, and says so in the journal', async () => {
    const { core, store } = setup(); const created = await session(core);
    expect(value<{ enabled: boolean }>(await call(core, 'delegate', 'session.autoApprove', { sessionId: created.id, enabled: true }))).toEqual({ enabled: true });
    // The snapshot carries the live flag, so a client shows the state it is actually in.
    expect(value<{ sessions: Session[] }>(await call(core, 'snap', 'system.snapshot')).sessions[0]?.autoApprove).toBe(true);

    // A prompt that raises an approval is granted without anyone answering it, and the journal
    // records that nobody did.
    await call(core, 'prompt', 'session.message', { sessionId: created.id, text: 'Needs approval' });
    await until(() => store.approvals().some(a => a.sessionId === created.id && a.status === 'approved'));
    const granted = store.approvals().find(a => a.sessionId === created.id && a.status === 'approved');
    expect(granted?.auto).toBe(true);
    // The grant unblocked the turn; the demo finishes it once its approval resolves.
    expect(store.session(created.id)?.status).toBe('idle');

    // Reclaiming it takes effect immediately: the next request waits for a person again.
    expect(value<{ enabled: boolean }>(await call(core, 'reclaim', 'session.autoApprove', { sessionId: created.id, enabled: false }))).toEqual({ enabled: false });
    await call(core, 'second', 'session.message', { sessionId: created.id, text: 'Needs approval again' });
    await until(() => store.approvals().some(a => a.sessionId === created.id && a.status === 'pending'));
    expect(value<{ sessions: Session[] }>(await call(core, 'snap2', 'system.snapshot')).sessions[0]?.autoApprove).toBeUndefined();
  });
  it('cancellation invalidates outstanding approvals', async () => {
    const { core, store } = setup(); const s = await session(core); await call(core, 'message', 'session.message', { sessionId: s.id, text: '审批' });
    const approval = store.approvals()[0]!; await call(core, 'stop', 'session.cancel', { sessionId: s.id });
    expect(store.approval(approval.id)?.status).toBe('cancelled'); expect(store.session(s.id)?.status).toBe('idle');
    expect((await call(core, 'late', 'approval.decide', { approvalId: approval.id, decision: 'approved' })).ok).toBe(false);
  });
  it('retains event order, session mappings and command receipts across restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'turnwire-store-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'state.db'); const first = setup(new Store(path)); const s = await session(first.core);
    const request = { sessionId: s.id, text: 'hello' }; const result = await call(first.core, 'message', 'session.message', request); const cursor = first.store.cursor();
    await first.core.dispose(); cleanup.pop();
    const second = setup(new Store(path)); await second.core.start();
    expect(second.store.session(s.id)?.runtimeSessionId).toBe(s.runtimeSessionId);
    expect(await call(second.core, 'message', 'session.message', request)).toEqual(result);
    expect(second.store.events(cursor, 100).every(e => e.seq > cursor)).toBe(true);
    expect(conversation(second.store.events(0, 100), s.id)).toHaveLength(2);
  });
  it('reports background agents the runtime still owns', async () => {
    class BusyRuntime extends DemoRuntime { async busy() { return 2; } }
    // A runtime that cannot answer must not break the snapshot; it reports none.
    class UnreachableRuntime extends DemoRuntime { async busy(): Promise<number> { throw new Error('The runtime host is unreachable'); } }
    const device = { id: 'mac', name: 'Test Mac' };
    expect((await new TurnwireCore(new Store(':memory:'), [new BusyRuntime()], device).snapshot()).runtimes[0]?.busy).toBe(2);
    expect((await new TurnwireCore(new Store(':memory:'), [new UnreachableRuntime()], device).snapshot()).runtimes[0]?.busy).toBe(0);
  });
  it('reports the background agents under a session as a read clients may poll', async () => {
    class AgentRuntime extends DemoRuntime {
      async listSubagents(sessionId: string) {
        return [{ id: 'child', parentId: sessionId, depth: 1, label: 'Translate the docs', mode: 'one-shot' as const, activity: 'running' as const, elapsedMs: 4_200, todos: [{ content: 'Translate README', status: 'completed' as const }, { content: 'Check links', status: 'in_progress' as const }] }];
      }
    }
    const store = new Store(':memory:');
    const core = new TurnwireCore(store, [new AgentRuntime()], { id: 'mac', name: 'Test Mac' }); cleanup.push(() => core.dispose());
    const created = await session(core);
    const listed = value<{ subagents: Array<{ label: string; elapsedMs?: number; todos: unknown[] }> }>(await call(core, 'agents', 'subagent.list', { sessionId: created.id }));
    expect(listed.subagents.map(agent => [agent.label, agent.elapsedMs, agent.todos.length])).toEqual([['Translate the docs', 4_200, 2]]);
    // A poll, not a durable command: no receipt is reserved, so a client may repeat it freely.
    expect(store.request('agents')).toBeUndefined();
  });
  it('rewrites the journal when a prompt is changed before it ever runs', async () => {
    class QueueRuntime extends DemoRuntime {
      readonly handled: string[] = [];
      override async queueAction(_sessionId: string, _messageId: string, action: { kind: string }) { this.handled.push(action.kind); }
    }
    const store = new Store(':memory:');
    const runtime = new QueueRuntime();
    const core = new TurnwireCore(store, [runtime], { id: 'mac', name: 'Test Mac' }); cleanup.push(() => core.dispose());
    const created = await session(core);
    // The first prompt raises the demo's approval, so the turn is still going; the second waits.
    await call(core, 'first', 'session.message', { sessionId: created.id, text: 'Needs approval' });
    await call(core, 'second', 'session.message', { sessionId: created.id, text: 'and then this' });
    const queued = () => conversation(store.events(0, 100), created.id).find(message => message.id === 'second');
    expect(queued()).toMatchObject({ text: 'and then this', queued: true });

    await call(core, 'edit', 'session.queueAction', { sessionId: created.id, messageId: 'second', action: { kind: 'edit', text: 'actually this' } });
    expect(queued()).toMatchObject({ text: 'actually this', queued: true });
    await call(core, 'steer', 'session.queueAction', { sessionId: created.id, messageId: 'second', action: { kind: 'steer' } });
    expect(queued()).toMatchObject({ text: 'actually this', queued: false, steer: true });
    await call(core, 'drop', 'session.queueAction', { sessionId: created.id, messageId: 'second', action: { kind: 'remove' } });
    // Taken back before it ran, so the transcript does not claim it happened.
    expect(queued()).toBeUndefined();
    expect(runtime.handled).toEqual(['edit', 'steer', 'remove']);
  });
  it('reads the queue from the runtime, not from what this client happened to watch arrive', async () => {
    const { core, store } = setup(); const created = await session(core);
    await call(core, 'first', 'session.message', { sessionId: created.id, text: 'Needs approval' });
    await call(core, 'second', 'session.message', { sessionId: created.id, text: 'waiting one' });
    const items = async () => value<{ items: Array<{ messageId: string; target: string; text: string }> }>(await call(core, 'queue', 'session.queue', { sessionId: created.id }));
    expect(await items()).toEqual({ items: [{ messageId: 'second', target: 'next-turn', text: 'waiting one' }] });
    // A page that has just loaded asks the same question and gets the same answer, which is the
    // whole point: the queue is the runtime's, not this tab's memory of the event stream.
    const approval = store.approvals().find(candidate => candidate.sessionId === created.id && candidate.status === 'pending')!;
    await call(core, 'approve', 'approval.decide', { approvalId: approval.id, decision: 'approved' });
    expect((await items()).items).toEqual([]);
  });
  it('hands a runtime question to the clients and journals the answer', async () => {
    const { core, runtime, store } = setup(); const created = await session(core);
    await call(core, 'ask', 'session.message', { sessionId: created.id, text: 'askme: pick one' });
    // The question is pending in the snapshot, so a client that has just loaded can render it.
    const pending = value<{ questions: Array<{ id: string; questions: Array<{ question: string }> }> }>(await call(core, 'snap', 'system.snapshot')).questions;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.questions[0]?.question).toContain('Which database');
    expect(store.events(0, 100).some(event => event.data.type === 'question.requested')).toBe(true);

    await call(core, 'answer', 'question.answer', { questionId: pending[0]!.id, answers: [{ id: 'demo-1', selected: ['SQLite'] }] });
    expect(runtime.lastAnswers).toEqual([{ id: 'demo-1', selected: ['SQLite'] }]);
    // What was chosen is in the journal, not only that somebody chose.
    const resolved = store.events(0, 100).map(event => event.data).filter(data => data.type === 'question.resolved');
    expect(resolved.at(-1)).toMatchObject({ question: { status: 'answered', answers: [{ id: 'demo-1', selected: ['SQLite'] }] } });
    expect(value<{ questions: unknown[] }>(await call(core, 'snap2', 'system.snapshot')).questions).toEqual([]);
    // Answering twice is refused rather than silently re-sent.
    await expect(call(core, 'again', 'question.answer', { questionId: pending[0]!.id, answers: [] })).resolves.toMatchObject({ ok: false, error: { code: 'QUESTION_EXPIRED' } });
  });
  it('does not replay a command whose result was interrupted by a crash', async () => {
    const { core, store } = setup(); const params = { cwd: process.cwd(), runtimeId: 'demo' };
    const fingerprint = createHash('sha256').update(JSON.stringify({ method: 'session.create', params })).digest('hex');
    store.reserveRequest('pending', fingerprint);
    const response = await call(core, 'pending', 'session.create', params); expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('OUTCOME_UNKNOWN');
    expect(store.sessions()).toHaveLength(0);
  });
  it('validates unknown methods, protocol version, empty prompts and workspace paths', async () => {
    const { core } = setup(); const s = await session(core);
    expect((await core.handle({ v: 2, id: 'x', method: 'system.snapshot', params: {} })).ok).toBe(false);
    expect((await call(core, 'x', 'shell.execute', {})).ok).toBe(false);
    expect((await call(core, 'y', 'session.message', { sessionId: s.id, text: '  ' })).ok).toBe(false);
    expect((await call(core, 'z', 'session.create', { runtimeId: 'demo', cwd: 'relative/path' })).ok).toBe(false);
  });
  it('answers a request it cannot parse in the name of the client that sent it', async () => {
    const { core } = setup();
    // A method this host does not know is how an older host meets a newer client. Answering with some
    // other id leaves a remote client unable to match the reply at all: it waits for its own timeout,
    // and the tapped control looks dead for as long as that takes.
    const unknown = await call(core, 'the-request-id', 'shell.execute', {});
    expect(unknown).toMatchObject({ ok: false, id: 'the-request-id', error: { code: 'INVALID_REQUEST' } });
    expect(await core.handle({ v: 9, id: 'wrong-version', method: 'system.snapshot', params: {} })).toMatchObject({ ok: false, id: 'wrong-version' });
    expect(await core.handle({ nonsense: true })).toMatchObject({ ok: false, id: 'invalid' });
  });
});
describe('workspace browsing', () => {
  it('offers the folders a session could start in, without files or dotfolders', async () => {
    const { core } = setup();
    const root = await mkdtemp(join(tmpdir(), 'turnwire-browse-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'zeta')); await mkdir(join(root, 'Alpha')); await mkdir(join(root, '.hidden')); await writeFile(join(root, 'notes.txt'), 'not a folder');
    await symlink(join(root, 'zeta'), join(root, 'link'));
    const listing = value<WorkspaceListing>(await call(core, 'browse', 'workspace.list', { path: root }));
    expect(listing.path).toBe(await realpath(root));
    // Folders only, hidden ones left out, names in one stable order, and the link followed because
    // it leads to a folder the session could actually use.
    expect(listing.entries.map(entry => entry.name)).toEqual(['Alpha', 'link', 'zeta']);
    expect(listing.entries.map(entry => entry.path)).toEqual(['Alpha', 'link', 'zeta'].map(name => join(listing.path, name)));
    expect(listing.total).toBe(3);
    expect(listing.parent).toBe(dirname(listing.path));
    expect(listing.home).toBe(homedir());
  });
  it('starts at the host home and refuses paths that cannot host a session', async () => {
    const { core } = setup();
    const home = value<WorkspaceListing>(await call(core, 'home', 'workspace.list'));
    expect(home.path).toBe(await realpath(homedir()));
    const root = value<WorkspaceListing>(await call(core, 'filesystem-root', 'workspace.list', { path: '/' }));
    expect(root.parent).toBeUndefined();
    const file = fileURLToPath(new URL('./core.test.ts', import.meta.url));
    for (const path of ['relative/dir', join(tmpdir(), `turnwire-missing-${process.pid}`), file]) {
      const response = await call(core, `bad-${path}`, 'workspace.list', { path });
      expect(response.ok).toBe(false); if (!response.ok) expect(response.error.code).toBe('INVALID_WORKSPACE');
    }
  });
  it('reports a folder it cannot read instead of calling it empty', async () => {
    if (process.getuid?.() === 0) return;
    const { core } = setup();
    const root = await mkdtemp(join(tmpdir(), 'turnwire-closed-')); const closed = join(root, 'closed');
    await mkdir(closed, { mode: 0o000 });
    cleanup.push(async () => { await chmod(closed, 0o700); await rm(root, { recursive: true, force: true }); });
    const response = await call(core, 'closed', 'workspace.list', { path: closed });
    expect(response.ok).toBe(false); if (!response.ok) expect(response.error.code).toBe('WORKSPACE_UNREADABLE');
  });
});
/** Text passed through `error.message` or a status field is the host's English fallback, not UI copy. */
function stringLiteralTexts(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const texts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) texts.push(node.text);
    else if (ts.isTemplateExpression(node)) { texts.push(node.head.text); for (const span of node.templateSpans) texts.push(span.literal.text); }
    ts.forEachChild(node, visit);
  };
  visit(file); return texts;
}
describe('host-side internationalisation', () => {
  it('keeps host-side user-visible text English so --json stays stable', async () => {
    const repository = fileURLToPath(new URL('..', import.meta.url));
    const roots = ['packages/core/src', 'apps/daemon/src'];
    const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
    const offenders: string[] = [];
    for (const root of roots) {
      const directory = join(repository, root);
      for (const entry of await readdir(directory, { recursive: true })) {
        if (!entry.endsWith('.ts')) continue;
        const source = await readFile(join(directory, entry), 'utf8');
        for (const text of stringLiteralTexts(entry, source)) if (cjk.test(text)) offenders.push(`${root}/${entry}: ${JSON.stringify(text)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
