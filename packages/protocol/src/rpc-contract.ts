import { z } from 'zod';
import { methodSchemas, idSchema, sessionSchema, approvalSchema, questionSchema, capabilitiesSchema, eventSchema, responseSchema, queueItemViewSchema, subagentViewSchema, subagentHistoryPageSchema, workspaceListingSchema, modelCatalogSchema } from './index.js';
import type { Method } from './index.js';
import { notificationStatusSchema } from './connection.js';
import { imageChunkSchema } from './images.js';

// Lazy references keep the public index re-export cycle initialization-safe.
const position = z.number().int().nonnegative();
export const historyPageSchema = z.lazy(() => z.object({ events: z.array(eventSchema), cursor: position, hasMore: z.boolean(), nextBefore: position.nullable() }));
/** Full export fails explicitly above this per-record assembly budget; previews never replace full text. */
export const MAX_HISTORY_RECORD_BYTES = 64 * 1024 * 1024;
export const historyRecordSchema = z.object({ data: z.string().max(65_536), nextOffset: position.nullable(), cursor: position });
export const runtimeInfoSchema = z.lazy(() => z.object({ id: idSchema, name: z.string(), online: z.boolean(), message: z.string(), capabilities: capabilitiesSchema, busy: position.optional(), busyKnown: z.boolean() }));
export const snapshotSchema = z.lazy(() => z.object({ device: z.object({ id: idSchema, name: z.string() }), sessions: z.array(sessionSchema), approvals: z.array(approvalSchema), questions: z.array(questionSchema), runtimes: z.array(runtimeInfoSchema), cursor: position }));
export const inboxPageSchema = z.lazy(() => z.object({ items: z.array(z.object({ position, approval: approvalSchema, sessionTitle: z.string() })), nextBefore: position.nullable(), cursor: position }));
export const requestResultSchema = z.lazy(() => z.discriminatedUnion('state', [z.object({ state: z.literal('completed'), response: responseSchema }), z.object({ state: z.enum(['not_found', 'pending', 'unknown']) })]));
const acceptedSchema = z.object({ accepted: z.literal(true) });
/** Every public method must have a runtime success validator. Responses must satisfy the current contract; missing required fields are rejected. */
export const methodResultSchemas = {
  'system.snapshot': snapshotSchema,
  'request.result': requestResultSchema,
  'inbox.page': inboxPageSchema,
  'notifications.status': notificationStatusSchema,
  'notifications.subscribe': notificationStatusSchema,
  'notifications.unsubscribe': notificationStatusSchema,
  'workspace.list': z.lazy(() => workspaceListingSchema),
  'workspace.mkdir': z.lazy(() => workspaceListingSchema),
  'session.create': z.lazy(() => sessionSchema),
  'session.resume': z.lazy(() => sessionSchema),
  'session.rename': z.lazy(() => sessionSchema),
  'session.archive': z.lazy(() => sessionSchema),
  'session.message': z.lazy(() => z.object({ accepted: z.literal(true), messageId: idSchema, queued: z.boolean() })),
  'session.image': imageChunkSchema,
  'session.cancel': acceptedSchema,
  'session.queueAction': acceptedSchema,
  'session.queue': z.lazy(() => z.object({ items: z.array(queueItemViewSchema) })),
  'session.setModel': z.lazy(() => sessionSchema),
  'model.catalog': z.lazy(() => modelCatalogSchema),
  'approval.decide': acceptedSchema,
  'question.answer': acceptedSchema,
  'session.autoApprove': z.object({ enabled: z.boolean() }),
  'history.page': historyPageSchema,
  'history.record': historyRecordSchema,
  'events.list': z.lazy(() => z.object({ events: z.array(eventSchema), cursor: position })),
  'subagent.list': z.lazy(() => z.object({ subagents: z.array(subagentViewSchema) })),
  'subagent.history': z.lazy(() => subagentHistoryPageSchema),
} satisfies Record<Method, z.ZodTypeAny>;
export type MethodParams<M extends Method> = z.input<(typeof methodSchemas)[M]>;
export type MethodResult<M extends Method> = z.output<(typeof methodResultSchemas)[M]>;
export type MethodArgs<M extends Method> = {} extends MethodParams<M> ? [params?: MethodParams<M>, id?: string] : [params: MethodParams<M>, id?: string];
export function parseMethodResult<M extends Method>(method: M, value: unknown): MethodResult<M> {
  return methodResultSchemas[method].parse(value) as MethodResult<M>;
}
