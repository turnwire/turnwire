import { expect, it } from 'vitest';
import { Store } from '@turnwire/core';
import { compactStore } from '../packages/core/src/storage-maintenance.js';

it('compacts without deleting durable export fragments, cursors, authorization or receipts', async () => {
  const store = new Store(':memory:');
  try {
    store.setSetting('maintenance-lease', { token: 'test-lease' });
    store.reserveRequest('original-request', 'original-fingerprint');
    store.finishRequest('original-request', { v: 1, id: 'original-request', ok: true, result: { done: true } });
    const first = store.append({ type: 'message.completed', sessionId: 's', messageId: 'm', text: 'preserved' })!;
    const events = store.events(0, 100), cursor = store.cursor(), receipt = store.request('original-request');
    const chunk = await store.historyRecordChunk('s', first.seq, 0, 65536);
    await store.cancelHistoryExports();
    compactStore(store);
    expect(store.events(0, 100)).toEqual(events); expect(store.cursor()).toBe(cursor);
    expect(store.request('original-request')).toEqual(receipt);
    expect(store.setting('maintenance-lease')).toEqual({ token: 'test-lease' });
    expect(await store.historyRecordChunk('s', first.seq, 0, 65536)).toEqual(chunk);
    expect(Number(store.db.prepare('SELECT count(*) AS n FROM history_fragments').get()?.n)).toBeGreaterThan(0);
  } finally { await store.close(); }
});
