import type { Store } from './store.js';

/** Local explicit maintenance only; caller must hold the ready maintenance lease.
 * Journal and receipt IDs are deliberately retained indefinitely: silently deleting either
 * would invalidate event cursors or permit an old mutation to be submitted twice.
 */
export function compactStore(store: Store): void {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.exec('DELETE FROM history_export_chunks; DELETE FROM history_export;');
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA optimize;');
}
