import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { DshRuntime } from '@turnwire/runtime-dsh';
import type { SubagentView } from '@turnwire/protocol';
import { historyRecords } from '../packages/runtime-dsh/src/history.js';

const child: SubagentView = { id: 'child', parentId: 'nested-parent', depth: 2, mode: 'continuable', activity: 'running', label: 'Worker', todos: [] };
const event = (seq: number, type: string, data: Record<string, unknown> = {}) => ({ type: 'event' as const, event: { seq, type, data, time: 1700000000000 + seq } });
const text = (value: string) => [{ type: 'text', text: value }];
let cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup = []; });
async function host(options: { seeded?: boolean; mode?: 'error' | 'end' | 'cancel' | 'disconnect' | 'pending'; records?: ReturnType<typeof event>[]; active?: unknown } = {}) {
  const records = options.records ?? [event(0, 'user/message', { content: text('delegation'), source: { kind: 'subagent' } })];
  const requests: Array<{ endpoint: string; request: any }> = []; const frames: any[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/?token=secret') { res.writeHead(303, { 'set-cookie': 'auth=yes' }); res.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/api/session/list') {
      expect(req.headers.cookie).toBe('auth=yes');
      expect(input).toMatchObject({ type: 'client-request', method: 'session/list', payload: { args: { _request: {} } } });
      res.end(JSON.stringify({ type: 'server-response', rpcId: input.rpcId, result: { ok: true, value: { items: [] } } }));
      return;
    }
    const request = input.payload.args.request;
    requests.push({ endpoint: req.url!, request });
    const eligible = records.filter(row => row.event.seq <= request.throughSeq && row.event.seq < (request.beforeSeq ?? Infinity));
    const page = eligible.slice(-request.maxMessages);
    res.end(JSON.stringify({ type: 'server-response', rpcId: input.rpcId, result: { ok: true, value: { records: page, hasMore: eligible.length > page.length } } }));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', socket => socket.on('message', raw => {
    const frame = JSON.parse(raw.toString()); frames.push(frame);
    if (frame.type === 'cancel') { socket.send(JSON.stringify({ type: 'end', streamId: frame.streamId })); return; }
    if (frame.endpoint === '$events') { socket.send(JSON.stringify({ type: 'item', streamId: 'events', value: { type: 'ready', clientId: 'test' } })); return; }
    if (frame.endpoint === 'session/control') { socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } } })); return; }
    requests.push({ endpoint: frame.endpoint, request: frame.payload.args.request });
    if (options.mode === 'pending') return;
    if (options.mode === 'disconnect') { socket.close(); return; }
    if (options.mode) { socket.send(JSON.stringify({ type: options.mode, streamId: frame.streamId, error: { code: 'subagent/not-found', message: 'missing' } })); return; }
    const page = records.slice(-frame.payload.args.request.maxMessages);
    socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'snapshot', header: { isSeeded: options.seeded ?? false }, cursor: records.at(-1)?.event.seq ?? -1, records: page, hasMore: page.length < records.length, assistantStream: { activeAttempt: options.active } } }));
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const runtime = new DshRuntime({ url: `http://127.0.0.1:${address.port}`, token: 'secret' });
  cleanup.push(async () => { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => server.close(() => resolve()))); });
  cleanup.push(() => runtime.dispose());
  return { runtime, requests, frames };
}
it('reads only child addresses, cancels snapshot, hides inherited context and reasoning, pins pages', async () => {
  const h = await host({ seeded: true, records: [
    event(0, 'user/message', { content: text('PRIVATE PARENT') }), event(1, 'session/end-seed', { inherited: true }),
    event(2, 'user/message', { content: text('delegation'), source: { kind: 'subagent' } }), event(3, 'session/end-seed'),
    event(4, 'assistant/message', { turn: 1, step: 1, message: { content: [...text('public'), { type: 'reasoning', text: 'SECRET' }] } }),
  ], active: { attemptId: 'a', turn: 2, step: 1, stream: [{ type: 'text-chunks', texts: ['live'] }, { type: 'reasoning-chunks', texts: ['SECRET'] }] } });
  const page = await h.runtime.subagentHistory('root', child, { limit: 2 });
  expect(page.records.map(row => row.text)).toEqual(['public', 'live']);
  expect(page.records.at(-1)?.complete).toBe(false);
  expect(page.nextBefore).toBe(3);
  const older = await h.runtime.subagentHistory('root', child, { before: page.nextBefore!, cursor: page.cursor, limit: 2 });
  expect(older.records.map(row => row.text)).toEqual(['delegation']); expect(older.hasMore).toBe(false);
  expect(JSON.stringify([page, older])).not.toMatch(/PRIVATE PARENT|SECRET/);
  expect(h.requests.every(row => row.request.address.kind === 'subagent' && row.request.address.parentSessionId === 'nested-parent')).toBe(true);
  expect(h.requests.filter(row => row.endpoint === 'session/follow')).toHaveLength(1);
  expect(h.requests.filter(row => row.endpoint.includes('page')).every(row => row.request.throughSeq === 4)).toBe(true);
  await new Promise(resolve => setImmediate(resolve));
  expect(h.frames.some(frame => frame.type === 'cancel')).toBe(true);
  expect((await h.runtime.health()).online).toBe(true);
});
it('correlates tool results with inputs across a page boundary and strips non-text metadata', async () => {
  const h = await host({ records: [event(0, 'tool/call', { callId: 'c', name: 'read', arguments: '{"path":"a"}' }), event(1, 'tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'c', content: [...text('output'), { type: 'reasoning', text: 'SECRET' }], isError: true }] }, meta: { secret: 'SECRET' } })] });
  const page = await h.runtime.subagentHistory('root', child, { limit: 1 });
  expect(page.records).toEqual([expect.objectContaining({ id: 'dsh:child:tool:c', tool: 'read', input: '{"path":"a"}', output: 'output', isError: true, complete: true })]);
  expect(JSON.stringify(page)).not.toContain('SECRET');
});
it('normalizes durable attempts, tool calls, and times without exposing system events', () => {
  const rows = historyRecords('child', [event(0, 'system/message', { content: text('SECRET') }), event(1, 'assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'text-chunks', texts: ['partial'] }] }), event(2, 'tool/call', { callId: 'c', name: 'read', arguments: '{}' })].map(row => row.event));
  expect(rows.map(row => row.text)).toEqual(['partial', '{}']); expect(rows[0]?.time).toBe(new Date(1700000000001).toISOString()); expect(rows[1]?.complete).toBe(false);
});
for (const mode of ['error', 'end', 'cancel'] as const) it(`isolates child ${mode} from the main connection`, async () => {
  const h = await host({ mode });
  await expect(h.runtime.subagentHistory('root', child, { limit: 1 })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
  expect((await h.runtime.health()).online).toBe(true);
});
it('rejects pending history on disconnect', async () => {
  const h = await host({ mode: 'disconnect' });
  await expect(h.runtime.subagentHistory('root', child, { limit: 1 })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
});
it('cleans pending reads on disposal and ignores cancellation acknowledgements', async () => {
  const h = await host({ mode: 'pending' });
  await h.runtime.health();
  const pending = h.runtime.subagentHistory('root', child, { limit: 1 });
  const rejection = expect(pending).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
  await new Promise(resolve => setImmediate(resolve));
  await h.runtime.dispose(); await rejection;
});
it('times out an isolated read without terminating the connection', async () => {
  const h = await host({ mode: 'pending' });
  await h.runtime.health();
  vi.useFakeTimers();
  try {
    const pending = h.runtime.subagentHistory('root', child, { limit: 1 });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(10_001); await rejection;
    expect((await h.runtime.health()).online).toBe(true);
  } finally { vi.useRealTimers(); }
});
it('fails closed when a seeded journal has no trustworthy boundary', async () => {
  const h = await host({ seeded: true });
  await expect(h.runtime.subagentHistory('root', child, { limit: 1 })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
});
it('supports an empty cursor without a latest-page sentinel', async () => {
  const h = await host({ records: [] });
  expect(await h.runtime.subagentHistory('root', child, { limit: 1 })).toMatchObject({ records: [], cursor: -1, hasMore: false, nextBefore: null });
  expect(h.requests.map(row => row.endpoint)).toEqual(['session/follow']);
});
