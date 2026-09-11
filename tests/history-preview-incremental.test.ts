import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@turnwire/core';
import type { TurnwireEvent } from '@turnwire/protocol';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

it('bounds huge message/tool previews and every page while preserving full records and journal', () => {
  const store = new Store(':memory:'); cleanup.push(() => store.close());
  // Unicode, quotes and newlines exercise UTF-8 and JSON escaping rather than character counts.
  const huge = '世界😀"\\\n'.repeat(30_000);
  const journal: TurnwireEvent[] = [];
  const origins: number[] = [];
  for (let i = 0; i < 12; i++) {
    const first = store.append(i % 2
      ? { type: 'message.completed', sessionId: 's', messageId: `m${i}`, text: huge }
      : { type: 'tool.started', sessionId: 's', callId: `t${i}`, tool: 'bash', detail: huge })!;
    origins.push(first.seq); journal.push(first);
    if (!(i % 2)) journal.push(store.append({ type: 'tool.finished', sessionId: 's', callId: `t${i}`, tool: 'bash', detail: huge, isError: false })!);
  }
  const seen: number[] = []; let before: number | undefined; let pages = 0;
  do {
    const page = store.history('s', 40, before, true); pages++;
    expect(bytes(page)).toBeLessThanOrEqual(512 * 1024);
    expect(page.events.length).toBeGreaterThan(0);
    for (const event of page.events) {
      expect(bytes(event)).toBeLessThanOrEqual(64 * 1024);
      expect(event).toHaveProperty('truncation.reason', 'transport-preview');
      const full = store.historyRecord('s', event.originSeq ?? event.seq)!.find(record => record.seq === event.seq)!;
      expect(event).toHaveProperty('truncation.originalBytes', bytes(full));
      seen.push(event.seq);
    }
    for (const event of page.events.filter(event => event.data.type === 'tool.started')) {
      expect(page.events.some(other => other.data.type === 'tool.finished' && other.data.callId === (event.data as { callId: string }).callId)).toBe(true);
    }
    if (!page.hasMore) { expect(page.nextBefore).toBeNull(); break; }
    expect(page.nextBefore).toBeLessThan(before ?? Number.MAX_SAFE_INTEGER);
    before = page.nextBefore!;
    expect(pages).toBeLessThan(20);
  } while (true);
  expect(pages).toBeGreaterThan(1);
  expect(seen.sort((a, b) => a - b)).toEqual(journal.map(event => event.seq));
  for (const origin of origins) {
    const record = store.historyRecord('s', origin)!;
    for (const event of record) {
      expect('text' in event.data ? event.data.text : 'detail' in event.data ? event.data.detail : undefined).toBe(huge);
      expect(event).not.toHaveProperty('truncation');
    }
  }
  expect(store.events(0, 100)).toEqual(journal);
  expect(store.history('s', 1).events[0]!.data).toMatchObject({ text: huge });
});

it('persists incremental deltas across restart without rewriting the base history body', () => {
  const dir = mkdtempSync(join(tmpdir(), 'turnwire-incremental-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.db'); let store = new Store(path); cleanup.push(() => store.close());
  const first = store.append({ type: 'message.delta', sessionId: 's', messageId: 'm', text: 'start:' }, 'start')!;
  const base = () => store.db.prepare('SELECT body FROM history WHERE first_seq=?').get(first.seq)!.body;
  const initial = base(); const chunks = Array.from({ length: 128 }, (_, i) => `${i}😀,`);
  for (let i = 0; i < chunks.length; i++) {
    store.append({ type: 'message.delta', sessionId: 's', messageId: 'm', text: chunks[i]! }, `delta-${i}`);
    expect(base()).toBe(initial);
  }
  const expected = 'start:' + chunks.join('');
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM history_deltas').get()!.n).toBe(128);
  const revision = store.cursor();
  store.close(); store = new Store(path);
  expect(base()).toBe(initial);
  expect(store.historyRecord('s', first.seq)).toMatchObject([{ seq: revision, originSeq: first.seq, data: { text: expected } }]);
  expect(store.history('s', 40).events).toEqual(store.historyRecord('s', first.seq));
  expect(store.append({ type: 'message.delta', sessionId: 's', messageId: 'm', text: chunks[0]! }, 'delta-0')).toBeUndefined();
  expect(store.cursor()).toBe(revision);
  store.append({ type: 'message.delta', sessionId: 's', messageId: 'm', text: 'tail' });
  expect(base()).toBe(initial);
  expect(store.historyRecord('s', first.seq)![0]!.data).toMatchObject({ text: expected + 'tail' });
  store.append({ type: 'message.completed', sessionId: 's', messageId: 'm', text: expected + 'tail!' });
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM history_deltas').get()!.n).toBe(0);
  store.close(); store = new Store(path);
  expect(store.historyRecord('s', first.seq)![0]!.data).toMatchObject({ type: 'message.completed', text: expected + 'tail!' });
  expect(store.events(0, 1000)).toHaveLength(131);
});

it('rolls back journal insertion when incremental projection fails', () => {
  const store = new Store(':memory:'); cleanup.push(() => store.close());
  const first = store.append({ type: 'message.delta', sessionId: 's', messageId: 'm', text: 'base' })!;
  store.db.exec("CREATE TRIGGER reject_delta BEFORE INSERT ON history_deltas BEGIN SELECT RAISE(ABORT, 'test projection failure'); END");
  expect(() => store.append({ type: 'message.delta', sessionId: 's', messageId: 'm', text: 'lost' }, 'retry')).toThrow('test projection failure');
  expect(store.cursor()).toBe(first.seq);
  expect(store.historyRecord('s', first.seq)![0]!.data).toMatchObject({ text: 'base' });
  store.db.exec('DROP TRIGGER reject_delta');
  expect(store.append({ type: 'message.delta', sessionId: 's', messageId: 'm', text: 'kept' }, 'retry')).toBeDefined();
  expect(store.historyRecord('s', first.seq)![0]!.data).toMatchObject({ text: 'basekept' });
});
