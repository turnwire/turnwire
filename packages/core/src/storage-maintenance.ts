import type { Store } from './store.js';

/** Local explicit maintenance only; caller must hold the ready maintenance lease.
 * Journal, export fragments and receipt IDs are durable data, not disposable caches.
 * Stop the read worker before checkpoint/VACUUM: reads use an independent connection.
 */
export function compactStore(store: Store): void {
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA optimize;');
}
