import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalClient } from '../packages/sdk/src/index.js';
import { RequestContext, mergeCreateReply, mergeModelReply } from '../apps/remote-web/src/requestContext.js';
import type { Session, Snapshot } from '@turnwire/protocol';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Web request continuation ownership', () => {
  it.each(['success', 'error'] as const)('old-host %s and finally cannot touch new-host pending/data', async outcome => {
    const requests = new RequestContext(); const old = deferred<string>();
    let data = 'host A'; let error = ''; let busy = true;
    const currentA = requests.begin('perform');
    const task = old.promise.then(value => { if (currentA()) data = value; }).catch(() => { if (currentA()) error = 'old failure'; }).finally(() => { if (currentA()) busy = false; });
    requests.reset(); const currentB = requests.begin('perform'); data = 'host B';
    if (outcome === 'success') old.resolve('stale A'); else old.reject(new Error('A'));
    await task;
    expect({ data, error, busy }).toEqual({ data: 'host B', error: '', busy: true }); expect(currentB()).toBe(true);
  });
  it('latest operation alone owns each channel, including same-runtime catalogs', () => {
    const requests = new RequestContext();
    const catalogA = requests.begin('catalog'); const model = requests.begin('model');
    const catalogB = requests.begin('catalog');
    expect(catalogA()).toBe(false); expect(catalogB()).toBe(true); expect(model()).toBe(true);
    requests.reset(); expect(catalogB()).toBe(false); expect(model()).toBe(false);
  });
  it('model CAS and create preserve an entity already advanced by an event', () => {
    const target = { id: 's', title: 'old', model: { provider: 'p', model: 'old' } } as Session;
    const newer = { ...target, title: 'event title', model: { provider: 'p', model: 'new' } };
    const snapshot = { sessions: [newer] } as Snapshot;
    const reply = { ...target, model: { provider: 'p', model: 'reply' } };
    expect(mergeModelReply(snapshot, target, reply)?.sessions[0]).toBe(newer);
    expect(mergeCreateReply(snapshot, reply)).toBe(snapshot);
    expect(mergeModelReply({ sessions: [target] } as Snapshot, target, reply)?.sessions[0]?.model).toEqual(reply.model);
    expect(mergeCreateReply({ sessions: [] } as unknown as Snapshot, reply)?.sessions).toEqual([reply]);
  });
});

describe('LocalClient request lifetime', () => {
  it('close rejects pending fetch even if transport ignores abort; future calls never dispatch', async () => {
    let signal: AbortSignal | undefined;
    const response = deferred<Response>();
    const fetcher = vi.fn((_url: unknown, init: RequestInit) => { signal = init.signal as AbortSignal; return response.promise; }); vi.stubGlobal('fetch', fetcher);
    const client = new LocalClient('http://localhost:7777', 'token');
    const result = client.call('session.cancel', { sessionId: 's' });
    const rejected = expect(result).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    client.close(); await rejected; expect(signal?.aborted).toBe(true);
    await expect(client.call('system.snapshot')).rejects.toMatchObject({ code: 'CLOSED' });
    await expect(client.directStatus()).rejects.toMatchObject({ code: 'CLOSED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    response.resolve(new Response('{}')); await Promise.resolve();
  });
  it('owns response-body parsing and rejects both RPC and administration on close', async () => {
    const body = deferred<unknown>();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: () => body.promise })));
    const client = new LocalClient('http://localhost:7777', 'token');
    const rpc = client.call('system.snapshot'); const admin = client.directStatus();
    const rpcRejected = expect(rpc).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    const adminRejected = expect(admin).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await Promise.resolve(); client.close(); await Promise.all([rpcRejected, adminRejected]);
    body.reject(new Error('late parse failure')); await Promise.resolve();
  });
});
