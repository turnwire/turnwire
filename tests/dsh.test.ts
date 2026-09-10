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
async function dshHost(options: { list?: 'existing' | 'empty'; create?: 'ok' | 'owned' } = {}) {
  let seq = 0; let running = false; const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const records: Array<{ type: string; event: { seq: number; time: number; type: string; data: Record<string, unknown> } }> = [];
  const streams = new Map<WebSocket, string>(); const events = new Set<WebSocket>();
  const item = (socket: WebSocket, streamId: string, value: unknown) => socket.send(JSON.stringify({ type: 'item', streamId, value }));
  const emit = (type: string, data: Record<string, unknown>) => { const entry = { type: 'event', event: { seq: seq++, time: Date.now(), type, data } }; records.push(entry); for (const [socket, stream] of streams) item(socket, stream, entry); };
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
    else if (url.pathname === '/api/session/list') { z.object({ _request: z.object({}).strict() }).strict().parse(args); value = { items: options.list === 'empty' ? [] : [{ sessionId: 's', cwd: process.cwd(), running }] }; }
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
      z.object({ clientId: z.literal('generation'), eventId: z.string(), outcome: z.object({ kind: z.literal('result'), value: z.enum(['allowed-once', 'rejected']) }) }).strict().parse(args);
      for (const socket of events) item(socket, 'events', { type: 'cancel', eventId: 'approval-1' });
      value = undefined; setTimeout(() => { running = false; emit('turn/end', { turn: 1, reason: 'completed' }); }, 30);
    } else if (url.pathname === '/api/session/cancel') { value = { accepted: true }; running = false; emit('turn/end', { turn: 1, reason: 'cancelled' }); }
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
  cleanup.push(async () => { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(r => wss.close(() => r())); await new Promise<void>(r => server.close(() => r())); });
  return { url: `http://127.0.0.1:${address.port}`, calls, streams, disconnect: () => { for (const socket of wss.clients) socket.close(); } };
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
  await expect(runtime.approve('s', 'approval-1', 'approved')).rejects.toThrow('失效');
  expect(host.calls.some(c => c.path === '/api/session/list' && '_request' in c.args)).toBe(true);
  // Steering is a different wire value, not a client-side label.
  await runtime.sendMessage('s', { id: 'steer', text: '还要看日志', steer: true });
  expect(promptCalls().at(-1)?.args).toMatchObject({ request: { requestId: 'steer', mode: 'steer' } });
});
it('reports missing DSH credentials without pretending the runtime is available', async () => {
  const runtime = new DshRuntime({ url: 'http://127.0.0.1:1' }); cleanup.push(() => runtime.dispose());
  expect((await runtime.health()).online).toBe(false); await expect(runtime.createSession({ id: 's', cwd: '/tmp' })).rejects.toThrow('TURNWIRE_DSH_TOKEN');
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
