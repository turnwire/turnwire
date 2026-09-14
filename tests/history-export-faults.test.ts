import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({ mkdir: vi.fn(), remove: vi.fn(), start: vi.fn(), terminate: vi.fn(), send: vi.fn() }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), mkdtempSync: faults.mkdir, rmSync: faults.remove }));
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  constructor(...args: unknown[]) { super(); faults.start(...args); }
  terminate() { return faults.terminate(); }
  postMessage(request: unknown) { faults.send(request, this); }
} }));
import { HistoryExporter } from '../packages/core/src/history-export.js';
import { Store } from '../packages/core/src/store.js';

const request = { sessionId: 'session', originSeq: 1, offset: 0, limit: 10 };
const denied = Object.assign(new Error('private/cache EACCES'), { code: 'EACCES' });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
// Exercise Store's disposal ownership without opening or modifying any database.
function storeWith(exporter: HistoryExporter): Store {
  return Object.assign(Object.create(Store.prototype) as Store, {
    exporter, exportGeneration: 0, exportCleanup: Promise.resolve(undefined),
    exportCleanupRunning: false, closed: false, db: { close: vi.fn() },
  });
}
let unhandled: unknown[];
const onUnhandled = (error: unknown) => unhandled.push(error);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.resetAllMocks();
  let serial = 0;
  faults.mkdir.mockImplementation(() => `/mock/cache-${++serial}`);
  faults.terminate.mockResolvedValue(0);
  unhandled = []; process.on('unhandledRejection', onUnhandled);
});
afterEach(async () => {
  await tick();
  expect(unhandled).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  process.off('unhandledRejection', onUnhandled); vi.useRealTimers();
});

describe('history export resource ownership under faults', () => {
  it('settles startup failure immediately, clears timer/listener, and never replays it', async () => {
    faults.start.mockImplementationOnce(() => { throw new Error('ERR_WORKER_INIT_FAILED'); });
    const exporter = new HistoryExporter('/unused');
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(exporter.read(request, controller.signal)).rejects.toMatchObject({ code: 'HISTORY_EXPORT_FAILED' });
    await tick();
    expect(vi.getTimerCount()).toBe(0); expect(removeListener).toHaveBeenCalled();
    expect(faults.remove).toHaveBeenCalledWith('/mock/cache-1', { recursive: true, force: true });
    faults.send.mockImplementation((_, worker) => queueMicrotask(() => worker.emit('message', { result: { data: 'ok', cursor: 1, nextOffset: null } })));
    await expect(exporter.read({ ...request, originSeq: 2 })).resolves.toMatchObject({ data: 'ok' });
    expect(faults.send.mock.calls.map(([r]) => r.originSeq)).toEqual([2]);
    await exporter.close();
    expect(faults.remove.mock.calls.map(([path]) => path)).toEqual(['/mock/cache-1', '/mock/cache-2']);
  });

  it('owns automatic reset failure, drains queue, reports close failure and retries the same directory', async () => {
    const exporter = new HistoryExporter('/unused');
    const controller = new AbortController();
    const active = exporter.read(request, controller.signal).catch(error => error);
    const queued = exporter.read({ ...request, originSeq: 2 }).catch(error => error);
    faults.remove.mockImplementation(() => { throw denied; });
    controller.abort();
    expect(await active).toMatchObject({ code: 'HISTORY_EXPORT_CANCELLED' });
    expect(await queued).toMatchObject({ code: 'HISTORY_EXPORT_FAILED' });
    await expect(exporter.read(request)).rejects.toMatchObject({ message: 'History export cleanup failed' });
    await expect(exporter.close()).rejects.toBe(denied);
    expect(faults.mkdir).toHaveBeenCalledTimes(1);
    faults.remove.mockReset(); await exporter.close();
    expect(faults.remove).toHaveBeenCalledWith('/mock/cache-1', { recursive: true, force: true });
    expect(faults.terminate).toHaveBeenCalledTimes(1);
  });

  it('retains startup directory when its cleanup fails, without replay or replacement', async () => {
    faults.start.mockImplementation(() => { throw new Error('ERR_WORKER_INIT_FAILED'); });
    faults.remove.mockImplementation(() => { throw denied; });
    const exporter = new HistoryExporter('/unused');
    await expect(exporter.read(request)).rejects.toMatchObject({ code: 'HISTORY_EXPORT_FAILED' });
    await tick();
    await expect(exporter.read(request)).rejects.toMatchObject({ code: 'HISTORY_EXPORT_FAILED' });
    await expect(exporter.close()).rejects.toBe(denied);
    expect(faults.mkdir).toHaveBeenCalledTimes(1); expect(faults.send).not.toHaveBeenCalled();
    faults.remove.mockReset(); await exporter.close();
    expect(faults.remove.mock.calls[0]?.[0]).toBe('/mock/cache-1');
  });

  it.each(['throw', 'reject'])('retains worker when terminate %s fails and retries before removing cache', async kind => {
    const exporter = new HistoryExporter('/unused');
    const read = exporter.read(request).catch(error => error);
    if (kind === 'throw') faults.terminate.mockImplementationOnce(() => { throw denied; });
    else faults.terminate.mockRejectedValueOnce(denied);
    await expect(exporter.close()).rejects.toBe(denied);
    expect(await read).toMatchObject({ code: 'HISTORY_EXPORT_CANCELLED' });
    expect(faults.remove).not.toHaveBeenCalled();
    await exporter.close(); expect(faults.terminate).toHaveBeenCalledTimes(2);
    expect(faults.remove).toHaveBeenCalledTimes(1);
  });

  it('handles mkdtemp and postMessage synchronous exceptions without queued zombies', async () => {
    const exporter = new HistoryExporter('/unused');
    faults.mkdir.mockImplementationOnce(() => { throw denied; });
    await expect(exporter.read(request)).rejects.toMatchObject({ code: 'HISTORY_EXPORT_FAILED' });
    await tick();
    faults.send.mockImplementationOnce(() => { throw new Error('DataCloneError'); });
    await expect(exporter.read(request)).rejects.toMatchObject({ code: 'HISTORY_EXPORT_FAILED' });
    await exporter.close();
    expect(faults.send).toHaveBeenCalledTimes(1); expect(faults.remove).toHaveBeenCalledTimes(1);
  });

  it('timeout settles active and queued reads even when automatic cleanup fails', async () => {
    const exporter = new HistoryExporter('/unused', 5);
    const active = exporter.read(request).catch(error => error);
    const queued = exporter.read(request).catch(error => error);
    faults.remove.mockImplementation(() => { throw denied; });
    await vi.advanceTimersByTimeAsync(5);
    expect(await active).toMatchObject({ code: 'HISTORY_EXPORT_TIMEOUT' });
    expect(await queued).toMatchObject({ code: 'HISTORY_EXPORT_FAILED' });
    await expect(exporter.close()).rejects.toBe(denied);
    faults.remove.mockReset(); await exporter.close();
  });

  it('owns idle worker exit cleanup and ignores duplicate worker events', async () => {
    const exporter = new HistoryExporter('/unused');
    let worker!: EventEmitter;
    faults.send.mockImplementation((_, value) => {
      worker = value;
      queueMicrotask(() => worker.emit('message', { result: { data: 'ok', cursor: 1, nextOffset: null } }));
    });
    await exporter.read(request);
    faults.remove.mockImplementation(() => { throw denied; });
    worker.emit('exit', 1); worker.emit('error', new Error('duplicate'));
    await tick();
    await expect(exporter.close()).rejects.toBe(denied);
    faults.remove.mockReset(); await exporter.close();
    expect(faults.terminate).toHaveBeenCalledTimes(1);
  });

  it('Store maintenance retains failed exporter ownership and recovers on retry', async () => {
    const exporter = new HistoryExporter('/unused');
    const pending = exporter.read(request).catch(error => error);
    const store = storeWith(exporter);
    faults.remove.mockImplementation(() => { throw denied; });
    await expect(store.cancelHistoryExports()).rejects.toBe(denied);
    expect(await pending).toMatchObject({ code: 'HISTORY_EXPORT_CANCELLED' });
    await expect(store.historyRecordChunk('session', 1, 0, 10)).rejects.toMatchObject({ code: 'HISTORY_EXPORT_FAILED' });
    faults.remove.mockReset(); await store.cancelHistoryExports();
    faults.send.mockImplementation((_, worker) => queueMicrotask(() => worker.emit('message', { result: { data: 'fresh', cursor: 1, nextOffset: null } })));
    await expect(store.historyRecordChunk('session', 1, 0, 10)).resolves.toMatchObject({ data: 'fresh' });
    await store.close();
    expect(faults.remove.mock.calls.map(([path]) => path)).toEqual(['/mock/cache-1', '/mock/cache-2']);
  });

  it('Store close shares in-flight attempt, remains observably failed, and retries disposal', async () => {
    const exporter = new HistoryExporter('/unused');
    const pending = exporter.read(request).catch(error => error);
    const store = storeWith(exporter);
    Object.assign(store, { temporaryDirectory: '/mock/store' });
    faults.remove.mockImplementation(path => { if (path === '/mock/store') throw denied; });
    const first = store.close(); expect(store.close()).toBe(first);
    await expect(first).rejects.toBe(denied); await pending;
    faults.remove.mockReset(); await store.close();
    expect(store.db.close).toHaveBeenCalledTimes(1);
    expect(faults.remove).toHaveBeenCalledWith('/mock/store', { recursive: true, force: true });
  });
});
