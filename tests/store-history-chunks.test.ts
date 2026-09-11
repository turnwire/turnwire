import { describe, expect, it } from 'vitest';
import { Store } from '../packages/core/src/store.js';
import type { EventData } from '@turnwire/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function collect(store: Store, origin: number, limit = 101) {
  let offset = 0; let cursor: number | undefined; const parts: string[] = [];
  for (;;) {
    const chunk = store.historyRecordChunk('s', origin, offset, limit, cursor);
    expect(chunk.data.length).toBeLessThanOrEqual(limit);
    parts.push(chunk.data); cursor = chunk.cursor;
    if (chunk.nextOffset === null) return JSON.parse(parts.join(''));
    expect(chunk.nextOffset).toBe(offset + chunk.data.length);
    offset = chunk.nextOffset;
  }
}
const delta = (text: string): EventData => ({ type: 'message.delta', sessionId: 's', messageId: 'm', text });

describe('SQLite history record chunks', () => {
  it('reconstructs full baselines and escaped incremental deltas with UTF16 offsets', () => {
    const store = new Store(':memory:');
    try {
      const first = store.append(delta('start 😀\\\"\n\u0000\ud800' + '界😀'.repeat(9000)))!;
      for (const text of ['\\\"\n\u0000', '\ud83d', '\ude00', 'fin😀']) store.append(delta(text));
      expect(collect(store, first.seq)).toEqual(store.historyRecord('s', first.seq));
      const revision = store.historyRecordChunk('s', first.seq, 0, 100).cursor;
      store.append(delta('new'));
      expect(() => store.historyRecordChunk('s', first.seq, 100, 100, revision)).toThrow('changed');
      expect(collect(store, first.seq, 8193)).toEqual(store.historyRecord('s', first.seq));
    } finally { store.close(); }
  });

  it('does not use full Node materialization and preserves multi-event records', () => {
    const store = new Store(':memory:');
    try {
      const first = store.append({ type: 'tool.started', sessionId: 's', callId: 'c', tool: 'read', detail: '😀'.repeat(20000) })!;
      store.append({ type: 'tool.finished', sessionId: 's', callId: 'c', tool: 'read', detail: 'large'.repeat(20000) });
      const expected = store.historyRecord('s', first.seq);
      store.historyRecord = () => { throw new Error('Full materialization forbidden'); };
      expect(collect(store, first.seq, 32768)).toEqual(expected);
      expect(() => store.historyRecordChunk('other', first.seq, 0, 100)).toThrow('does not belong');
      expect(() => store.historyRecordChunk('s', first.seq, 1e9, 100)).toThrow('exceeds');
      expect(store.cursor()).toBe(2);
    } finally { store.close(); }
  });

  it('preserves original storage and reuses persisted cache after reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turnwire-history-chunks-'));
    const path = join(dir, 'store.sqlite');
    let store = new Store(path);
    try {
      const first = store.append(delta('😀'.repeat(20000)))!;
      store.append(delta('suffix'));
      const original = store.events(0, 100);
      const expected = store.historyRecord('s', first.seq);
      expect(collect(store, first.seq, 8192)).toEqual(expected);
      store.close(); store = new Store(path);
      expect(collect(store, first.seq, 4096)).toEqual(expected);
      expect(store.events(0, 100)).toEqual(original);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains historical baseline semantics and completion replaces delta text', () => {
    const store = new Store(':memory:');
    try {
      const first = store.append(delta('old'))!;
      store.append(delta('text'));
      collect(store, first.seq);
      store.append({ type: 'message.completed', sessionId: 's', messageId: 'm', text: 'final 😀' });
      expect(collect(store, first.seq)).toEqual(store.historyRecord('s', first.seq));
      const full = JSON.stringify(store.historyRecord('s', first.seq));
      const emoji = full.indexOf('😀');
      expect(() => store.historyRecordChunk('s', first.seq, emoji, 1)).toThrow('too small');
      expect(store.historyRecordChunk('s', first.seq, emoji, 2).data).toBe('😀');
      expect(store.historyRecordChunk('s', first.seq, full.length, 10).data).toBe('');
    } finally { store.close(); }
  });
});
