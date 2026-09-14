import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@turnwire/core';
import { HistoryBuffer, eventSchema } from '@turnwire/protocol';
import type { EventData, TurnwireEvent } from '@turnwire/protocol';
import { conversation, loadHistory, loadHistoryRecord } from '@turnwire/sdk';
import type { TurnwireClient } from '@turnwire/sdk';

it('shares queued execution order across raw, live/page race, durable paging and full SDK export', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'turnwire-projection-'));
  const path = join(directory, 'state.db'); let store = new Store(path);
  try {
    const raw: TurnwireEvent[] = []; const live = new HistoryBuffer();
    const append = (data: EventData) => { const event = store.append(data)!; raw.push(event); live.apply(event); return event; };
    const user = (messageId: string, text: string, queued = false) => append({ type: 'message.user', sessionId: 's', messageId, text, queued });
    const answer = (messageId: string) => append({ type: 'message.completed', sessionId: 's', messageId, text: messageId });
    user('initial', 'start'); answer('assistant-1');
    const queued = user('queued', 'later', true);
    append({ type: 'tool.started', sessionId: 's', callId: 'tool', tool: 'bash', detail: 'input' });
    answer('assistant-2');
    append({ type: 'tool.finished', sessionId: 's', callId: 'tool', tool: 'bash', detail: 'output', isError: false });
    answer('assistant-3');
    user('removed', 'remove me', true);
    // A full baseline fetched before patches must absorb live updates exactly once.
    live.begin(); const baseline = store.history('s', 100);
    const start = append({ type: 'message.updated', sessionId: 's', messageId: 'queued', queued: false });
    answer('assistant-4');
    const text = 'edited😀'.repeat(20_000); // Force full-record SDK export rather than preview-only coverage.
    append({ type: 'message.updated', sessionId: 's', messageId: 'queued', text });
    append({ type: 'message.updated', sessionId: 's', messageId: 'queued', steer: true });
    append({ type: 'message.updated', sessionId: 's', messageId: 'queued', queued: false });
    append({ type: 'message.removed', sessionId: 's', messageId: 'removed' });
    live.apply(raw.at(-1)!); live.merge(baseline, true);
    const expected = conversation(raw, 's');
    expect(expected.map(m => m.id)).toEqual(['initial', 'assistant-1', 'tool', 'assistant-2', 'assistant-3', 'queued', 'assistant-4']);
    expect(expected.find(m => m.id === 'queued')).toMatchObject({ text, queued: false, steer: true });
    expect(expected.find(m => m.id === 'tool')).toMatchObject({ input: 'input', output: 'output', complete: true });
    expect(conversation(live.events, 's')).toEqual(expected);
    const projected = live.events.find(e => 'messageId' in e.data && e.data.messageId === 'queued')!;
    expect(projected).toMatchObject({ originSeq: queued.seq, displaySeq: start.seq, time: queued.time, data: { type: 'message.user' } });
    expect(eventSchema.parse(projected)).toEqual(projected);
    // Pagination remains stable-origin based even though the queued row now displays near the end.
    const pages: TurnwireEvent[] = []; let before: number | undefined;
    do { const page = store.history('s', 2, before); pages.push(...page.events); before = page.nextBefore ?? undefined; } while (before !== undefined);
    expect(new Set(pages.map(e => e.originSeq)).size).toBe(7);
    expect(conversation(pages, 's').map(m => m.id)).toEqual(expected.map(m => m.id));
    const reload = new HistoryBuffer(); reload.merge(store.history('s', 100), true);
    expect(conversation(reload.events, 's').map(m => m.id)).toEqual(expected.map(m => m.id));
    await store.close(); store = new Store(path);
    const client = {
      async call(method: string, params: { sessionId: string; before?: number; limit?: number; originSeq: number; offset?: number; cursor?: number }) {
        if (method === 'history.page') return store.history(params.sessionId, params.limit ?? 40, params.before);
        if (method === 'history.record') return store.historyRecordChunk(params.sessionId, params.originSeq, params.offset ?? 0, 8192, params.cursor);
        throw new Error(method);
      }, close() {}, subscribe() { return () => {}; },
    } as TurnwireClient;
    const record = await loadHistoryRecord(client, 's', queued.seq);
    expect(record[0]).toMatchObject({ originSeq: queued.seq, displaySeq: start.seq });
    expect(conversation(await loadHistory(client, 's'), 's')).toEqual(expected);
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('validates displaySeq on the event envelope and full record response', async () => {
  const event = { seq: 9, originSeq: 2, displaySeq: 7, time: 'now', data: { type: 'message.user', sessionId: 's', messageId: 'q', text: 'x' } };
  expect(eventSchema.parse(event).displaySeq).toBe(7);
  for (const displaySeq of [-1, 1.5, '7']) expect(eventSchema.safeParse({ ...event, displaySeq }).success).toBe(false);
  for (const displaySeq of [1, 10]) {
    const client = { call: async () => ({ data: JSON.stringify([{ ...event, displaySeq }]), cursor: 9, nextOffset: null }) } as unknown as TurnwireClient;
    await expect(loadHistoryRecord(client, 's', 2)).rejects.toThrow('scope mismatch');
  }
});
