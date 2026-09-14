import { describe, it, expect } from 'vitest';
import { decodeDshResponse, validateDshSessionList, inspectDshCompatibility, parseDshModelCatalog } from '../packages/runtime-dsh/src/compatibility.js';

const catalog = { default: { provider: 'fixture', model: 'fixture', extra: true }, routableProviders: ['fixture'], groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'fixture', name: 'Fixture', newModality: true }], extra: 1 }], failures: [], newField: true };
describe('DSH observed compatibility boundary', () => {
  it('requires matching RPC identity and success/error envelope, tolerating additive fields', () => {
    expect(decodeDshResponse({ type: 'server-response', rpcId: 'a', result: { ok: true, value: 3, extra: true }, extra: true }, 'a')).toBe(3);
    for (const value of [{ type: 'server-response', rpcId: 'wrong', result: { ok: true, value: {} } }, { type: 'server-response', rpcId: 'a', result: { ok: 'true' } }, '<html>']) expect(() => decodeDshResponse(value, 'a')).toThrow();
    expect(() => decodeDshResponse({ type: 'server-response', rpcId: 'a', result: { ok: false, error: { code: 'unavailable', message: 'No route' } } }, 'a')).toThrow('No route');
  });
  it('rejects broken required row semantics but accepts future optional projections', () => {
    expect(validateDshSessionList({ items: [{ sessionId: 's', running: false, projections: { future: true } }], nextPage: 'future' }).items).toHaveLength(1);
    for (const row of [{ sessionId: 's' }, { sessionId: 1, running: false }, { sessionId: 's', running: 'false' }]) expect(() => validateDshSessionList({ items: [row] })).toThrow('required session');
  });
  it('reports only observed support, never invents remote version or capabilities', async () => {
    const calls: string[] = [];
    const report = await inspectDshCompatibility(async endpoint => { calls.push(endpoint); return endpoint === 'session/list' ? { items: [] } : catalog; });
    expect(calls).toEqual(['session/list', 'session/modelCatalog']);
    expect(report).toMatchObject({ version: null, optional: { modelCatalog: 'supported', contextUsage: 'unknown', imageInput: 'unknown' } });
    expect(parseDshModelCatalog(catalog).groups[0]?.models[0]).toEqual({ id: 'fixture', name: 'Fixture' });
  });
  it('optional missing or malformed catalogs never poison verified core compatibility', async () => {
    for (const value of [undefined, { groups: [] }]) {
      expect((await inspectDshCompatibility(async endpoint => endpoint === 'session/list' ? { items: [] } : value)).optional.modelCatalog).toBe('unknown');
    }
    await expect(inspectDshCompatibility(async () => ({ items: [{ sessionId: 's' }] }))).rejects.toThrow('required session');
  });
});
