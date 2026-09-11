import { afterEach, expect, it, vi } from 'vitest';
import { LocalClient, RemoteClient, call, loadHistory, loadHistoryPage, loadHistoryRecord } from '../packages/sdk/src/index.js';
import type { RpcClient, TurnwireClient } from '../packages/sdk/src/index.js';
import { methodSchemas, methodResultSchemas, parseMethodResult, TurnwireError } from '../packages/protocol/src/index.js';
const event = { seq: 2, originSeq: 1, time: 'now', data: { type: 'message.completed' as const, sessionId: 's', messageId: 'm', text: 'full text' } };
const page = { events: [event], cursor: 2, hasMore: false, nextBefore: null };
const mockClient = (request: ReturnType<typeof vi.fn>) => ({ request, subscribe: vi.fn(), close: vi.fn() }) as unknown as TurnwireClient;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('covers every method and preserves old optional receipt fields', () => {
  expect(Object.keys(methodResultSchemas).sort()).toEqual(Object.keys(methodSchemas).sort());
  expect(parseMethodResult('session.message', { accepted: true, messageId: 'm' })).toEqual({ accepted: true, messageId: 'm' });
  expect(() => parseMethodResult('session.cancel', { accepted: 'yes' })).toThrow();
  expect(parseMethodResult('request.result', { state: 'completed', response: { v: 1, id: 'r', ok: false, error: { code: 'OLD_CODE', message: 'old host' } } })).toMatchObject({ state: 'completed' });
});
it('typed adapter validates params before dispatch and checks mock results', async () => {
  const request = vi.fn().mockResolvedValue({ accepted: true }); const client = mockClient(request);
  await expect(call(client, 'session.cancel', { sessionId: '' })).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
  await expect(call(client, 'session.cancel', { sessionId: 's' })).resolves.toEqual({ accepted: true });
  request.mockResolvedValue({ accepted: false }); await expect(call(client, 'session.cancel', { sessionId: 's' })).rejects.toThrow();
});
// Compile-only assertions: supplied result generics cannot override the actual method contract.
function typeContracts(client: LocalClient, old: RpcClient) {
  const result: Promise<{ accepted: true }> = client.call('session.cancel', { sessionId: 's' });
  const inferred: Promise<{ accepted: true }> = call(old, 'session.cancel', { sessionId: 's' });
  // @ts-expect-error sessionId is required
  client.call('session.cancel');
  // @ts-expect-error wrong method params
  client.call('session.cancel', { cwd: '/' });
  // @ts-expect-error result follows method
  const wrong: Promise<string> = client.call('session.cancel', { sessionId: 's' });
  return [result, inferred, wrong];
}
void typeContracts;
it('local legacy generic responses are validated by method and response ID', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ v: 1, id: 'r', ok: true, result: { accepted: 'bad' } }) }); vi.stubGlobal('fetch', fetcher);
  const client = new LocalClient('http://localhost:7777', 'token');
  await expect(client.request<boolean>('session.cancel', { sessionId: 's' }, 'r')).rejects.toThrow();
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ v: 1, id: 'other', ok: true, result: { accepted: true } }) });
  await expect(client.request('session.cancel', { sessionId: 's' }, 'r')).rejects.toThrow('Response ID mismatch');
});
it('remote legacy responses reject invalid payloads without leaving promises pending', async () => {
  const client = new RemoteClient({ v: 1, relayUrl: 'ws://localhost:7777', hostId: 'h', clientId: 'c', token: 'x'.repeat(32), key: 'a'.repeat(64), name: 'test' });
  const internal = client as unknown as { connect: () => Promise<void>; transport: { send: () => Promise<void> }; receive: (message: unknown) => void };
  internal.connect = async () => {}; internal.transport = { send: async () => {} };
  const pending = client.request('session.cancel', { sessionId: 's' }, 'r'); await Promise.resolve();
  internal.receive({ kind: 'response', body: { v: 1, id: 'r', ok: true, result: { accepted: false } } });
  await expect(pending).rejects.toThrow();
});
it('history page validates schema, session scope and progressing cursors', async () => {
  for (const value of [{ ...page, cursor: 'bad' }, { ...page, events: [{ ...event, data: { ...event.data, sessionId: 'other' } }] }, { ...page, hasMore: true, nextBefore: 5 }]) {
    await expect(loadHistoryPage(mockClient(vi.fn().mockResolvedValue(value)), 's', 5)).rejects.toThrow();
  }
});
it('full history reconstructs truncated records once from bounded chunks', async () => {
  const text = JSON.stringify([event]); const request = vi.fn(async (method: string, params: { offset?: number }) => method === 'history.page' ? { ...page, events: [{ ...event, truncation: { originalBytes: 500, reason: 'transport-preview' }, data: { ...event.data, text: 'preview' } }] } : params.offset === 0 ? { data: text.slice(0, 10), nextOffset: 10, cursor: 2 } : { data: text.slice(10), nextOffset: null, cursor: 2 });
  expect(await loadHistory(mockClient(request), 's')).toEqual([event]); expect(request).toHaveBeenCalledTimes(3);
});
it('history chunks retry changed records but reject wrong scope and offsets', async () => {
  const request = vi.fn().mockRejectedValueOnce(new TurnwireError('HISTORY_CHANGED', 'changed')).mockResolvedValue({ data: JSON.stringify([event]), nextOffset: null, cursor: 2 });
  expect(await loadHistoryRecord(mockClient(request), 's', 1)).toEqual([event]); expect(request).toHaveBeenCalledTimes(2);
  await expect(loadHistoryRecord(mockClient(vi.fn().mockResolvedValue({ data: 'x', nextOffset: 0, cursor: 2 })), 's', 1)).rejects.toThrow('offset');
  await expect(loadHistoryRecord(mockClient(vi.fn().mockResolvedValue({ data: JSON.stringify([event]), nextOffset: null, cursor: 2 })), 'other', 1)).rejects.toThrow('scope');
});
it('fails explicitly before assembling more than 64 MiB per history record', async () => {
  const data = 'x'.repeat(65_536);
  const request = vi.fn(async (_method: string, params: { offset: number }) => ({ data, nextOffset: params.offset + data.length, cursor: 2 }));
  await expect(loadHistoryRecord(mockClient(request), 's', 1)).rejects.toThrow('64 MiB');
  expect(request).toHaveBeenCalledTimes(1025);
});
it('local sockets ignore stale opens and cancel generation deadlines', async () => {
  vi.useFakeTimers(); const sockets: FakeSocket[] = [];
  class FakeSocket { onopen?: () => void; onclose?: (event: { code: number }) => void; onmessage?: (message: { data: string }) => void; onerror?: () => void; send = vi.fn(); close = vi.fn(() => this.onclose?.({ code: 1006 })); constructor() { sockets.push(this); } }
  vi.stubGlobal('WebSocket', FakeSocket); vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const client = new LocalClient('http://localhost:7777', 'token'); const unsubscribe = client.subscribe(() => {}); const first = sockets[0]!;
  unsubscribe(); first.onopen?.(); expect(first.send).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(20_000); expect(sockets).toHaveLength(1);
  client.subscribe(() => {}); const second = sockets[1]!; second.onopen?.(); expect(second.send).toHaveBeenCalledOnce();
  second.onmessage?.({ data: JSON.stringify({ type: 'ready' }) }); await vi.advanceTimersByTimeAsync(10_000); expect(second.close).not.toHaveBeenCalled();
  second.close(); await vi.advanceTimersByTimeAsync(30_000); expect(sockets.length).toBeGreaterThan(2); client.close();
});
