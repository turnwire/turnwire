import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { eventSessionId, historyKey, reduceHistory, projectHistoryEvent, HISTORY_PAGE_BYTES, TurnwireError } from '@turnwire/protocol';
import type { HistoryPage } from '@turnwire/protocol';
import type { ImageAttachment, Approval, EventData, TurnwireEvent, Pairing, RpcResponse, Session } from '@turnwire/protocol';

export class Store {
  readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, time TEXT NOT NULL, body TEXT NOT NULL, source TEXT UNIQUE);
      CREATE INDEX IF NOT EXISTS event_session ON events(session_id, seq);
      CREATE TABLE IF NOT EXISTS history (session_id TEXT NOT NULL, key TEXT PRIMARY KEY, first_seq INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS history_session ON history(session_id, first_seq);
      CREATE TABLE IF NOT EXISTS history_deltas (key TEXT NOT NULL, seq INTEGER NOT NULL PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS history_delta_key ON history_deltas(key, seq);
      CREATE TABLE IF NOT EXISTS history_export (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, units INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history_export_chunks (key TEXT NOT NULL, start INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(key,start));
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      INSERT OR IGNORE INTO inbox(id,body) SELECT id,body FROM approvals ORDER BY json_extract(body,'$.createdAt');
    `);
    // Legacy consent was transient. Never reconstruct it from old autoApprove journal events.
    // Materialize the safe default in the durable session row, and keep archived sessions off.
    this.db.exec(`UPDATE sessions SET body=json_set(body,'$.autoApprove',json('false'))
      WHERE json_type(body,'$.autoApprove') IS NULL OR json_extract(body,'$.archived')=1`);
    // One-time, transactional projection migration. Existing event journals stay intact.
    if (!this.setting<boolean>('history-projection-v2')) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        let after = 0;
        while (true) { const page = this.events(after, 1000); for (const event of page) this.project(event); if (page.length < 1000) break; after = page.at(-1)!.seq; }
        this.setSetting('history-projection-v2', true); this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }
  sessions(): Session[] { return this.db.prepare('SELECT body FROM sessions').all().map(row => JSON.parse(row.body as string) as Session).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  session(id: string): Session | undefined { const row = this.db.prepare('SELECT body FROM sessions WHERE id=?').get(id); return row ? JSON.parse(row.body as string) as Session : undefined; }
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
    this.db.prepare('DELETE FROM history_export_chunks WHERE key=?').run(key);
    this.db.prepare('DELETE FROM history_export WHERE key=?').run(key);
    const sessionId = eventSessionId(event.data);
    const row = event.data.type === 'message.delta'
      ? this.db.prepare('SELECT first_seq FROM history WHERE key=?').get(key)
      : this.db.prepare('SELECT first_seq,body FROM history WHERE key=?').get(key);
    // Deltas reference the immutable journal, in the same transaction. No repeated full-text
    // read/serialize/write per token, and no asynchronous buffer that can lose data on restart.
    if (event.data.type === 'message.delta' && row) {
      this.db.prepare('INSERT OR IGNORE INTO history_deltas VALUES(?,?)').run(key, event.seq);
      return;
    }
    // Completed messages replace the accumulated text; only their baseline identity is needed.
    const existing = row ? (event.data.type === 'message.completed' ? JSON.parse(String(row.body)) as TurnwireEvent[] : this.materialize(key, String(row.body))) : [];
    const events = reduceHistory(existing, event);
    this.db.prepare('DELETE FROM history_deltas WHERE key=?').run(key);
    this.db.prepare('INSERT OR REPLACE INTO history VALUES(?,?,?,?)').run(sessionId!, key, row ? Number(row.first_seq) : event.seq, JSON.stringify(events));
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
        events = [{ seq: Number(last.seq), time: first?.time ?? String(last.time), originSeq: first?.originSeq ?? first?.seq ?? Number(rows[0]!.seq), data: { ...data, text } }];
      }
    }
    return events;
  }
  /** Full durable entity for chunked export. Callers must pin/check its revision across chunks. */
  historyRecord(sessionId: string, originSeq: number): TurnwireEvent[] | undefined {
    const row = this.db.prepare('SELECT key,body FROM history WHERE session_id=? AND first_seq=?').get(sessionId, originSeq);
    return row ? this.materialize(String(row.key), String(row.body)) : undefined;
  }
  /** Export without transferring a complete entity from SQLite into Node.
   * SQLite still materializes JSON/concatenation internally: this is a Node allocation bound,
   * not a bound on SQLite's working memory. The rebuild is synchronous and proportional to
   * entity size, once per revision. The journal and projection remain the source of truth.
   */
  historyRecordChunk(sessionId: string, originSeq: number, offset: number, limit: number, cursor?: number): { data: string; cursor: number; nextOffset: number | null } {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 65_536) throw new TurnwireError('INVALID_REQUEST', 'Invalid history chunk range');
    const row = this.db.prepare(`SELECT h.key, COALESCE((SELECT MAX(seq) FROM history_deltas WHERE key=h.key),
      (SELECT MAX(json_extract(value,'$.seq')) FROM json_each(h.body))) AS revision
      FROM history h WHERE session_id=? AND first_seq=?`).get(sessionId, originSeq);
    if (!row || row.revision === null) throw new TurnwireError('HISTORY_NOT_FOUND', 'History record does not belong to this session');
    const key = String(row.key); const revision = Number(row.revision);
    if (cursor !== undefined && cursor !== revision) throw new TurnwireError('HISTORY_CHANGED', 'History record changed while being read; restart from offset zero');
    let cached = this.db.prepare('SELECT units FROM history_export WHERE key=? AND revision=?').get(key, revision);
    if (!cached) {
      // Keep the giant serialized value inside SQLite. JSON string fragments are concatenated
      // *escaped*, so NUL, backslashes and lone/split surrogate escapes survive exactly.
      this.db.exec('SAVEPOINT history_export_build');
      try {
        this.db.exec('CREATE TEMP TABLE IF NOT EXISTS history_export_build (body TEXT NOT NULL); DELETE FROM history_export_build');
        this.db.prepare(`INSERT INTO history_export_build(body)
          SELECT CASE WHEN EXISTS(SELECT 1 FROM history_deltas WHERE key=h.key) THEN
            '[{"seq":' || e.seq || ',"time":' || COALESCE(h.body -> '$[0].time', json_quote(e.time)) ||
            ',"originSeq":' || COALESCE(h.body -> '$[0].originSeq', h.body -> '$[0].seq',
              (SELECT MIN(seq) FROM history_deltas WHERE key=h.key)) ||
            ',"data":' || substr(json_remove(e.body,'$.text'),1,length(json_remove(e.body,'$.text'))-1) ||
            ',"text":"' || COALESCE(substr(h.body -> '$[0].data.text',2,length(h.body -> '$[0].data.text')-2),'') ||
            COALESCE((SELECT group_concat(fragment,'') FROM
              (SELECT substr(j.body -> '$.text',2,length(j.body -> '$.text')-2) AS fragment
               FROM history_deltas d JOIN events j ON j.seq=d.seq WHERE d.key=h.key ORDER BY d.seq)), '') || '"}}]'
          ELSE h.body END
          FROM history h LEFT JOIN events e ON e.seq=(SELECT MAX(seq) FROM history_deltas WHERE key=h.key)
          WHERE h.key=?`).run(key);
        this.db.prepare('DELETE FROM history_export_chunks WHERE key=?').run(key);
        // Store UTF-8 as a BLOB once: TEXT substr rescans preceding codepoints on every
        // call. BLOB ranges use byte offsets; a streaming decoder carries split UTF-8 bytes.
        this.db.exec('UPDATE history_export_build SET body=CAST(body AS BLOB)');
        const read = this.db.prepare('SELECT substr(body,?,8192) AS body FROM history_export_build');
        const insert = this.db.prepare('INSERT INTO history_export_chunks VALUES(?,?,?)');
        const decoder = new StringDecoder('utf8');
        let bytes = 1; let units = 0;
        while (true) {
          const encoded = read.get(bytes)!.body as Uint8Array;
          if (!encoded.length) break;
          const part = decoder.write(Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength));
          if (part.length) { insert.run(key, units, part); units += part.length; }
          bytes += encoded.length;
        }
        const tail = decoder.end();
        if (tail.length) { insert.run(key, units, tail); units += tail.length; }
        // The public cursor remains UTF-16 units, never SQLite codepoints or UTF-8 bytes.
        this.db.prepare('INSERT OR REPLACE INTO history_export VALUES(?,?,?)').run(key, revision, units);
        this.db.exec('DELETE FROM history_export_build; RELEASE history_export_build');
        cached = { units };
      } catch (error) {
        this.db.exec('ROLLBACK TO history_export_build; RELEASE history_export_build');
        throw error;
      }
    }
    const units = Number(cached.units);
    if (offset > units) throw new TurnwireError('INVALID_CURSOR', 'History offset exceeds record size');
    let data = '';
    const chunks = this.db.prepare(`SELECT start,body FROM history_export_chunks WHERE key=? AND start>=
      (SELECT MAX(start) FROM history_export_chunks WHERE key=? AND start<=?) AND start<? ORDER BY start`).iterate(key, key, offset, offset + limit);
    for (const chunk of chunks) {
      const start = Number(chunk.start);
      data += String(chunk.body).slice(Math.max(0, offset - start), offset + limit - start);
    }
    if (offset + data.length < units && /[\uD800-\uDBFF]/.test(data.charAt(data.length - 1))) data = data.slice(0, -1);
    if (!data.length && offset < units) throw new TurnwireError('INVALID_REQUEST', 'Chunk limit is too small for the next character');
    return { data, cursor: revision, nextOffset: offset + data.length < units ? offset + data.length : null };
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
  append(data: EventData, source?: string): TurnwireEvent | undefined {
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
  devices(): Pairing[] { return this.db.prepare('SELECT body FROM devices').all().map(row => JSON.parse(String(row.body)) as Pairing); }
  addDevice(pairing: Pairing) { this.db.prepare('INSERT INTO devices VALUES(?,?)').run(pairing.clientId, JSON.stringify(pairing)); }
  updateDevice(pairing: Pairing) { this.db.prepare('UPDATE devices SET body=? WHERE id=?').run(JSON.stringify(pairing), pairing.clientId); }
  removeDevice(id: string) { this.db.prepare('DELETE FROM devices WHERE id=?').run(id); }
  /** Closing twice is a no-op: every owner of a store may dispose it on its way out. */
  close() { if (this.closed) return; this.closed = true; this.db.close(); }
}
