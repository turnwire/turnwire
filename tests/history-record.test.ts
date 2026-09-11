import { afterEach, expect, it } from 'vitest';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import type { Session } from '@turnwire/protocol';

let core: TurnwireCore | undefined;
afterEach(async () => { await core?.dispose(); core = undefined; });
function setup() {
  const store = new Store(':memory:');
  const runtime = new DemoRuntime();
  core = new TurnwireCore(store, [runtime], { id: 'test', name: 'test' });
  const session: Session = { id: 's', runtimeId: 'demo', runtimeSessionId: 's', title: 'test', cwd: '/tmp', status: 'idle', createdAt: 'now', updatedAt: 'now' };
  store.append({ type: 'session.created', session });
  const event = store.append({ type: 'message.completed', sessionId: 's', messageId: 'large', text: '🙂'.repeat(100_000) })!;
  return { store, event, request: (method: string, params: unknown) => core!.handle({ v: 1, id: crypto.randomUUID(), method, params }) };
}
it('reads oversized records losslessly through bounded session-scoped chunks', async () => {
  const { store, event, request } = setup();
  const preview = await request('history.page', { sessionId: 's', limit: 40 });
  expect(preview.ok).toBe(true);
  if (preview.ok) expect(JSON.stringify(preview.result)).toContain('transport-preview');
  let offset = 0; let cursor: number | undefined; let text = '';
  do {
    const response = await request('history.record', { sessionId: 's', originSeq: event.seq, offset, limit: 65536, ...(cursor === undefined ? {} : { cursor }) });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    const result = response.result as { data: string; cursor: number; nextOffset: number | null };
    expect(result.data.length).toBeLessThanOrEqual(65536);
    cursor = result.cursor; text += result.data;
    if (result.nextOffset === null) break;
    expect(result.nextOffset).toBeGreaterThan(offset); offset = result.nextOffset;
  } while (true);
  expect(JSON.parse(text)).toEqual(store.historyRecord('s', event.seq));
  const absent = await request('history.record', { sessionId: 's', originSeq: event.seq + 100 });
  expect(absent).toMatchObject({ ok: false, error: { code: 'HISTORY_NOT_FOUND' } });
});
it('rejects mixed record revisions and invalid offsets rather than corrupting exports', async () => {
  const { store, event, request } = setup();
  const first = await request('history.record', { sessionId: 's', originSeq: event.seq });
  if (!first.ok) throw new Error(first.error.message);
  const cursor = (first.result as { cursor: number }).cursor;
  store.append({ type: 'message.completed', sessionId: 's', messageId: 'large', text: 'replacement' });
  expect(await request('history.record', { sessionId: 's', originSeq: event.seq, offset: 1, cursor })).toMatchObject({ ok: false, error: { code: 'HISTORY_CHANGED' } });
  expect(await request('history.record', { sessionId: 's', originSeq: event.seq, offset: 999999 })).toMatchObject({ ok: false, error: { code: 'INVALID_CURSOR' } });
});
it('reports failed runtime activity as unknown rather than zero', async () => {
  const store = new Store(':memory:'); const runtime = new DemoRuntime();
  Object.assign(runtime, { busy: async () => { throw new Error('unavailable'); } });
  core = new TurnwireCore(store, [runtime], { id: 'test', name: 'test' });
  const snapshot = await core.snapshot();
  expect(snapshot.runtimes[0]).toMatchObject({ busyKnown: false });
  expect(snapshot.runtimes[0]).not.toHaveProperty('busy');
});
