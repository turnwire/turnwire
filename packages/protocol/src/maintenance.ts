import { z } from 'zod';

/** Local administration only; never an RPC available to paired devices. */
export const maintenanceRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('begin'), token: z.string().min(1).max(200).optional() }).strict(),
  z.object({ action: z.literal('cancel'), token: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('compact'), token: z.string().min(1).max(200) }).strict(),
]);
export type MaintenanceRequest = z.infer<typeof maintenanceRequestSchema>;
export const maintenanceStatusSchema = z.object({
  state: z.enum(['accepting', 'draining', 'ready']),
  scope: z.literal('turnwire-managed'),
  token: z.string().optional(),
  inFlight: z.number().int().nonnegative(),
  busy: z.number().int().nonnegative().nullable(),
  reason: z.string().optional(),
}).strict();
export type MaintenanceStatus = z.infer<typeof maintenanceStatusSchema>;
