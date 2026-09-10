import { z } from 'zod';
import { pushSubscriptionSchema, clientHelloSchema, serverHelloSchema, sessionPayloadSchema } from './connection.js';
export * from './connection.js';

export const PROTOCOL_VERSION = 1 as const;
export const idSchema = z.string().min(1).max(200);
export const statusSchema = z.enum(['idle', 'running', 'waiting_approval', 'interrupted', 'error']);
export type SessionStatus = z.infer<typeof statusSchema>;
export const capabilitiesSchema = z.object({ approvals: z.boolean(), streaming: z.boolean(), resume: z.boolean(), shell: z.boolean(), diff: z.boolean(), fileEdits: z.boolean(), toolCalls: z.boolean(), backgroundTasks: z.boolean(), modelSelection: z.boolean() });
export type RuntimeCapabilities = z.infer<typeof capabilitiesSchema>;
/** The model a session runs on. `reasoningEffort` is adapter-owned; absent means adapter default. */
export const modelSelectionSchema = z.object({ provider: idSchema, model: idSchema, reasoningEffort: idSchema.optional() }).strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export const modelReasoningEffortSchema = z.object({ id: idSchema, name: z.string(), description: z.string().optional() }).strict();
export type ModelReasoningEffort = z.infer<typeof modelReasoningEffortSchema>;
export const modelReasoningSchema = z.object({ efforts: z.array(modelReasoningEffortSchema), defaultEffort: idSchema.optional() }).strict();
export const modelCatalogModelSchema = z.object({ id: idSchema, name: z.string(), description: z.string().optional(), reasoning: modelReasoningSchema.optional() }).strict();
export type ModelCatalogModel = z.infer<typeof modelCatalogModelSchema>;
export const modelProviderGroupSchema = z.object({ id: idSchema, name: z.string(), models: z.array(modelCatalogModelSchema) }).strict();
export const modelCatalogFailureSchema = z.object({ id: idSchema, name: z.string(), message: z.string() }).strict();
/**
 * Selectable models for one runtime generation, plus the selection used by sessions that
 * have not chosen one. `routableProviders` distinguishes "serves requests" from "listed";
 * `failures` isolates providers whose lookup failed so one broken provider cannot hide the rest.
 */
export const modelCatalogSchema = z.object({ default: modelSelectionSchema, routableProviders: z.array(idSchema), groups: z.array(modelProviderGroupSchema), failures: z.array(modelCatalogFailureSchema) }).strict();
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export const sessionSchema = z.object({
  id: idSchema, runtimeId: idSchema, runtimeSessionId: idSchema,
  title: z.string(), cwd: z.string(), status: statusSchema,
  createdAt: z.string(), updatedAt: z.string(),
  archived: z.boolean().optional(),
  /** Absent until the runtime reports a selection for this session. */
  model: modelSelectionSchema.optional(),
});
export type Session = z.infer<typeof sessionSchema>;
export const approvalSchema = z.object({
  id: idSchema, sessionId: idSchema, tool: z.string(), reason: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']), createdAt: z.string(),
});
export type Approval = z.infer<typeof approvalSchema>;
export type ApprovalDecision = 'approved' | 'rejected';
export const eventDataSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.created'), session: sessionSchema }),
  z.object({ type: z.literal('session.updated'), session: sessionSchema }),
  z.object({ type: z.literal('message.user'), sessionId: idSchema, messageId: idSchema, text: z.string(),
    /** True when a turn was already running, so this prompt waits behind it instead of interrupting. */
    queued: z.boolean().optional(),
    /** True when this prompt steered the turn that was already running instead of queueing behind it. */
    steer: z.boolean().optional() }),
  z.object({ type: z.literal('message.delta'), sessionId: idSchema, messageId: idSchema, text: z.string() }),
  z.object({ type: z.literal('message.completed'), sessionId: idSchema, messageId: idSchema, text: z.string() }),
  /**
   * A prompt that had not run yet was changed before it did: edited, or moved into the running turn.
   * The journal recorded the prompt as it was first sent, so this keeps it true.
   */
  z.object({ type: z.literal('message.updated'), sessionId: idSchema, messageId: idSchema, text: z.string().optional(), queued: z.boolean().optional(), steer: z.boolean().optional() }),
  /** A prompt that had not run yet was taken back, so it never happened. */
  z.object({ type: z.literal('message.removed'), sessionId: idSchema, messageId: idSchema }),
  z.object({ type: z.literal('tool.started'), sessionId: idSchema, callId: idSchema, tool: z.string(), detail: z.string() }),
  z.object({ type: z.literal('tool.finished'), sessionId: idSchema, callId: idSchema, tool: z.string(), detail: z.string(), isError: z.boolean().optional() }),
  z.object({ type: z.literal('approval.requested'), approval: approvalSchema }),
  z.object({ type: z.literal('approval.resolved'), approval: approvalSchema }),
  z.object({ type: z.literal('runtime.status'), runtimeId: idSchema, online: z.boolean(), message: z.string() }),
  z.object({ type: z.literal('session.error'), sessionId: idSchema, message: z.string() }),
]);
export type EventData = z.infer<typeof eventDataSchema>;
export const eventSchema = z.object({ seq: z.number().int().nonnegative(), time: z.string(), originSeq: z.number().int().nonnegative().optional(), data: eventDataSchema });
export type TurnwireEvent = z.infer<typeof eventSchema>;
export interface RuntimeInfo { id: string; name: string; online: boolean; message: string; capabilities: RuntimeCapabilities;
  /** Background agents the runtime still owns; restarting the host would kill them. */
  busy?: number }
/**
 * One background agent under a session, as the runtime describes it. A delegation tool returns as
 * soon as it hands work to a child, so the parent's own transcript cannot say what the child is
 * doing; this is that view. `activity` is the runtime's read of whether the child still works, and
 * `todos` is the child's own plan when it keeps one — the closest thing to progress a runtime can
 * report without replaying the child's transcript for every client that asks.
 */
export const subagentViewSchema = z.object({
  id: idSchema,
  /** The agent this child hangs under; the requested session itself for a direct child. */
  parentId: idSchema,
  /** Edge distance from the requested session: direct children are 1. */
  depth: z.number().int().nonnegative(),
  /** The short description the delegation carried, falling back to the child's own title. */
  label: z.string(),
  mode: z.enum(['one-shot', 'continuable']),
  activity: z.enum(['running', 'inactive']),
  /** How long the child has been working, from the runtime's own timing projection. */
  elapsedMs: z.number().int().nonnegative().optional(),
  todos: z.array(z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) })),
});
export type SubagentView = z.infer<typeof subagentViewSchema>;
/**
 * What a client may do to a prompt that is still waiting in the runtime's queue: change its text,
 * take it back, or move it into the turn that is already running.
 */
export const queueActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('steer') }).strict(),
  z.object({ kind: z.literal('remove') }).strict(),
  z.object({ kind: z.literal('edit'), text: z.string().trim().min(1).max(100_000) }).strict(),
]);
export type QueueAction = z.infer<typeof queueActionSchema>;
export interface Snapshot { device: { id: string; name: string }; sessions: Session[]; approvals: Approval[]; runtimes: RuntimeInfo[]; cursor: number }

export const methodSchemas = {
  'system.snapshot': z.object({}).strict(),
  'request.result': z.object({ requestId: idSchema }).strict(),
  'inbox.page': z.object({ before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(40), status: z.enum(['pending', 'all']).default('pending') }).strict(),
  'notifications.status': z.object({}).strict(),
  'notifications.subscribe': pushSubscriptionSchema,
  'notifications.unsubscribe': z.object({}).strict(),
  'session.create': z.object({ cwd: z.string().min(1).max(4096), title: z.string().trim().min(1).max(200).default('New session'), runtimeId: idSchema.default('dsh'), model: modelSelectionSchema.optional() }).strict(),
  'session.resume': z.object({ sessionId: idSchema }).strict(),
  'session.rename': z.object({ sessionId: idSchema, title: z.string().trim().min(1).max(200) }).strict(),
  'session.archive': z.object({ sessionId: idSchema, archived: z.boolean() }).strict(),
  'session.message': z.object({ sessionId: idSchema, text: z.string().trim().min(1).max(100_000),
    /** Steer the running turn instead of waiting behind it; ignored semantics when no turn runs. */
    steer: z.boolean().optional() }).strict(),
  'session.cancel': z.object({ sessionId: idSchema }).strict(),
  /** Change a prompt that has not run yet, addressed by the id the client already shows for it. */
  'session.queueAction': z.object({ sessionId: idSchema, messageId: idSchema, action: queueActionSchema }).strict(),
  'session.setModel': z.object({ sessionId: idSchema, provider: idSchema, model: idSchema, reasoningEffort: idSchema.optional() }).strict(),
  'model.catalog': z.object({ runtimeId: idSchema.optional() }).strict(),
  'approval.decide': z.object({ approvalId: idSchema, decision: z.enum(['approved', 'rejected']) }).strict(),
  'history.page': z.object({ sessionId: idSchema, before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(40) }).strict(),
  'events.list': z.object({ after: z.number().int().nonnegative().default(0), sessionId: idSchema.optional(), limit: z.number().int().min(1).max(1000).default(500) }).strict(),
  /** Live background agents under one session. A read, so clients may poll it like a snapshot. */
  'subagent.list': z.object({ sessionId: idSchema }).strict(),
} as const;
export type Method = keyof typeof methodSchemas;
export const requestSchema = z.object({ v: z.literal(PROTOCOL_VERSION), id: idSchema, method: z.enum(Object.keys(methodSchemas) as [Method, ...Method[]]), params: z.unknown() }).strict();
export type RpcRequest = z.infer<typeof requestSchema>;
export type RpcResponse = { v: 1; id: string; ok: true; result: unknown } | { v: 1; id: string; ok: false; error: { code: string; message: string } };
export const responseSchema = z.discriminatedUnion('ok', [
  z.object({ v: z.literal(1), id: idSchema, ok: z.literal(true), result: z.unknown() }),
  z.object({ v: z.literal(1), id: idSchema, ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);
/**
 * Every stable error code the host can return. The code is the shared, localisable contract:
 * clients render user-visible text from `error.code`, while `error.message` stays an English
 * fallback that scripts and `--json` consumers can rely on.
 */
export const turnwireErrorCodes = [
  'APPROVAL_EXPIRED',
  'AUTHENTICATION_FAILED',
  'DISCONNECTED',
  'DSH_AUTH_FAILED',
  'DSH_AUTH_REQUIRED',
  'DSH_HTTP_ERROR',
  'EXPIRED_MESSAGE',
  'HANDSHAKE_REUSED',
  'HOST_OFFLINE',
  'HTTP_ERROR',
  'INVALID_CIPHERTEXT',
  'INVALID_CURSOR',
  'INVALID_WORKSPACE',
  'MODEL_SELECTION_UNSUPPORTED',
  'MODEL_UNAVAILABLE',
  'NOT_AVAILABLE',
  'OUTCOME_UNKNOWN',
  'PROBE_TIMEOUT',
  'QUEUE_ITEM_GONE',
  'RATE_LIMITED',
  'REKEY_REQUIRED',
  'REMOTE_ERROR',
  'REPLAYED_MESSAGE',
  'REQUEST_CONFLICT',
  'REQUEST_PENDING',
  'RESUME_REQUIRED',
  'RUNTIME_UNAVAILABLE',
  'SESSION_ARCHIVED',
  'SESSION_BUSY',
  'SESSION_NOT_FOUND',
  'STAGE_TIMEOUT',
] as const;
export type TurnwireErrorCode = typeof turnwireErrorCodes[number];
export class TurnwireError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'TurnwireError'; }
}
export function errorResponse(id: string, error: unknown): RpcResponse {
  return { v: 1, id, ok: false, error: { code: error instanceof TurnwireError ? error.code : error instanceof z.ZodError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
}

const pairingFields = { relayUrl: z.string().url(), hostId: idSchema, clientId: idSchema, token: z.string().min(32).max(500), key: z.string().regex(/^[a-f0-9]{64}$/), name: z.string() };
export const pairingSchema = z.discriminatedUnion('v', [
  z.object({ v: z.literal(1), ...pairingFields }).strict(),
  z.object({ v: z.literal(2), ...pairingFields, bootstrap: z.boolean().optional(), expiresAt: z.string().datetime().optional(), pendingKey: z.string().regex(/^[a-f0-9]{64}$/).optional(), directUrls: z.array(z.string().url()).max(4).optional() }).strict(),
]);
export type Pairing = z.infer<typeof pairingSchema>;
// Host administration is shared by every local UI, but is never a remote RPC.
export const remoteModeSchema = z.enum(['off', 'temporary', 'relay']);
export type RemoteMode = z.infer<typeof remoteModeSchema>;
export const tunnelProviderSchema = z.enum(['cloudflare', 'cloudflare-named', 'localhost-run', 'cpolar']);
export type TunnelProvider = z.infer<typeof tunnelProviderSchema>;
export const tunnelProviderInfoSchema = z.object({ id: tunnelProviderSchema, name: z.string(), description: z.string(), requiresToken: z.boolean() });
export type TunnelProviderInfo = z.infer<typeof tunnelProviderInfoSchema>;
export const remoteConfigurationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }).strict(),
  z.object({ mode: z.literal('temporary'), provider: tunnelProviderSchema.optional(), cpolarToken: z.string().trim().min(1).max(500).regex(/^[A-Za-z0-9_.-]+$/).optional(),
    /**
     * A tunnel the operator already created under their own account. Turnwire only targets it, so
     * every value is operator-supplied and no deployment is performed.
     */
    namedTunnel: z.object({ name: idSchema, hostname: z.string().trim().min(1).max(253), credentialsFile: z.string().trim().min(1).max(4096), protocol: z.enum(['auto', 'http2', 'quic']).default('http2') }).strict().optional() }).strict(),
  z.object({ mode: z.literal('relay'), serverUrl: z.string().trim().min(1).max(2000), token: z.string().trim().min(32).max(500).optional() }).strict(),
]);
export type RemoteConfiguration = z.infer<typeof remoteConfigurationSchema>;
export const remoteStatusSchema = z.object({
  mode: remoteModeSchema, state: z.enum(['off', 'starting', 'online', 'offline', 'error']), message: z.string(),
  relayUrl: z.string().optional(), remoteUrl: z.string().optional(), relayServerUrl: z.string().optional(), hasRelayToken: z.boolean(),
  notices: z.array(z.string()).default([]),
  provider: tunnelProviderSchema.optional(), hasCpolarToken: z.boolean().default(false), providers: z.array(tunnelProviderInfoSchema).default([]),
});
export type RemoteStatus = z.infer<typeof remoteStatusSchema>;
export const pairDeviceSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export const revokeDeviceSchema = z.object({ id: idSchema }).strict();
export const pairedDeviceSchema = z.object({ id: idSchema, name: z.string(), protocol: z.number().optional(), enrollment: z.enum(['pending', 'enrolled', 'legacy']).optional(), connection: z.enum(['connected', 'offline', 'unconfirmed']).optional(), lastConfirmedAt: z.string().optional(), latencyMs: z.number().nonnegative().optional() });
export type PairedDevice = z.infer<typeof pairedDeviceSchema>;
export const pairingResultSchema = z.object({ pairing: pairingSchema, code: z.string(), url: z.string().optional() });
export type PairingResult = z.infer<typeof pairingResultSchema>;
export const encryptedSchema = z.object({ nonce: z.string().max(100), ciphertext: z.string().max(2_800_000) }).strict();
export const transportPayloadSchema = z.union([encryptedSchema, clientHelloSchema, serverHelloSchema, sessionPayloadSchema]);
export type EncryptedPayload = z.infer<typeof encryptedSchema>;
export const connectionPingSchema = z.object({ nonce: idSchema }).strict();
export const connectionPongSchema = z.object({ nonce: idSchema, challenge: idSchema, hostId: idSchema }).strict();
export const connectionAckSchema = z.object({ challenge: idSchema }).strict();
export const secureMessageSchema = z.object({ id: idSchema, sentAt: z.number(), kind: z.enum(['request', 'response', 'event', 'subscribe', 'subscribed', 'ping', 'pong', 'ack', 'confirmed', 'enroll', 'enrolled', 'error', 'routes']), body: z.unknown() }).strict();
export type SecureMessage = z.infer<typeof secureMessageSchema>;
export const relayAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host'), protocol: z.literal(2).optional(), hostId: idSchema, token: z.string().max(500), clients: z.array(z.object({ id: idSchema, token: z.string().min(32).max(500) })).max(100) }).strict(),
  z.object({ kind: z.literal('client'), hostId: idSchema, clientId: idSchema, token: z.string().max(500) }).strict(),
]);
export type RelayAuth = z.infer<typeof relayAuthSchema>;
export { deploymentConfigSchema, deploymentStatusSchema } from './deployment.js';
export type { DeploymentConfig, DeploymentStatus } from './deployment.js';

export { historyKey, historyOrder, reduceHistory, HistoryBuffer } from './history.js';
export type { HistoryPage } from './history.js';

export interface InboxPage { items: Array<{ position: number; approval: Approval; sessionTitle: string }>; nextBefore: number | null; cursor: number }
