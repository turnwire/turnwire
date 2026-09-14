import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnwireError } from '@turnwire/protocol';

export interface ExportRequest { sessionId: string; originSeq: number; offset: number; limit: number; cursor?: number }
export interface ExportChunk { data: string; cursor: number; nextOffset: number | null }

/** Self-contained JavaScript source, intentionally not function.toString(): bundlers
 * rewrite require/name helpers inside functions. No sidecar or TS loader is needed. */
const EXPORT_WORKER = String.raw`
  const { parentPort, workerData } = require('node:worker_threads');
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  const db = new DatabaseSync(workerData.path, { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-2048');
  let cached;
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  parentPort.on('message', (p) => {
    let fd;
    try {
      db.exec('BEGIN');
      const row = db.prepare('SELECT h.key,s.revision,s.prefix FROM history h JOIN history_export_state s ON s.key=h.key WHERE h.session_id=? AND h.first_seq=?').get(p.sessionId, p.originSeq);
      if (!row) fail('HISTORY_NOT_FOUND', 'History record does not belong to this session');
      const revision = Number(row.revision); const key = String(row.key);
      if (p.cursor !== undefined && revision !== p.cursor) fail('HISTORY_CHANGED', 'History record changed while being read; restart from offset zero');
      if (!cached || cached.key !== key || cached.revision !== revision) {
        cached = undefined;
        fd = fs.openSync(workerData.cache, 'w+', 0o600);
        let units = 0; let bytes = 0;
        const write = (part) => {
          bytes += Buffer.byteLength(part);
          if (bytes > 64 * 1024 * 1024) fail('HISTORY_TOO_LARGE', 'History record exceeds the 64 MiB export limit');
          const buffer = Buffer.from(part, 'utf16le');
          let written = 0;
          while (written < buffer.length) written += fs.writeSync(fd, buffer, written, buffer.length - written);
          units += part.length;
        };
        const incremental = row.prefix !== null;
        if (incremental) write(String(row.prefix));
        for (const fragment of db.prepare('SELECT body FROM history_fragments WHERE key=? AND kind=? ORDER BY seq,part').iterate(key, incremental ? 'text' : 'baseline')) write(String(fragment.body));
        if (incremental) write('\"}}]');
        fs.closeSync(fd); fd = undefined;
        cached = { key, revision, units };
      }
      db.exec('COMMIT');
      const units = cached.units;
      if (p.offset > units) fail('INVALID_CURSOR', 'History offset exceeds record size');
      fd = fs.openSync(workerData.cache, 'r');
      const buffer = Buffer.alloc(Math.min(p.limit, units - p.offset) * 2);
      const count = fs.readSync(fd, buffer, 0, buffer.length, p.offset * 2);
      let data = buffer.subarray(0, count).toString('utf16le');
      if (p.offset > 0 && /^[\uDC00-\uDFFF]/.test(data)) fail('INVALID_CURSOR', 'History offset splits a Unicode character');
      if (p.offset + data.length < units && /[\uD800-\uDBFF]/.test(data.charAt(data.length - 1))) data = data.slice(0, -1);
      if (!data.length && p.offset < units) fail('INVALID_REQUEST', 'Chunk limit is too small for the next character');
      parentPort.postMessage({ result: { data, cursor: revision, nextOffset: p.offset + data.length < units ? p.offset + data.length : null } });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      if (!cached) { try { fs.unlinkSync(workerData.cache); } catch {} }
      const e = error;
      const domain = typeof e.code === 'string' && /^(HISTORY_|INVALID_)/.test(e.code);
      parentPort.postMessage({ error: { code: domain ? e.code : 'HISTORY_EXPORT_FAILED', message: domain ? e.message : 'History export failed' } });
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  });
`;

type Pending = { request: ExportRequest; resolve: (chunk: ExportChunk) => void; reject: (error: Error) => void; signal?: AbortSignal; abort?: () => void; timer?: ReturnType<typeof setTimeout> };
/** One reader worker, one bounded cache file, at most eight admitted requests per Store. */
export class HistoryExporter {
  private worker?: Worker;
  private directory?: string;
  private pending: Pending[] = [];
  private active?: Pending;
  private stopped = false;
  // Resources remain owned until each release succeeds. Internal cleanup resolves
  // an outcome (never a detached rejection); close exposes that outcome to its caller.
  private retiringWorker?: Worker;
  private cleanup?: Promise<Error | undefined>;
  private cleanupError?: Error;
  constructor(private readonly path: string, private readonly timeoutMs = 30_000) {}
  read(request: ExportRequest, signal?: AbortSignal): Promise<ExportChunk> {
    if (this.stopped) return Promise.reject(new TurnwireError('HISTORY_EXPORT_CLOSED', 'History exporter is closed'));
    if (signal?.aborted) return Promise.reject(new TurnwireError('HISTORY_EXPORT_CANCELLED', 'History export cancelled'));
    if (this.cleanupError) return Promise.reject(new TurnwireError('HISTORY_EXPORT_FAILED', 'History export cleanup failed'));
    if (this.pending.length + Number(!!this.active) >= 8) return Promise.reject(new TurnwireError('HISTORY_EXPORT_BUSY', 'Too many history exports'));
    return new Promise((resolve, reject) => {
      const item: Pending = { request, resolve, reject, signal };
      item.abort = () => this.cancel(item, 'HISTORY_EXPORT_CANCELLED', 'History export cancelled');
      signal?.addEventListener('abort', item.abort, { once: true });
      item.timer = setTimeout(() => this.cancel(item, 'HISTORY_EXPORT_TIMEOUT', 'History export timed out'), this.timeoutMs);
      this.pending.push(item); this.pump();
    });
  }
  private finish(item: Pending, error?: Error, chunk?: ExportChunk) {
    clearTimeout(item.timer); if (item.abort) item.signal?.removeEventListener('abort', item.abort);
    if (error) item.reject(error); else item.resolve(chunk!);
  }
  private reset(): Promise<Error | undefined> {
    if (this.cleanup) return this.cleanup;
    this.retiringWorker ??= this.worker;
    this.worker = undefined;
    // Defer release until cleanup is installed, including synchronous terminate throws.
    this.cleanup = Promise.resolve().then(async () => {
      try {
        if (this.retiringWorker) {
          await this.retiringWorker.terminate();
          this.retiringWorker = undefined;
        }
        if (this.directory) {
          rmSync(this.directory, { recursive: true, force: true });
          this.directory = undefined;
        }
        this.cleanupError = undefined;
      } catch (error) {
        this.cleanupError = error instanceof Error ? error : new Error(String(error));
        for (const item of this.pending.splice(0)) this.finish(item, new TurnwireError('HISTORY_EXPORT_FAILED', 'History export cleanup failed'));
      }
      this.cleanup = undefined;
      if (!this.cleanupError) this.pump();
      return this.cleanupError;
    });
    return this.cleanup;
  }
  private cancel(item: Pending, code: string, message: string) {
    if (this.active === item) {
      this.active = undefined; this.finish(item, new TurnwireError(code, message));
      void this.reset();
    } else {
      const index = this.pending.indexOf(item); if (index < 0) return;
      this.pending.splice(index, 1); this.finish(item, new TurnwireError(code, message));
    }
  }
  private pump() {
    if (this.stopped || this.cleanup || this.cleanupError || this.active || !this.pending.length) return;
    // Admit before acquiring resources: a synchronous startup/send failure must
    // settle this request, not leave it queued for an accidental replay.
    this.active = this.pending.shift()!;
    try {
      if (!this.worker) {
        this.directory = mkdtempSync(join(tmpdir(), 'turnwire-export-'));
        const worker = this.worker = new Worker(EXPORT_WORKER, { eval: true, execArgv: [], workerData: { path: this.path, cache: join(this.directory, 'record') }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
        worker.on('message', (message: { result?: ExportChunk; error?: { code: string; message: string } }) => {
          if (worker !== this.worker || !this.active) return;
          const item = this.active; this.active = undefined;
          this.finish(item, message.error ? new TurnwireError(message.error.code, message.error.message) : undefined, message.result);
          this.pump();
        });
        const failed = () => {
          if (worker !== this.worker) return;
          if (this.active) this.cancel(this.active, 'HISTORY_EXPORT_FAILED', 'History export worker stopped');
          else void this.reset();
        };
        worker.on('error', failed); worker.on('exit', failed);
      }
      this.worker.postMessage(this.active.request);
    } catch {
      this.cancel(this.active!, 'HISTORY_EXPORT_FAILED', 'History export worker could not start or receive request');
    }
  }
  /** Cancels reads before maintenance/shutdown and releases all SQLite handles. */
  async close() {
    this.stopped = true;
    for (const item of [...this.pending]) this.cancel(item, 'HISTORY_EXPORT_CANCELLED', 'History export cancelled');
    if (this.active) {
      const item = this.active; this.active = undefined;
      this.finish(item, new TurnwireError('HISTORY_EXPORT_CANCELLED', 'History export cancelled'));
    }
    const error = await this.reset();
    if (error) throw error;
  }
}
