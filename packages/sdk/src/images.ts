import { base64Bytes, imageChunkSchema, isCanonicalBase64, MAX_IMAGE_BASE64_LENGTH, MAX_IMAGE_CHUNK_LENGTH, methodSchemas } from '@turnwire/protocol';
import type { ImageAttachment, ImageInput } from '@turnwire/protocol';
import { call, type RpcClient } from './index.js';

export interface LoadImageArgs { sessionId: string; attachmentId: string }
export interface SendImageMessageArgs { sessionId: string; text: string; images: ImageInput[]; steer?: boolean }

/** Shared across local and encrypted remote transports; validate before sending bytes. */
export async function sendImageMessage(client: RpcClient, args: SendImageMessageArgs) {
  return call(client, 'session.message', methodSchemas['session.message'].parse(args));
}

/** Explicit, bounded retrieval. Transcript/history projections never fetch image bytes. */
export async function loadImage(client: RpcClient, args: LoadImageArgs): Promise<{ attachment: ImageAttachment; data: string }> {
  const scope = methodSchemas['session.image'].parse(args);
  const chunks: string[] = [];
  let attachment: ImageAttachment | undefined;
  let offset = 0;
  for (;;) {
    const chunk = imageChunkSchema.parse(await call(client, 'session.image', { sessionId: scope.sessionId, attachmentId: scope.attachmentId, offset, limit: MAX_IMAGE_CHUNK_LENGTH }));
    if (chunk.attachment.attachmentId !== scope.attachmentId) throw new Error('Image response identity mismatch');
    if (attachment && (chunk.attachment.mediaType !== attachment.mediaType || chunk.attachment.bytes !== attachment.bytes || chunk.attachment.width !== attachment.width || chunk.attachment.height !== attachment.height || chunk.attachment.name !== attachment.name)) throw new Error('Image response metadata changed');
    attachment ??= chunk.attachment;
    const next = offset + chunk.data.length;
    if (chunk.offset !== offset || !chunk.data.length || (chunk.nextOffset !== null && chunk.nextOffset !== next)) throw new Error('Image chunks must have contiguous advancing offsets');
    if (next > MAX_IMAGE_BASE64_LENGTH) throw new Error('Image exceeds normalized base64 limit');
    const expectedLength = Math.ceil(attachment.bytes / 3) * 4;
    if (next > expectedLength || (chunk.nextOffset !== null && next >= expectedLength)) throw new Error('Image chunk length exceeds attachment metadata');
    chunks.push(chunk.data);
    offset = next;
    if (chunk.nextOffset === null) {
      const data = chunks.join('');
      if (!isCanonicalBase64(data) || base64Bytes(data) !== attachment.bytes) throw new Error('Invalid canonical image data or byte length');
      return { attachment, data };
    }
  }
}
