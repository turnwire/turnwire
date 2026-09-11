import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { DshRuntime, mapEvent, compactText } from '@turnwire/runtime-dsh';
import type { RuntimeEvent } from '@turnwire/runtime';
import { z } from 'zod';

let cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup = []; });
async function until(check: () => boolean) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); } }

// Contract fixture follows the pinned upstream fields, 303 cookie exchange,
// exact named arguments, mux frames and one-shot Remote event waterfall.
interface FixtureChild {
  id: string; activity: 'running' | 'inactive'; parent?: string; label?: string; mode?: 'one-shot' | 'continuable';
  hasChildren?: boolean; title?: string; elapsedMs?: number; settledMs?: number;
  todos?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
}
/** One prompt waiting in the fixture's inbox: the Host's own item id plus the client's request id. */
interface FixtureQueued { itemId: string; rpcId?: string; text: string; step?: boolean }
async function dshHost(options: { list?: 'existing' | 'empty'; create?: 'ok' | 'owned'; childrenError?: boolean; omitDetails?: boolean; oddDetail?: boolean } = {}) {
  let seq = 0; let running = false; const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  let children: FixtureChild[] = []; let queued: FixtureQueued[] = [];
  const records: Array<{ type: string; event: { seq: number; time: number; type: string; data: Record<string, unknown> } }> = [];
  const streams = new Map<WebSocket, string>(); const events = new Set<WebSocket>();
  const item = (socket: WebSocket, streamId: string, value: unknown) => socket.send(JSON.stringify({ type: 'item', streamId, value }));
  const emit = (type: string, data: Record<string, unknown>) => { const entry = { type: 'event', event: { seq: seq++, time: Date.now(), type, data } }; records.push(entry); for (const [socket, stream] of streams) item(socket, stream, entry); };
  /** Host-plane push, the channel api-session/status and approval requests already use. */
  const publish = (name: string, args: unknown[]) => { for (const socket of events) item(socket, 'events', { type: 'emit', event: name, args }); };
  /** The Host asks through the waterfall channel, exactly as an approval request arrives. */
  /** The Host withdrawing a pending waterfall request, as it does when a turn is aborted. */
  const cancel = (eventId: string) => { for (const socket of events) item(socket, 'events', { type: 'cancel', eventId }); };
  const ask = (questions: unknown[]) => { for (const socket of events) item(socket, 'events', { type: 'waterfall', event: 'user-questions/request', agentId: 's', eventId: 'question-1', request: { questions } }); };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/' && url.searchParams.get('token') === 'launch-secret') { res.writeHead(303, { 'set-cookie': 'dsh_auth=valid; HttpOnly', location: '/' }); res.end(); return; }
    if (req.headers.cookie !== 'dsh_auth=valid') { res.writeHead(401); res.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    let args: Record<string, unknown>; let rpcId: string;
    try { const envelope = z.object({ type: z.literal('client-request'), rpcId: z.string(), method: z.literal(url.pathname.slice('/api/'.length)), payload: z.object({ args: z.record(z.unknown()) }).strict() }).strict().parse(JSON.parse(Buffer.concat(chunks).toString())); args = envelope.payload.args; rpcId = envelope.rpcId; }
    catch { res.writeHead(400); res.end(); return; }
    calls.push({ path: url.pathname, args });
    let value: unknown;
    if (url.pathname === '/api/session/create') {
      const input = z.object({ request: z.object({ sessionId: z.string(), cwd: z.string() }).strict() }).strict().parse(args);
      // A live owner (an open DSH Web session, for example) refuses adoption with this wrapped error.
      if (options.create === 'owned') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'gateway/internal', message: `failed to create session "${input.request.sessionId}": SessionAlreadyOwnedError: session "${input.request.sessionId}" is already owned by an active write handle` } } })); return; }
      value = { sessionId: input.request.sessionId };
    }
    else if (url.pathname === '/api/session/list') {
      z.object({ _request: z.object({}).strict() }).strict().parse(args);
      // The Host projects each child's plan, label and timing onto the same listing every session
      // appears in, so a progress view needs no second read per child.
      // `session/list` carries projections as `{ asOfSeq, values }`, and a value is the projection's
      // client-facing shape — a fixture that nests these anywhere else would test nothing.
      const described = options.omitDetails ? [] : children.map(child => ({
        sessionId: child.id, running: child.activity === 'running',
        projections: { asOfSeq: seq, values: {
          ...(child.title === undefined ? {} : { title: child.title }),
          ...(child.todos === undefined ? {} : { todos: child.todos }),
          subagent: { mode: child.mode ?? 'one-shot', ...(child.label === undefined ? {} : { label: child.label }), seq: 1 },
          subagentTiming: child.activity === 'running' ? { descriptorSeen: true, settledMs: 0, active: { since: Date.now() - (child.elapsedMs ?? 0), through: seq } } : { descriptorSeen: true, settledMs: child.settledMs ?? 0 },
        } },
      }));
      const inbox = { 'next-turn': queued.filter(entry => entry.step !== true).map(entry => ({ id: entry.itemId, role: 'user', content: [{ type: 'text', text: entry.text }], source: { kind: 'user', ...(entry.rpcId === undefined ? {} : { rpcId: entry.rpcId }) } })), 'next-step': queued.filter(entry => entry.step === true).map(entry => ({ id: entry.itemId, role: 'user', content: [{ type: 'text', text: entry.text }], source: { kind: 'user', rpcId: entry.rpcId } })) };
      value = { items: options.list === 'empty' ? [] : [{ sessionId: 's', cwd: process.cwd(), running, projections: { asOfSeq: seq, values: { inbox } } }, ...described, ...(options.oddDetail ? [{ sessionId: 'odd', running: false, projections: { asOfSeq: 0, values: { todos: 'a projection shape this adapter has never seen' } } }] : [])] };
    }
    else if (url.pathname === '/api/session/prompt') {
      const input = z.object({ request: z.object({ requestId: z.string(), sessionId: z.literal('s'), mode: z.enum(['queue', 'steer']), content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }).strict() }).strict().parse(args);
      running = true; emit('user/message', { id: 'user-1', source: { kind: 'user', rpcId: input.request.requestId }, content: input.request.content }); emit('turn/start', { turn: 1 });
      for (const [socket, stream] of streams) {
        item(socket, stream, { type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt', revision: 1, startedAfterSeq: seq - 1, turn: 1, step: 1 } });
        item(socket, stream, { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt', revision: 2, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text: 'Hello' } } });
      }
      emit('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Hello world' }] }, stream: [] });
      for (const socket of events) { item(socket, 'events', { type: 'emit', event: 'api-session/status', args: ['s', true] }); item(socket, 'events', { type: 'waterfall', event: 'approval/request', agentId: 's', eventId: 'approval-1', request: { toolName: 'shell', reason: 'npm test' } }); }
      value = { accepted: true };
    } else if (url.pathname === '/api/$events/result') {
      const input = z.object({ clientId: z.literal('generation'), eventId: z.string(), outcome: z.object({ kind: z.enum(['result', 'next']), value: z.unknown().optional() }) }).strict().parse(args);
      // Only the approval carries the turn with it; a question answer is just a result, and `next`
      // is this client handing the request to another answerer.
      if (input.eventId !== 'approval-1' || input.outcome.kind === 'next') { value = { accepted: true }; }
      else {
        for (const socket of events) item(socket, 'events', { type: 'cancel', eventId: 'approval-1' });
        value = undefined; setTimeout(() => { running = false; emit('turn/end', { turn: 1, reason: 'completed' }); }, 30);
      }
    } else if (url.pathname === '/api/session/cancel') { value = { accepted: true }; running = false; emit('turn/end', { turn: 1, reason: 'cancelled' }); }
    else if (url.pathname === '/api/subagents/list') {
      // The generated `subagents/list` descriptor names its one positional parameter `parentSessionId`.
      const input = z.object({ parentSessionId: z.string() }).strict().parse(args);
      if (options.childrenError) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'subagent/projections-unavailable', message: 'no projection registry is mounted' } } })); return; }
      value = { parentAvailable: true, entries: children.filter(child => (child.parent ?? 's') === input.parentSessionId).map(child => ({ kind: 'child', id: child.id, activity: child.activity, hasChildren: child.hasChildren ?? false, mode: child.mode ?? 'one-shot', ...(child.label === undefined ? {} : { label: child.label }) })) };
    }
    else if (url.pathname === '/api/session/updateQueue') {
      const input = z.object({ request: z.object({ sessionId: z.literal('s'), itemId: z.string(), action: z.discriminatedUnion('kind', [z.object({ kind: z.literal('steer') }).strict(), z.object({ kind: z.literal('remove') }).strict(), z.object({ kind: z.literal('edit'), content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }).strict()]) }).strict() }).strict().parse(args);
      const item = queued.find(entry => entry.itemId === input.request.itemId);
      // The Host refuses an item that has already left the queue, which is the race a client's stale
      // row hits after the prompt has started running.
      if (!item) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'session/queue-item-not-found', message: 'queued item is no longer pending' } } })); return; }
      if (input.request.action.kind === 'remove') queued = queued.filter(entry => entry.itemId !== item.itemId);
      if (input.request.action.kind === 'edit') item.text = input.request.action.content[0]!.text;
      if (input.request.action.kind === 'steer') item.step = true;
      value = { accepted: true };
    }
    else { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => { if (req.url !== '/api/remote.mux' || req.headers.cookie !== 'dsh_auth=valid') { socket.destroy(); return; } wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws)); });
  wss.on('connection', socket => {
    socket.on('error', () => {});
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString()) as { type: string; streamId: string; endpoint: string; payload: { args: unknown } };
      if (frame.type !== 'open') return;
      if (frame.endpoint === '$events') { events.add(socket); item(socket, frame.streamId, { type: 'ready', clientId: 'generation', host: { home: '/tmp' } }); }
      if (frame.endpoint === 'session/follow') {
        z.object({ request: z.object({ address: z.object({ kind: z.literal('session'), sessionId: z.literal('s') }), maxMessages: z.number(), assistantStream: z.literal(true) }) }).strict().parse(frame.payload.args);
        streams.set(socket, frame.streamId); item(socket, frame.streamId, { type: 'snapshot', header: { version: 1, id: 's', cwd: process.cwd(), createdAt: Date.now(), isSeeded: false }, cursor: seq - 1, records, hasMore: false, projections: { asOfSeq: seq - 1, values: {} } });
      }
    });
    socket.on('close', () => { events.delete(socket); streams.delete(socket); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  cleanup.push(async () => { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(r => wss.close(() => r())); server.closeAllConnections?.(); await new Promise<void>(r => server.close(() => r())); });
  return { url: `http://127.0.0.1:${address.port}`, calls, streams, emit, publish, setChildren: (next: FixtureChild[]) => { children = next; }, ask, cancel, sockets: () => events.size, setQueued: (next: FixtureQueued[]) => { queued = next; }, disconnect: () => { for (const socket of wss.clients) socket.close(); } };
}
it('uses the official cookie, exact named RPC arguments and mux, and resolves approval cancellation races', async () => {
  const host = await dshHost(); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  const received: RuntimeEvent[] = []; expect((await runtime.health()).online).toBe(true);
  await runtime.createSession({ id: 's', cwd: process.cwd() }); runtime.subscribe('s', e => received.push(e)); await until(() => host.streams.size === 1);
  await runtime.sendMessage('s', { id: 'prompt', text: 'Do work' }); await until(() => received.some(e => e.type === 'approval.requested'));
  expect(received).toContainEqual({ type: 'status', status: 'running' });
  expect(received).toContainEqual({ type: 'message.user', messageId: 'prompt', text: 'Do work' });
  const promptCalls = () => host.calls.filter(c => c.path === '/api/session/prompt');
  expect(promptCalls().at(-1)?.args).toMatchObject({ request: { requestId: 'prompt', mode: 'queue' } });
  expect(received).toContainEqual({ type: 'message.delta', messageId: 'dsh:s:1:1', text: 'Hello' });
  expect(received).toContainEqual({ type: 'message.completed', messageId: 'dsh:s:1:1', text: 'Hello world' });
  await runtime.approve('s', 'approval-1', 'approved'); await until(() => received.some(e => e.type === 'status' && e.status === 'idle'));
  expect(received.filter(e => e.type === 'approval.resolved')).toEqual([{ type: 'approval.resolved', requestId: 'approval-1', decision: 'approved' }]);
  await expect(runtime.approve('s', 'approval-1', 'approved')).rejects.toThrow('has expired');
  expect(host.calls.some(c => c.path === '/api/session/list' && '_request' in c.args)).toBe(true);
  // Steering is a different wire value, not a client-side label.
  await runtime.sendMessage('s', { id: 'steer', text: '还要看日志', steer: true });
  expect(promptCalls().at(-1)?.args).toMatchObject({ request: { requestId: 'steer', mode: 'steer' } });
});
it('counts live background agents so a restart is not mistaken for a safe point', async () => {
  const host = await dshHost(); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  await runtime.createSession({ id: 's', cwd: process.cwd() }); runtime.subscribe('s', () => {}); await until(() => host.streams.size === 1);
  // The count is a live query, so it stays right without any lifecycle frame reaching this client.
  await expect(runtime.busy()).resolves.toBe(0);
  host.setChildren([{ id: 'child-1', activity: 'running' }, { id: 'child-2', activity: 'running' }]);
  await expect(runtime.busy()).resolves.toBe(2);
  host.setChildren([{ id: 'child-1', activity: 'running' }, { id: 'child-2', activity: 'inactive' }]);
  await expect(runtime.busy()).resolves.toBe(1);
  expect(host.calls.some(c => c.path === '/api/subagents/list' && c.args.parentSessionId === 's')).toBe(true);
});
it('reports no background agents rather than failing when the Host cannot answer', async () => {
  const host = await dshHost({ childrenError: true }); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  await runtime.createSession({ id: 's', cwd: process.cwd() }); runtime.subscribe('s', () => {}); await until(() => host.streams.size === 1);  await expect(runtime.busy()).resolves.toBe(0);
});
it('describes the agents under a session, nested ones included, for the progress view', async () => {
  const host = await dshHost(); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  await runtime.createSession({ id: 's', cwd: process.cwd() }); runtime.subscribe('s', () => {}); await until(() => host.streams.size === 1);
  host.setChildren([
    { id: 'child-1', activity: 'running', label: 'Translate the root docs', elapsedMs: 12_000, hasChildren: true, todos: [{ content: 'Translate README', status: 'completed' }, { content: 'Check links', status: 'in_progress' }] },
    { id: 'child-2', activity: 'inactive', label: 'CLI i18n', mode: 'continuable', settledMs: 42_000, title: 'CLI i18n run' },
    { id: 'grandchild', activity: 'running', parent: 'child-1', label: 'Check links' },
  ]);
  const agents = await runtime.listSubagents('s');
  // Breadth-first: the nested child follows both direct children.
  expect(agents.map(agent => [agent.id, agent.parentId, agent.depth, agent.activity, agent.mode, agent.label])).toEqual([
    ['child-1', 's', 1, 'running', 'one-shot', 'Translate the root docs'],
    ['child-2', 's', 1, 'inactive', 'continuable', 'CLI i18n'],
    ['grandchild', 'child-1', 2, 'running', 'one-shot', 'Check links'],
  ]);
  // A running child is timed against now; a settled one reports the duration it ran for.
  expect(agents[0]!.elapsedMs).toBeGreaterThanOrEqual(12_000);
  expect(agents[1]!.elapsedMs).toBe(42_000);
  // The plan is the closest thing to progress the Host projects without replaying a transcript.
  expect(agents[0]!.todos).toEqual([{ content: 'Translate README', status: 'completed' }, { content: 'Check links', status: 'in_progress' }]);
  expect(agents[2]!.todos).toEqual([]);
  expect(host.calls.some(c => c.path === '/api/subagents/list' && c.args.parentSessionId === 'child-1')).toBe(true);
});
it('uses current child activity independently of todos and resident continuable identity', async () => {
  const host = await dshHost(); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  await runtime.createSession({ id: 's', cwd: process.cwd() });
  const todos = [{ content: 'Finish work', status: 'completed' as const }];
  // Native subagents/list reads the Agent driver's status, not whether a resident exists.
  host.setChildren([{ id: 'resident', mode: 'continuable', activity: 'running', todos }]);
  expect(await runtime.listSubagents('s')).toMatchObject([{ id: 'resident', activity: 'running', todos }]);
  // Settlement must replace the prior running read; incomplete todos are not lifecycle state.
  const unfinished = [{ content: 'Finish work', status: 'in_progress' as const }];
  host.setChildren([{ id: 'resident', mode: 'continuable', activity: 'inactive', todos: unfinished }]);
  expect(await runtime.listSubagents('s')).toMatchObject([{ id: 'resident', mode: 'continuable', activity: 'inactive', todos: unfinished }]);
  // The same durable identity can start another turn without inventing a terminal state.
  host.setChildren([{ id: 'resident', mode: 'continuable', activity: 'running', todos }]);
  expect(await runtime.listSubagents('s')).toMatchObject([{ id: 'resident', activity: 'running' }]);
});
it('still names an agent whose own detail cannot be read', async () => {
  const host = await dshHost({ omitDetails: true }); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  await runtime.createSession({ id: 's', cwd: process.cwd() }); runtime.subscribe('s', () => {}); await until(() => host.streams.size === 1);
  host.setChildren([{ id: 'child-1', activity: 'running', label: 'Translate the root docs', elapsedMs: 5_000, todos: [{ content: 'Translate README', status: 'in_progress' }] }]);
  // The listing route is the authority on which agents exist; a failed detail read may not hide one.
  const agents = await runtime.listSubagents('s');
  expect(agents.map(agent => [agent.id, agent.label, agent.activity, agent.todos.length, agent.elapsedMs])).toEqual([['child-1', 'Translate the root docs', 'running', 0, undefined]]);
});
it('reads each session row on its own, so one unknown shape cannot blank the rest', async () => {
  const host = await dshHost({ oddDetail: true }); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  await runtime.createSession({ id: 's', cwd: process.cwd() }); runtime.subscribe('s', () => {}); await until(() => host.streams.size === 1);
  host.setChildren([
    { id: 'child-1', activity: 'running', label: 'Translate the root docs', elapsedMs: 5_000, todos: [{ content: 'Translate README', status: 'in_progress' }] },
    { id: 'child-2', activity: 'inactive', settledMs: 9_000 },
  ]);
  const agents = await runtime.listSubagents('s');
  // The unparseable row is skipped; both real children keep the detail that described them.
  expect(agents.map(agent => [agent.id, agent.todos.length, agent.elapsedMs === undefined ? undefined : Math.round(agent.elapsedMs / 1000)])).toEqual([['child-1', 1, 5], ['child-2', 0, 9]]);
});
it('carries a question to the client watching the session and returns that answer', async () => {
  const host = await dshHost(); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  await runtime.createSession({ id: 's', cwd: process.cwd() }); const received: RuntimeEvent[] = []; runtime.subscribe('s', event => received.push(event)); await until(() => host.streams.size === 1);
  host.ask([{ id: 'q1', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }]);
  await until(() => received.some(event => event.type === 'question.requested'));
  expect(received.find(event => event.type === 'question.requested')).toMatchObject({ type: 'question.requested', requestId: 'question-1', questions: [{ id: 'q1', question: 'Which database?' }] });
  await runtime.answerQuestion('s', 'question-1', [{ id: 'q1', selected: ['SQLite'] }]);
  // The whole batch goes back as the Host's own answer shape, under the client that was asked.
  expect(host.calls.at(-1)).toMatchObject({ path: '/api/$events/result', args: { clientId: 'generation', eventId: 'question-1', outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: ['SQLite'] }] } } } });
  await until(() => received.some(event => event.type === 'question.resolved'));
  await expect(runtime.answerQuestion('s', 'question-1', [{ id: 'q1', selected: ['SQLite'] }])).rejects.toMatchObject({ code: 'QUESTION_EXPIRED' });
});
it('clears a pending question when the Host withdraws it', async () => {
  const host = await dshHost(); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  await runtime.createSession({ id: 's', cwd: process.cwd() }); const received: RuntimeEvent[] = []; runtime.subscribe('s', event => received.push(event)); await until(() => host.sockets() === 1);
  host.ask([{ id: 'q1', question: 'Which database?' }]);
  await until(() => received.some(event => event.type === 'question.requested'));
  host.cancel('question-1');
  await until(() => received.some(event => event.type === 'question.resolved'));
  expect(received.find(event => event.type === 'question.resolved')).toMatchObject({ type: 'question.resolved', requestId: 'question-1', decision: 'cancelled' });
  // And the answer that arrives afterwards is refused rather than sent to a withdrawn request.
  await expect(runtime.answerQuestion('s', 'question-1', [{ id: 'q1', selected: ['SQLite'] }])).rejects.toMatchObject({ code: 'QUESTION_EXPIRED' });
});
it('leaves a question to the Host when nobody is watching the session', async () => {
  const host = await dshHost(); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  // Connected, but following nothing: no Turnwire client is watching this session.
  await runtime.createSession({ id: 's', cwd: process.cwd() }); await until(() => host.sockets() === 1);
  // A question for a session this process is not following must reach an answerer that is asked
  // for it rather than being answered, or silently dropped, on someone else's behalf.
  host.ask([{ id: 'q1', question: 'Which database?' }]);
  await until(() => host.calls.some(call => call.path === '/api/$events/result' && call.args.eventId === 'question-1'));
  expect(host.calls.find(call => call.args.eventId === 'question-1')?.args).toMatchObject({ outcome: { kind: 'next' } });
});
it('reports missing DSH credentials without pretending the runtime is available', async () => {
  const runtime = new DshRuntime({ url: 'http://127.0.0.1:1' }); cleanup.push(() => runtime.dispose());
  expect((await runtime.health()).online).toBe(false); await expect(runtime.createSession({ id: 's', cwd: '/tmp' })).rejects.toThrow('TURNWIRE_DSH_TOKEN');
});
it('changes a waiting prompt by the id the client knows, not the one the Host minted', async () => {
  const host = await dshHost(); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  host.setQueued([{ itemId: 'dsh-1', rpcId: 'client-1', text: 'first draft' }]);
  await runtime.queueAction('s', 'client-1', { kind: 'steer' });
  // The Host is addressed with its own item id, translated from the client's request id.
  expect(host.calls.at(-1)).toMatchObject({ path: '/api/session/updateQueue', args: { request: { sessionId: 's', itemId: 'dsh-1', action: { kind: 'steer' } } } });
  await runtime.queueAction('s', 'client-1', { kind: 'edit', text: 'second draft' });
  expect(host.calls.at(-1)?.args).toMatchObject({ request: { itemId: 'dsh-1', action: { kind: 'edit', content: [{ type: 'text', text: 'second draft' }] } } });
  await runtime.queueAction('s', 'client-1', { kind: 'remove' });
  expect(host.calls.at(-1)?.args).toMatchObject({ request: { action: { kind: 'remove' } } });
});
it('lists what is still waiting, so a page that just loaded knows the queue', async () => {
  const host = await dshHost(); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  host.setQueued([
    { itemId: 'dsh-1', rpcId: 'client-1', text: 'first draft' },
    // A prompt queued by another client of the same Host has no Turnwire id, so no Turnwire client
    // could act on it and it is not offered as one of ours.
    { itemId: 'dsh-2', text: 'from the Host own Web UI' },
    { itemId: 'dsh-3', rpcId: 'client-3', text: 'steered', step: true },
  ]);
  await expect(runtime.listQueue('s')).resolves.toEqual([
    { messageId: 'client-1', target: 'next-turn', text: 'first draft' },
    { messageId: 'client-3', target: 'next-step', text: 'steered' },
  ]);
});
it('says a prompt is gone when it is no longer waiting, from either side of the race', async () => {
  const host = await dshHost(); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  host.setQueued([{ itemId: 'dsh-1', rpcId: 'client-1', text: 'first draft' }]);
  // A client id that is not in the Host's inbox at all.
  await expect(runtime.queueAction('s', 'never-queued', { kind: 'remove' })).rejects.toMatchObject({ code: 'QUEUE_ITEM_GONE' });
  // The Host's own refusal for an item that left the queue between the read and the write.
  host.setQueued([]);
  await expect(runtime.queueAction('s', 'client-1', { kind: 'remove' })).rejects.toMatchObject({ code: 'QUEUE_ITEM_GONE' });
});
it('expires pending approvals on connection loss', async () => {
  const host = await dshHost(); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  await runtime.createSession({ id: 's', cwd: process.cwd() }); const received: RuntimeEvent[] = []; runtime.subscribe('s', e => received.push(e)); await until(() => host.streams.size === 1);
  await runtime.sendMessage('s', { id: 'prompt', text: 'test' }); await until(() => received.some(e => e.type === 'approval.requested'));
  host.disconnect(); await until(() => received.some(e => e.type === 'approval.resolved'));
  expect(received).toContainEqual({ type: 'approval.resolved', requestId: 'approval-1', decision: 'cancelled' });
});
it('maps compact history, tool correlation and unknown events without leaking reasoning', () => {
  expect(compactText([{ type: 'text-chunks', texts: ['hello', ' world'] }, { type: 'reasoning-chunks', texts: ['private'] }])).toBe('hello world');
  expect(mapEvent('s', { type: 'future/event', seq: 0, time: 0, data: {} })).toEqual([]);
  expect(mapEvent('s', { type: 'tool/result', seq: 1, time: 1, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: 'passed' }] }] } } })[0]).toMatchObject({ type: 'tool.finished', callId: 'c', detail: 'passed' });
  expect(mapEvent('s', { type: 'tool/call', seq: 2, time: 2, data: { callId: 'failed', name: 'shell', arguments: { command: 'npm test' } } })[0]).toMatchObject({ type: 'tool.started', detail: '{"command":"npm test"}' });
  expect(mapEvent('s', { type: 'tool/result', seq: 3, time: 3, data: { message: { content: [{ type: 'tool-result', toolCallId: 'failed', isError: true, content: 'Test failed' }] } } })[0]).toMatchObject({ type: 'tool.finished', callId: 'failed', detail: 'Test failed', isError: true });
});
it('follows an existing session instead of failing to claim one a live client owns', async () => {
  const host = await dshHost({ create: 'owned' }); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  await expect(runtime.resumeSession({ id: 's', cwd: process.cwd() })).resolves.toEqual({ id: 's', cwd: process.cwd(), status: 'idle' });
  expect(host.calls.some(c => c.path === '/api/session/create')).toBe(false);
  await until(() => host.streams.size === 1);
});
it('adopts a session that does not exist yet', async () => {
  const host = await dshHost({ list: 'empty' }); const runtime = new DshRuntime({ url: host.url, token: 'launch-secret' }); cleanup.push(() => runtime.dispose());
  await expect(runtime.resumeSession({ id: 's', cwd: process.cwd() })).resolves.toEqual({ id: 's', cwd: process.cwd(), status: 'idle' });
  expect(host.calls.filter(c => c.path === '/api/session/create')).toHaveLength(1);
});
