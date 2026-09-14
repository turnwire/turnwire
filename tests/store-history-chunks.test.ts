import { describe, expect, it } from 'vitest';
import { Store } from '../packages/core/src/store.js';
import { HistoryExporter } from '../packages/core/src/history-export.js';
import type { EventData } from '@turnwire/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';

async function collect(store: Store, origin: number, limit = 101) {
  let offset = 0; let cursor: number | undefined; const parts: string[] = [];
  for (;;) {
    const chunk = await store.historyRecordChunk('s', origin, offset, limit, cursor);
    expect(chunk.data.length).toBeLessThanOrEqual(limit);
    parts.push(chunk.data); cursor = chunk.cursor;
    if (chunk.nextOffset === null) return JSON.parse(parts.join(''));
    expect(chunk.nextOffset).toBe(offset + chunk.data.length);
    offset = chunk.nextOffset;
  }
}
const delta = (text: string): EventData => ({ type: 'message.delta', sessionId: 's', messageId: 'm', text });

describe('SQLite history record chunks', () => {
  it('reconstructs full baselines and escaped incremental deltas with UTF16 offsets', async () => {
    const store = new Store(':memory:');
    try {
      const first = store.append(delta('start 😀\\\"\n\u0000\ud800' + '界😀'.repeat(9000)))!;
      for (const text of ['\\\"\n\u0000', '\ud83d', '\ude00', 'fin😀']) store.append(delta(text));
      expect(await collect(store, first.seq)).toEqual(store.historyRecord('s', first.seq));
      const revision = (await store.historyRecordChunk('s', first.seq, 0, 100)).cursor;
      store.append(delta('new'));
      await expect(store.historyRecordChunk('s', first.seq, 100, 100, revision)).rejects.toThrow('changed');
      expect(await collect(store, first.seq, 8193)).toEqual(store.historyRecord('s', first.seq));
    } finally { await store.close(); }
  });

  it('does not use full Node materialization and preserves multi-event records', async () => {
    const store = new Store(':memory:');
    try {
      const first = store.append({ type: 'tool.started', sessionId: 's', callId: 'c', tool: 'read', detail: '😀'.repeat(20000) })!;
      store.append({ type: 'tool.finished', sessionId: 's', callId: 'c', tool: 'read', detail: 'large'.repeat(20000) });
      const expected = store.historyRecord('s', first.seq);
      store.historyRecord = () => { throw new Error('Full materialization forbidden'); };
      expect(await collect(store, first.seq, 32768)).toEqual(expected);
      await expect(store.historyRecordChunk('other', first.seq, 0, 100)).rejects.toThrow('does not belong');
      await expect(store.historyRecordChunk('s', first.seq, 1e9, 100)).rejects.toThrow('exceeds');
      expect(store.cursor()).toBe(2);
    } finally { await store.close(); }
  });

  it('rebuilds its private cache from durable fragments after reopening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turnwire-history-chunks-'));
    const path = join(dir, 'store.sqlite');
    let store = new Store(path);
    try {
      const first = store.append(delta('😀'.repeat(20000)))!;
      store.append(delta('suffix'));
      const original = store.events(0, 100);
      const expected = store.historyRecord('s', first.seq);
      expect(await collect(store, first.seq, 8192)).toEqual(expected);
      await store.close(); store = new Store(path);
      expect(await collect(store, first.seq, 4096)).toEqual(expected);
      expect(store.events(0, 100)).toEqual(original);
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('bounds admission, cancels queued/active reads and restarts after cleanup', async () => {
    const store = new Store(':memory:');
    try {
      const first = store.append(delta('😀'.repeat(10000)))!;
      const controller = new AbortController();
      const firstRead = store.historyRecordChunk('s', first.seq, 0, 100, undefined, controller.signal);
      const queued = Array.from({ length: 7 }, () => store.historyRecordChunk('s', first.seq, 0, 100));
      await expect(store.historyRecordChunk('s', first.seq, 0, 100)).rejects.toMatchObject({ code: 'HISTORY_EXPORT_BUSY' });
      controller.abort();
      await expect(firstRead).rejects.toMatchObject({ code: 'HISTORY_EXPORT_CANCELLED' });
      expect((await Promise.all(queued)).every(chunk => chunk.cursor === first.seq)).toBe(true);
      const read = store.historyRecordChunk('s', first.seq, 0, 100);
      const rejected = expect(read).rejects.toMatchObject({ code: 'HISTORY_EXPORT_CANCELLED' });
      await store.cancelHistoryExports(); await rejected;
      expect((await store.historyRecordChunk('s', first.seq, 0, 100)).cursor).toBe(first.seq);
    } finally { await store.close(); }
    await expect(store.historyRecordChunk('s', 1, 0, 100)).rejects.toMatchObject({ code: 'HISTORY_EXPORT_CLOSED' });
  });

  it('uses bounded fragments with an independent read-only snapshot while daemon writes', async () => {
    const store = new Store(':memory:');
    try {
      const first = store.append(delta('base'))!;
      for (let i = 0; i < 200; i++) store.append(delta('界😀'.repeat(100)));
      expect(Number(store.db.prepare('SELECT MAX(length(body)) AS n FROM history_fragments').get()!.n)).toBeLessThanOrEqual(8192);
      const before = Number(store.db.prepare('SELECT total_changes() AS n').get()!.n);
      let yielded = false;
      const tick = new Promise<void>(resolve => setImmediate(() => { yielded = true; resolve(); }));
      const reading = store.historyRecordChunk('s', first.seq, 0, 100);
      await tick; expect(yielded).toBe(true);
      await reading;
      expect(Number(store.db.prepare('SELECT total_changes() AS n').get()!.n)).toBe(before);
      const concurrent = store.historyRecordChunk('s', first.seq, 0, 100);
      store.append(delta('tail'));
      const chunk = await concurrent;
      expect(chunk.cursor).toBeLessThanOrEqual(store.cursor());
      expect(await collect(store, first.seq, 65536)).toEqual(store.historyRecord('s', first.seq));
    } finally { await store.close(); }
  });

  it('exports from a real standalone bundled artifact without worker sidecars or loaders', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turnwire-export-bundle-'));
    const outfile = join(dir, 'store.mjs');
    try {
      await build({ entryPoints: [resolve('packages/core/src/store.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', keepNames: true });
      const source = `import { Store } from ${JSON.stringify(new URL('file://' + outfile).href)};
        const store = new Store(':memory:');
        try {
          const first = store.append({ type: 'message.delta', sessionId: 's', messageId: 'm', text: '😀' });
          store.append({ type: 'message.delta', sessionId: 's', messageId: 'm', text: '界' });
          const chunk = await store.historyRecordChunk('s', first.seq, 0, 65536);
          if (JSON.parse(chunk.data)[0].data.text !== '😀界') throw new Error('Corrupt bundled export');
        } finally { await store.close(); }`;
      await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', source], { timeout: 10_000 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('times out work and awaits cleanup without transferring the database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turnwire-export-timeout-'));
    const path = join(dir, 'store.sqlite'); const store = new Store(path);
    const exporter = new HistoryExporter(path, 1);
    try {
      const first = store.append(delta('text'))!;
      await expect(exporter.read({ sessionId: 's', originSeq: first.seq, offset: 0, limit: 10 })).rejects.toMatchObject({ code: 'HISTORY_EXPORT_TIMEOUT' });
    } finally { await exporter.close(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains historical baseline semantics and completion replaces delta text', async () => {
    const store = new Store(':memory:');
    try {
      const first = store.append(delta('old'))!;
      store.append(delta('text'));
      await collect(store, first.seq);
      store.append({ type: 'message.completed', sessionId: 's', messageId: 'm', text: 'final 😀' });
      expect(await collect(store, first.seq)).toEqual(store.historyRecord('s', first.seq));
      const full = JSON.stringify(store.historyRecord('s', first.seq));
      const emoji = full.indexOf('😀');
      await expect(store.historyRecordChunk('s', first.seq, emoji, 1)).rejects.toThrow('too small');
      expect((await store.historyRecordChunk('s', first.seq, emoji, 2)).data).toBe('😀');
      expect((await store.historyRecordChunk('s', first.seq, full.length, 10)).data).toBe('');
    } finally { await store.close(); }
  });
});
