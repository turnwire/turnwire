import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TurnwireError, modelCatalogSchema } from '@turnwire/protocol';

/** Observations, not a guarantee that every session operation is compatible. No remote
 * version or capability-discovery endpoint exists in the inspected DSH contract. */
export interface DshCompatibilityReport {
  version: string | null;
  evidence: 'authenticated-read-only-rpc';
  core: { sessionList: 'supported' };
  optional: { modelCatalog: 'supported' | 'unknown'; contextUsage: 'unknown'; imageInput: 'unknown' };
}
export const dshSessionListSchema = z.object({ items: z.array(z.object({ sessionId: z.string().min(1), running: z.boolean() }).passthrough()) }).passthrough();
const resultSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.unknown() }), z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) })]);
export function decodeDshResponse(value: unknown, rpcId: string): unknown {
  const parsed = z.object({ type: z.literal('server-response'), rpcId: z.literal(rpcId), result: resultSchema }).safeParse(value);
  if (!parsed.success) throw new TurnwireError('DSH_INCOMPATIBLE', 'DSH RPC response does not match the required envelope');
  if (!parsed.data.result.ok) throw new TurnwireError(parsed.data.result.error.code, parsed.data.result.error.message);
  return parsed.data.result.value;
}
export function validateDshSessionList(value: unknown) {
  const result = dshSessionListSchema.safeParse(value);
  if (!result.success) throw new TurnwireError('DSH_INCOMPATIBLE', 'DSH session/list does not provide the required session identity and running state');
  return result.data;
}
// Strip additive upstream fields only, while retaining required field validation. The
// public Turnwire catalog remains strict and model IDs are never synthesized.
export function parseDshModelCatalog(value: unknown) {
  const root = z.object({ default: z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() }), routableProviders: z.array(z.string()), groups: z.array(z.object({ id: z.string(), name: z.string(), models: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional(), reasoning: z.object({ efforts: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional() })), defaultEffort: z.string().optional() }).optional() })) })), failures: z.array(z.object({ id: z.string(), name: z.string(), message: z.string() })) }).parse(value);
  return modelCatalogSchema.parse(root);
}
export async function inspectDshCompatibility(rpc: (endpoint: string, args: unknown) => Promise<unknown>): Promise<DshCompatibilityReport> {
  validateDshSessionList(await rpc('session/list', { _request: {} }));
  let modelCatalog: 'supported' | 'unknown' = 'unknown';
  try { parseDshModelCatalog(await rpc('session/modelCatalog', {})); modelCatalog = 'supported'; } catch { /* Optional: missing, malformed or temporarily unavailable is not core failure. */ }
  return { version: null, evidence: 'authenticated-read-only-rpc', core: { sessionList: 'supported' }, optional: { modelCatalog, contextUsage: 'unknown', imageInput: 'unknown' } };
}
export async function probeDshCompatibility(launch: string, timeoutMs = 5000): Promise<DshCompatibilityReport> {
  const url = new URL(launch);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('DSH probe requires a safe authenticated URL');
  const signal = AbortSignal.timeout(timeoutMs);
  const login = await fetch(url, { redirect: 'manual', signal });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  await login.body?.cancel();
  if (login.status !== 303 || !cookie) throw new Error('DSH authentication not ready');
  return inspectDshCompatibility(async (endpoint, args) => {
    const rpcId = randomUUID();
    const response = await fetch(new URL(`/api/${endpoint}`, url), { method: 'POST', redirect: 'error', signal, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }) });
    if (!response.ok) { await response.body?.cancel(); throw new TurnwireError('DSH_HTTP_ERROR', `DSH ${endpoint} returned HTTP ${response.status}`); }
    return decodeDshResponse(await response.json(), rpcId);
  });
}
