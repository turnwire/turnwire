import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { imageInputSchema, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TOTAL_IMAGE_BYTES } from '@turnwire/protocol';
import type { ImageInput } from '@turnwire/protocol';
import { t } from './i18n.js';

// Bound the allocation and every read, including files that grow after stat.
const maxBytes = MAX_IMAGE_BYTES;
export async function readImageInputs(paths: string[]): Promise<ImageInput[]> {
  if (paths.length > MAX_IMAGES) throw new Error(t('images.count'));
  const images: ImageInput[] = [];
  let total = 0;
  for (const path of paths) {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) throw new Error(t('images.local'));
    const target = resolve(path);
    const info = await stat(target);
    if (!info.isFile()) throw new Error(t('images.file'));
    if (info.size > maxBytes) throw new Error(t('images.size'));
    const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const opened = await file.stat();
      if (!opened.isFile()) throw new Error(t('images.file'));
      if (opened.size > maxBytes) throw new Error(t('images.size'));
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxBytes) throw new Error(t('images.size'));
      bytes = buffer.subarray(0, length);
    } finally { await file.close(); }
    total += bytes.length;
    if (total > MAX_TOTAL_IMAGE_BYTES) throw new Error(t('images.total'));
    const mediaType = imageMediaType(bytes);
    if (!mediaType) throw new Error(t('images.type'));
    images.push(imageInputSchema.parse({ mediaType, data: bytes.toString('base64'), name: basename(target) }));
  }
  return images;
}

function imageMediaType(bytes: Buffer): ImageInput['mediaType'] | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  return undefined;
}

/** Deliberately render metadata only, never inline input data or host paths. */
export function imageSummary(images?: readonly { mediaType: string; name?: string }[]): string {
  return images?.length ? '\n' + t('images.attached', { count: images.length }) + images.map(image => `\n  ${image.name ?? image.mediaType} (${image.mediaType})`).join('') : '';
}
