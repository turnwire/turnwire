import { z } from 'zod';

export const MAX_IMAGES = 2;
export const MAX_IMAGE_BYTES = 256 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 512 * 1024;
export const MAX_IMAGE_TEXT_LENGTH = 16_000;
/** Normalized runtime output, measured in base64 characters, not decoded bytes. */
export const MAX_IMAGE_BASE64_LENGTH = 16 * 1024 * 1024;
export const MAX_IMAGE_CHUNK_LENGTH = 131_072;
export const imageMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export function base64Bytes(data: string): number { return data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0); }
/** Checks padding and zero pad bits without requiring Node's Buffer in browser clients. */
export function isCanonicalBase64(data: string): boolean {
  if (!data.length || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  return data.endsWith('==') ? (alphabet.indexOf(data[data.length - 3]!) & 15) === 0 : data.endsWith('=') ? (alphabet.indexOf(data[data.length - 2]!) & 3) === 0 : true;
}
const nameSchema = z.string().min(1).max(255);
export const imageInputSchema = z.object({
  mediaType: imageMediaTypeSchema,
  data: z.string().min(4).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4).refine(isCanonicalBase64, 'Image data must be canonical base64').refine(data => base64Bytes(data) <= MAX_IMAGE_BYTES, 'Image exceeds 256 KiB'),
  name: nameSchema.optional(),
}).strict();
export type ImageInput = z.infer<typeof imageInputSchema>;
export const imageAttachmentSchema = z.object({
  attachmentId: z.string().min(1).max(200), mediaType: imageMediaTypeSchema,
  bytes: z.number().int().positive().max(MAX_IMAGE_BASE64_LENGTH / 4 * 3),
  width: z.number().int().positive(), height: z.number().int().positive(), name: nameSchema.optional(),
}).strict();
export type ImageAttachment = z.infer<typeof imageAttachmentSchema>;
export const imageChunkSchema = z.object({ attachment: imageAttachmentSchema, data: z.string().max(MAX_IMAGE_CHUNK_LENGTH), offset: z.number().int().nonnegative().max(MAX_IMAGE_BASE64_LENGTH), nextOffset: z.number().int().nonnegative().max(MAX_IMAGE_BASE64_LENGTH).nullable() }).strict();
export type ImageChunk = z.infer<typeof imageChunkSchema>;
