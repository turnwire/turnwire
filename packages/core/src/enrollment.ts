import { pairingSchema, TurnwireError } from '@turnwire/protocol';
import type { Pairing } from '@turnwire/protocol';
import type { Store } from './store.js';

function denied(): never { throw new TurnwireError('UNAUTHORIZED', 'Device authorization changed or invitation expired'); }
function validInvitation(device: Pairing) {
  if (device.bootstrap && (!device.expiresAt || Date.parse(device.expiresAt) <= Date.now())) denied();
}
function sameIdentity(current: Pairing, authenticated: Pairing) {
  if (current.clientId !== authenticated.clientId || current.hostId !== authenticated.hostId || current.token !== authenticated.token) denied();
}

/** Revalidate authorization after asynchronous crypto, rather than trusting its earlier snapshot. */
export function requireCurrentDevice(store: Store, authenticated: Pairing): Pairing {
  const current = store.devices().find(device => device.clientId === authenticated.clientId);
  if (!current) denied();
  sameIdentity(current, authenticated);
  validInvitation(current);
  if (current.key !== authenticated.key || !!current.bootstrap !== !!authenticated.bootstrap || current.expiresAt !== authenticated.expiresAt) denied();
  return current;
}

/** Caller must hold Core mutation admission. This synchronous CAS is the invitation's linearization point. */
export function enrollDevice(store: Store, authenticated: Pairing, key: string): Pairing {
  if (!/^[a-f0-9]{64}$/.test(key)) denied();
  const row = store.db.prepare('SELECT body FROM devices WHERE id=?').get(authenticated.clientId);
  if (!row) denied();
  const body = String(row.body);
  const current = pairingSchema.parse(JSON.parse(body));
  sameIdentity(current, authenticated);
  validInvitation(authenticated);
  validInvitation(current);
  // SDK offers both invitation and pendingKey on reconnect. A handshake with the installed
  // pendingKey, or another already-authenticated invitation channel proposing that same key,
  // can recover a lost enrollment acknowledgement without another credential mutation.
  if (!current.bootstrap) {
    if (current.key !== key || (!authenticated.bootstrap && authenticated.key !== key)) denied();
    return current;
  }
  if (!authenticated.bootstrap || current.key !== authenticated.key || current.expiresAt !== authenticated.expiresAt) denied();
  const enrolled: Pairing = { ...current, key, bootstrap: false, expiresAt: undefined, pendingKey: undefined };
  // Compare the exact persisted document: key/token/bootstrap/expiry cannot change between
  // the read and write, including through another SQLite connection. Never overwrite a winner.
  const result = store.db.prepare('UPDATE devices SET body=? WHERE id=? AND body=?').run(JSON.stringify(enrolled), current.clientId, body);
  if (Number(result.changes) !== 1) denied();
  return enrolled;
}
