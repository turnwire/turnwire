import { expect, it } from 'vitest';
import { Store } from '@turnwire/core';
import { compactStore } from '../packages/core/src/storage-maintenance.js';

it('compacts derived caches without deleting event cursors, authorization, or idempotency receipts', () => {
  const store = new Store(':memory:');
  try {
    store.setSetting('maintenance-lease', { token: 'test-lease' });
    store.reserveRequest('original-request', 'original-fingerprint');
    store.finishRequest('original-request', { v: 1, id: 'original-request', ok: true, result: { done: true } });
    store.append({ type: 'message.completed', sessionId: 's', messageId: 'm', text: 'preserved' });
    const events = store.events(0, 100), cursor = store.cursor(), receipt = store.request('original-request');
    store.db.prepare('INSERT INTO history_export VALUES(?,?,?)').run('cache', 1, 2);
    store.db.prepare('INSERT INTO history_export_chunks VALUES(?,?,?)').run('cache', 0, '[]');
    compactStore(store);
    expect(store.events(0, 100)).toEqual(events); expect(store.cursor()).toBe(cursor);
    expect(store.request('original-request')).toEqual(receipt);
    expect(store.setting('maintenance-lease')).toEqual({ token: 'test-lease' });
    expect(store.db.prepare('SELECT count(*) AS n FROM history_export').get()?.n).toBe(0);
    expect(store.db.prepare('SELECT count(*) AS n FROM history_export_chunks').get()?.n).toBe(0);
  } finally { store.close(); }
});
