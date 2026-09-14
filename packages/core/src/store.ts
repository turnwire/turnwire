import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryExporter } from './history-export.js';
import { eventSessionId, historyKey, reduceHistory, projectHistoryEvent, HISTORY_PAGE_BYTES, TurnwireError, sessionSchema, pairingSchema } from '@turnwire/protocol';
import type { HistoryPage } from '@turnwire/protocol';
import type { ImageAttachment, Approval, EventData, TurnwireEvent, Pairing, RpcResponse, Session } from '@turnwire/protocol';

// Final storage format only. A different or unversioned format requires a separate
// database, never an in-place migration or a replay of the event journal.
const APPLICATION_ID = 0x54575245; // TWRE
const STORAGE_VERSION = 2;
const SCHEMA = `
  CREATE TABLE sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE approvals (id TEXT PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, time TEXT NOT NULL, body TEXT NOT NULL, source TEXT UNIQUE);
  CREATE INDEX event_session ON events(session_id, seq);
  CREATE TABLE history (session_id TEXT NOT NULL, key TEXT PRIMARY KEY, first_seq INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE INDEX history_session ON history(session_id, first_seq);
  CREATE TABLE history_deltas (key TEXT NOT NULL, seq INTEGER NOT NULL PRIMARY KEY);
  CREATE INDEX history_delta_key ON history_deltas(key, seq);
  CREATE TABLE history_export_state (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, prefix TEXT, identity TEXT NOT NULL);
  CREATE TABLE history_fragments (key TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(key,kind,seq,part));
  CREATE TABLE requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT);
  CREATE TABLE settings (key TEXT PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE devices (id TEXT PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE inbox (position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
`;
const schemaSql = (sql: string) => sql.trim().replace(/\s+/g, ' ').toLowerCase();
const expectedSchema = SCHEMA.split(';').map(schemaSql).filter(Boolean).sort();
function unsupportedStorage(reason: string): TurnwireError {
  return new TurnwireError('UNSUPPORTED_STORAGE', `Unsupported storage: ${reason}. No migration is available; use a separate empty database.`);
}
/** Read-only validation must precede chmod, WAL, DDL, and all persistent writes. */
function validateStorage(db: DatabaseSync): 'empty' | 'current' {
  try {
    const applicationId = Number(db.prepare('PRAGMA application_id').get()!.application_id);
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    const objects = db.prepare("SELECT name,sql FROM sqlite_schema").all();
    if (!objects.length && applicationId === 0 && version === 0) return 'empty';
    if (applicationId !== APPLICATION_ID || version !== STORAGE_VERSION) {
      throw unsupportedStorage(`application_id=${applicationId}, user_version=${version}; expected ${APPLICATION_ID}/${STORAGE_VERSION}`);
    }
    const actualSchema = objects.filter(row => !String(row.name).startsWith('sqlite_')).map(row => schemaSql(String(row.sql))).sort();
    if (JSON.stringify(actualSchema) !== JSON.stringify(expectedSchema)) throw unsupportedStorage('malformed final schema');
    for (const row of db.prepare('SELECT body FROM sessions').iterate()) sessionSchema.parse(JSON.parse(String(row.body)));
    for (const row of db.prepare('SELECT body FROM devices').iterate()) pairingSchema.parse(JSON.parse(String(row.body)));
    return 'current';
  } catch (error) {
    if (error instanceof TurnwireError && error.code === 'UNSUPPORTED_STORAGE') throw error;
    throw unsupportedStorage('invalid database or persisted session/device record');
  }
}

/** Validate an existing database without creating it, changing modes, or opening a writer. */
export function validateStorageFile(path: string): 'empty' | 'current' {
  let probe: DatabaseSync | undefined;
  try { probe = new DatabaseSync(path, { readOnly: true }); return validateStorage(probe); }
  catch (error) { throw error instanceof TurnwireError ? error : unsupportedStorage('cannot read database'); }
  finally { probe?.close(); }
}

export class Store {
  readonly db: DatabaseSync;
  private closed = false;
  private readonly temporaryDirectory?: string;
  private readonly path: string;
  private exporter?: HistoryExporter;
  private exportGeneration = 0;
  private retiringExporter?: HistoryExporter;
  private exportCleanup: Promise<Error | undefined> = Promise.resolve(undefined);
  private exportCleanupRunning = false;
  private closeAttempt?: Promise<void>;
  constructor(path: string) {
    // Ephemeral stores share the exact disk-backed format/worker path. Never copy a
    // live in-memory database or maintain a separate synchronous export implementation.
    if (path === ':memory:') {
      this.temporaryDirectory = mkdtempSync(join(tmpdir(), 'turnwire-store-'));
      path = join(this.temporaryDirectory, 'store.sqlite');
    }
    this.path = resolve(path);
    if (path !== ':memory:' && existsSync(path)) validateStorageFile(path);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      const format = validateStorage(this.db);
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
      if (format === 'empty') {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.exec(`${SCHEMA} PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${STORAGE_VERSION}; COMMIT`);
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
    } catch (error) {
      // Construction has no asynchronous exporter owner yet.
      try {
        this.db.close();
        if (this.temporaryDirectory) rmSync(this.temporaryDirectory, { recursive: true, force: true });
      } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Store initialization and cleanup failed'); }
      throw error;
    }
  }
  sessions(): Session[] { return this.db.prepare('SELECT body FROM sessions').all().map(row => sessionSchema.parse(JSON.parse(row.body as string))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  session(id: string): Session | undefined { const row = this.db.prepare('SELECT body FROM sessions WHERE id=?').get(id); return row ? sessionSchema.parse(JSON.parse(row.body as string)) : undefined; }
  approvals(): Approval[] { return this.db.prepare('SELECT body FROM approvals').all().map(row => JSON.parse(row.body as string) as Approval); }
  approval(id: string): Approval | undefined { const row = this.db.prepare('SELECT body FROM approvals WHERE id=?').get(id); return row ? JSON.parse(row.body as string) as Approval : undefined; }
  inbox(limit: number, status: 'pending' | 'all', before = Number.MAX_SAFE_INTEGER) {
    const rows = this.db.prepare("SELECT position,body FROM inbox WHERE position<? AND (?='all' OR json_extract(body,'$.status')='pending') ORDER BY position DESC LIMIT ?").all(before, status, limit + 1);
    const items = rows.slice(0, limit).map(row => { const approval = JSON.parse(String(row.body)) as Approval; return { position: Number(row.position), approval, sessionTitle: this.session(approval.sessionId)?.title ?? approval.sessionId }; });
    return { items, nextBefore: rows.length > limit ? items.at(-1)!.position : null, cursor: this.cursor() };
  }
  cursor(): number { return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get()!.seq); }
  events(after: number, limit: number, sessionId?: string, preview = false): TurnwireEvent[] {
    const rows = sessionId
      ? this.db.prepare('SELECT seq,time,body FROM events WHERE seq>? AND session_id=? ORDER BY seq LIMIT ?').iterate(after, sessionId, limit)
      : this.db.prepare('SELECT seq,time,body FROM events WHERE seq>? ORDER BY seq LIMIT ?').iterate(after, limit);
    const events: TurnwireEvent[] = []; let bytes = 0;
    for (const row of rows) {
      const full = { seq: Number(row.seq), time: String(row.time), data: JSON.parse(row.body as string) as EventData };
      const event = preview ? projectHistoryEvent(full) : full;
      const size = preview ? Buffer.byteLength(JSON.stringify(event)) : 0;
      if (events.length && bytes + size > HISTORY_PAGE_BYTES) break;
      events.push(event); bytes += size;
    }
    return events;
  }
  /** Only durable user-event refs authorize native reads; never accept raw runtime IDs or URLs. */
  imageAttachment(sessionId: string, attachmentId: string): ImageAttachment | undefined {
    const row = this.db.prepare("SELECT image.value AS image FROM events, json_each(events.body, '$.images') AS image WHERE events.session_id=? AND json_extract(events.body,'$.type')='message.user' AND json_extract(image.value,'$.attachmentId')=? LIMIT 1").get(sessionId, attachmentId);
    return row ? JSON.parse(String(row.image)) as ImageAttachment : undefined;
  }
  userImages(sessionId: string, messageId: string): ImageAttachment[] {
    const row = this.db.prepare("SELECT body FROM events WHERE session_id=? AND json_extract(body,'$.type')='message.user' AND json_extract(body,'$.messageId')=? LIMIT 1").get(sessionId, messageId);
    return row ? (JSON.parse(String(row.body)).images ?? []) : [];
  }
  private project(event: TurnwireEvent) {
    const key = historyKey(event); if (!key) return;

    const sessionId = eventSessionId(event.data);
    const row = event.data.type === 'message.delta'
      ? this.db.prepare('SELECT first_seq FROM history WHERE key=?').get(key)
      : this.db.prepare('SELECT first_seq,body FROM history WHERE key=?').get(key);
    // Deltas reference the immutable journal, in the same transaction. No repeated full-text
    // read/serialize/write per token, and no asynchronous buffer that can lose data on restart.
    if (event.data.type === 'message.delta' && row) {
      this.db.prepare('INSERT OR IGNORE INTO history_deltas VALUES(?,?)').run(key, event.seq);
      this.fragments(key, 'text', event.seq, JSON.stringify(event.data.text).slice(1, -1));
      const identity = JSON.parse(String(this.db.prepare('SELECT identity FROM history_export_state WHERE key=?').get(key)!.identity));
      const { text: _text, ...data } = event.data;
      const prefix = `[{"seq":${event.seq},"time":${JSON.stringify(identity.time)},"originSeq":${identity.originSeq},${identity.displaySeq === undefined ? '' : `"displaySeq":${identity.displaySeq},`}"data":${JSON.stringify(data).slice(0, -1)},"text":"`;
      this.db.prepare('UPDATE history_export_state SET revision=?,prefix=? WHERE key=?').run(event.seq, prefix, key);
      return;
    }
    // Completed messages replace the accumulated text; only their baseline identity is needed.
    const existing = row ? (event.data.type === 'message.completed' ? JSON.parse(String(row.body)) as TurnwireEvent[] : this.materialize(key, String(row.body))) : [];
    const events = reduceHistory(existing, event);
    this.db.prepare('DELETE FROM history_deltas WHERE key=?').run(key);
    const body = JSON.stringify(events);
    this.db.prepare('INSERT OR REPLACE INTO history VALUES(?,?,?,?)').run(sessionId!, key, row ? Number(row.first_seq) : event.seq, body);
    this.db.prepare('DELETE FROM history_fragments WHERE key=?').run(key);
    this.fragments(key, 'baseline', 0, body);
    const first = events[0];
    if (first && 'text' in first.data) this.fragments(key, 'text', 0, JSON.stringify(first.data.text).slice(1, -1));
    this.db.prepare('INSERT OR REPLACE INTO history_export_state VALUES(?,?,NULL,?)').run(key, Math.max(...events.map(e => e.seq)), JSON.stringify({ time: first?.time ?? event.time, originSeq: first?.originSeq ?? first?.seq ?? event.seq, ...(first?.displaySeq === undefined ? {} : { displaySeq: first.displaySeq }) }));
  }
  private fragments(key: string, kind: string, seq: number, body: string) {
    const insert = this.db.prepare('INSERT INTO history_fragments VALUES(?,?,?,?,?)');
    for (let start = 0, part = 0; start < body.length; part++) {
      let end = Math.min(start + 8192, body.length);
      if (end < body.length && /[\uD800-\uDBFF]/.test(body.charAt(end - 1))) end--;
      insert.run(key, kind, seq, part, body.slice(start, end)); start = end;
    }
  }
  private materialize(key: string, body: string): TurnwireEvent[] {
    let events = JSON.parse(body) as TurnwireEvent[];
    const rows = this.db.prepare('SELECT e.seq,e.time,e.body FROM history_deltas d JOIN events e ON e.seq=d.seq WHERE d.key=? ORDER BY e.seq').all(key);
    // Join the accumulated text once rather than repeatedly concatenating every prefix.
    if (rows.length) {
      const first = events[0]; const last = rows.at(-1)!;
      const data = JSON.parse(String(last.body)) as EventData;
      if (data.type === 'message.delta') {
        const text = (first && 'text' in first.data ? first.data.text : '') + rows.map(row => (JSON.parse(String(row.body)) as { text: string }).text).join('');
        events = [{ seq: Number(last.seq), time: first?.time ?? String(last.time), originSeq: first?.originSeq ?? first?.seq ?? Number(rows[0]!.seq), ...(first?.displaySeq === undefined ? {} : { displaySeq: first.displaySeq }), data: { ...data, text } }];
      }
    }
    return events;
  }
  /** Full durable entity for chunked export. Callers must pin/check its revision across chunks. */
  historyRecord(sessionId: string, originSeq: number): TurnwireEvent[] | undefined {
    const row = this.db.prepare('SELECT key,body FROM history WHERE session_id=? AND first_seq=?').get(sessionId, originSeq);
    return row ? this.materialize(String(row.key), String(row.body)) : undefined;
  }
  /** Isolated, read-only source connection; cache writes never acquire the daemon writer. */
  async historyRecordChunk(sessionId: string, originSeq: number, offset: number, limit: number, cursor?: number, signal?: AbortSignal) {
    if (this.closed) throw new TurnwireError('HISTORY_EXPORT_CLOSED', 'Store is closed');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 65_536) throw new TurnwireError('INVALID_REQUEST', 'Invalid history chunk range');
    if (!this.exporter) {
      const generation = this.exportGeneration;
      const cleanupError = await this.exportCleanup;
      if (cleanupError) throw new TurnwireError('HISTORY_EXPORT_FAILED', 'History export cleanup failed');
      if (generation !== this.exportGeneration) throw new TurnwireError('HISTORY_EXPORT_CANCELLED', 'History export cancelled');
      if (this.closed) throw new TurnwireError('HISTORY_EXPORT_CLOSED', 'Store is closed');
      this.exporter ??= new HistoryExporter(this.path);
    }
    return this.exporter.read({ sessionId, originSeq, offset, limit, cursor }, signal);
  }
  /** Await before maintenance takes an exclusive lock; subsequent reads start a fresh worker. */
  async cancelHistoryExports() {
    this.exportGeneration++;
    if (!this.exportCleanupRunning) {
      this.retiringExporter ??= this.exporter;
      this.exporter = undefined;
      this.exportCleanupRunning = true;
      this.exportCleanup = Promise.resolve().then(async () => {
        try {
          await this.retiringExporter?.close();
          this.retiringExporter = undefined;
          return undefined;
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error));
        } finally { this.exportCleanupRunning = false; }
      });
    }
    const error = await this.exportCleanup;
    if (error) throw error;
  }
  history(sessionId: string, limit: number, before = Number.MAX_SAFE_INTEGER, preview = false): HistoryPage {
    const rows = this.db.prepare('SELECT key,first_seq FROM history WHERE session_id=? AND first_seq<? ORDER BY first_seq DESC LIMIT ?').all(sessionId, before, limit + 1);
    const selected: { firstSeq: number; events: TurnwireEvent[] }[] = []; let bytes = 1024;
    for (const row of rows) {
      if (selected.length === limit) break;
      const body = this.db.prepare('SELECT body FROM history WHERE key=?').get(String(row.key))!;
      const full = this.materialize(String(row.key), String(body.body));
      const events = preview ? full.map(projectHistoryEvent) : full;
      const size = Buffer.byteLength(JSON.stringify(events));
      if (selected.length && bytes + size > HISTORY_PAGE_BYTES) break;
      selected.push({ firstSeq: Number(row.first_seq), events }); bytes += size;
    }
    const hasMore = rows.length > selected.length;
    const nextBefore = hasMore ? selected.at(-1)!.firstSeq : null;
    return { events: selected.reverse().flatMap(row => row.events), cursor: this.cursor(), hasMore, nextBefore };
  }
  append(data: EventData, source?: string, settings?: Record<string, unknown>): TurnwireEvent | undefined {
    const sessionId = eventSessionId(data) ?? null;
    const time = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('INSERT OR IGNORE INTO events(session_id,time,body,source) VALUES(?,?,?,?) RETURNING seq').get(sessionId, time, JSON.stringify(data), source ?? null);
      if (!row) { this.db.exec('COMMIT'); return undefined; }
      if ('session' in data) this.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?)').run(data.session.id, JSON.stringify(data.session));
      if ('approval' in data) {
        this.db.prepare('INSERT OR REPLACE INTO approvals VALUES(?,?)').run(data.approval.id, JSON.stringify(data.approval));
        this.db.prepare('INSERT INTO inbox(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(data.approval.id, JSON.stringify(data.approval));
      }
      const event = { seq: Number(row.seq), time, data }; this.project(event);
      // Domain intents and their public session identity become durable together.
      if (settings) for (const [key, value] of Object.entries(settings)) this.setSetting(key, value);
      this.db.exec('COMMIT');
      return event;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  request(id: string): { fingerprint: string; result?: RpcResponse } | undefined {
    const row = this.db.prepare('SELECT fingerprint,result FROM requests WHERE id=?').get(id);
    return row ? { fingerprint: String(row.fingerprint), ...(row.result ? { result: JSON.parse(String(row.result)) as RpcResponse } : {}) } : undefined;
  }
  reserveRequest(id: string, fingerprint: string) { this.db.prepare('INSERT INTO requests VALUES(?,?,NULL)').run(id, fingerprint); }
  finishRequest(id: string, result: RpcResponse) { this.db.prepare('UPDATE requests SET result=? WHERE id=?').run(JSON.stringify(result), id); }
  setting<T>(key: string): T | undefined { const row = this.db.prepare('SELECT body FROM settings WHERE key=?').get(key); return row ? JSON.parse(String(row.body)) as T : undefined; }
  setSetting(key: string, value: unknown) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, JSON.stringify(value)); }
  devices(): Pairing[] { return this.db.prepare('SELECT body FROM devices').all().map(row => pairingSchema.parse(JSON.parse(String(row.body)))); }
  addDevice(pairing: Pairing) { this.db.prepare('INSERT INTO devices VALUES(?,?)').run(pairing.clientId, JSON.stringify(pairing)); }
  updateDevice(pairing: Pairing) { this.db.prepare('UPDATE devices SET body=? WHERE id=?').run(JSON.stringify(pairing), pairing.clientId); }
  removeDevice(id: string) { this.db.prepare('DELETE FROM devices WHERE id=?').run(id); }
  /** Concurrent closes share an attempt; failed resource release can be retried. */
  close(): Promise<void> {
    if (this.closeAttempt) return this.closeAttempt;
    if (!this.closed) { this.db.close(); this.closed = true; }
    const attempt = this.cancelHistoryExports().then(() => {
      if (this.temporaryDirectory) rmSync(this.temporaryDirectory, { recursive: true, force: true });
    });
    this.closeAttempt = attempt;
    // Observe asynchronous disposal without changing the rejected promise returned
    // to callers. Retain resource ownership so a later close retries.
    void attempt.catch(() => { if (this.closeAttempt === attempt) this.closeAttempt = undefined; });
    return attempt;
  }
}
