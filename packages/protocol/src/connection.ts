import { z } from 'zod';

const secret = z.string().regex(/^[a-f0-9]{64}$/);
const publicKey = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(200);
export const clientHelloSchema = z.object({ type: z.literal('hello'), v: z.literal(2), nonce: secret, publicKey, proofs: z.array(secret).min(1).max(2) }).strict();
export const serverHelloSchema = z.object({ type: z.literal('hello.reply'), v: z.literal(2), nonce: secret, publicKey, proof: secret, credential: z.number().int().min(0).max(1) }).strict();
export const sessionPayloadSchema = z.object({ v: z.literal(2), session: secret, sequence: z.string().regex(/^(0|[1-9][0-9]{0,19})$/), ciphertext: z.string().max(2_800_000) }).strict();
export type ClientHello = z.infer<typeof clientHelloSchema>;
export type ServerHello = z.infer<typeof serverHelloSchema>;
export type SessionPayload = z.infer<typeof sessionPayloadSchema>;

export const directConfigurationSchema = z.object({ enabled: z.boolean(), url: z.string().url().max(2000).optional(), listenHost: z.string().min(1).max(200).optional(), port: z.number().int().min(0).max(65535).optional(), certificatePath: z.string().min(1).max(4096).optional(), privateKeyPath: z.string().min(1).max(4096).optional() }).strict();
export type DirectConfiguration = z.infer<typeof directConfigurationSchema>;
export const directStatusSchema = z.object({ enabled: z.boolean(), state: z.enum(['off', 'starting', 'online', 'error']), message: z.string(), url: z.string().optional(), candidates: z.array(z.string()), configuration: directConfigurationSchema });
export type DirectStatus = z.infer<typeof directStatusSchema>;
export const pushSubscriptionSchema = z.object({ endpoint: z.string().url().max(4096), keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/).min(80).max(100), auth: z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/).min(20).max(30) }).strict() }).strict();
export type PushSubscriptionData = z.infer<typeof pushSubscriptionSchema>;
export const notificationStatusSchema = z.object({ enabled: z.boolean(), available: z.boolean(), subscribed: z.boolean(), message: z.string(), publicKey: z.string().optional(), queued: z.number().int().nonnegative(), lastError: z.string().optional() });
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;
