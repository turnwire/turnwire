import { describe, expect, it, vi } from 'vitest';
import { conversation, loadImage, sendImageMessage, transcriptMarkdown, type RpcClient } from '../packages/sdk/src/index.js';
import { MAX_IMAGE_BASE64_LENGTH, MAX_IMAGE_CHUNK_LENGTH, type Session, type TurnwireEvent } from '../packages/protocol/src/index.js';

const attachment = { attachmentId: 'image-1', mediaType: 'image/png' as const, bytes: 4, width: 1, height: 1, name: 'photo.png' };
const args = { sessionId: 'session-1', attachmentId: attachment.attachmentId };
const chunk = { attachment, data: 'YWJjZA==', offset: 0, nextOffset: null };
function client(...chunks: unknown[]) {
  const request = vi.fn();
  for (const value of chunks) request.mockResolvedValueOnce(value);
  return { request } as RpcClient & { request: typeof request };
}

describe('shared image helpers', () => {
  it('loads and validates contiguous chunks using only RpcClient', async () => {
    const c = client({ ...chunk, data: 'YWJ', nextOffset: 3 }, { ...chunk, data: 'jZA==', offset: 3 });
    expect(await loadImage(c, args)).toEqual({ attachment, data: chunk.data });
    expect(c.request.mock.calls).toEqual([
      ['session.image', { ...args, offset: 0, limit: MAX_IMAGE_CHUNK_LENGTH }],
      ['session.image', { ...args, offset: 3, limit: MAX_IMAGE_CHUNK_LENGTH }],
    ]);
  });

  it.each([
    { ...chunk, offset: 1 },
    { ...chunk, nextOffset: 0 },
    { ...chunk, nextOffset: 9 },
    { ...chunk, data: '', nextOffset: 0 },
    { ...chunk, data: 'YWJjZB==' }, // nonzero pad bits
    { ...chunk, data: 'YWJjZA= ' },
    { ...chunk, data: 'YWJj' }, // truncated final data
    { ...chunk, attachment: { ...attachment, attachmentId: 'other' } },
    { ...chunk, attachment: { ...attachment, bytes: 3 } },
    { ...chunk, attachment: { ...attachment, width: 0 } },
    { ...chunk, attachment: { ...attachment, bytes: MAX_IMAGE_BASE64_LENGTH } },
    { ...chunk, data: 'A'.repeat(MAX_IMAGE_CHUNK_LENGTH + 1) },
    { ...chunk, nextOffset: MAX_IMAGE_BASE64_LENGTH + 1 },
    { ...chunk, extra: true },
  ])('rejects invalid response %#', async invalid => {
    await expect(loadImage(client(invalid), args)).rejects.toThrow();
  });

  it.each([
    { mediaType: 'image/jpeg' }, { bytes: 5 }, { width: 2 }, { height: 2 }, { name: 'changed.png' }, { name: undefined },
  ])('rejects changing attachment metadata %#', async change => {
    await expect(loadImage(client({ ...chunk, data: 'YWJj', nextOffset: 4 }, { ...chunk, attachment: { ...attachment, ...change }, data: 'ZA==', offset: 4 }), args)).rejects.toThrow('metadata');
  });

  it('accepts the normalized cap and refuses further chunks at the cap', async () => {
    const metadata = { ...attachment, bytes: MAX_IMAGE_BASE64_LENGTH / 4 * 3 };
    const chunks = Array.from({ length: MAX_IMAGE_BASE64_LENGTH / MAX_IMAGE_CHUNK_LENGTH }, (_, i) => ({ attachment: metadata, data: 'A'.repeat(MAX_IMAGE_CHUNK_LENGTH), offset: i * MAX_IMAGE_CHUNK_LENGTH, nextOffset: (i + 1) * MAX_IMAGE_CHUNK_LENGTH === MAX_IMAGE_BASE64_LENGTH ? null : (i + 1) * MAX_IMAGE_CHUNK_LENGTH }));
    expect((await loadImage(client(...chunks), args)).data.length).toBe(MAX_IMAGE_BASE64_LENGTH);
    chunks[chunks.length - 1]!.nextOffset = MAX_IMAGE_BASE64_LENGTH;
    const c = client(...chunks);
    await expect(loadImage(c, args)).rejects.toThrow();
    expect(c.request).toHaveBeenCalledTimes(chunks.length);
  });

  it('validates and sends image-only steer messages through a generic client', async () => {
    const c = client({ accepted: true });
    const input = { sessionId: args.sessionId, text: '', images: [{ mediaType: 'image/png' as const, data: chunk.data, name: attachment.name }], steer: true };
    expect(await sendImageMessage(c, input)).toEqual({ accepted: true });
    expect(c.request).toHaveBeenCalledWith('session.message', input);
    expect(() => sendImageMessage(c, { ...input, images: [{ ...input.images[0]!, data: 'invalid' }] })).toThrow();
    expect(c.request).toHaveBeenCalledTimes(1);
  });
});

it('preserves image-only metadata across queue updates and transcript export without bytes', () => {
  const events = [
    { seq: 1, data: { type: 'message.user', sessionId: args.sessionId, messageId: 'm', text: '', queued: true, images: [{ ...attachment, data: chunk.data }] } },
    { seq: 2, data: { type: 'message.updated', sessionId: args.sessionId, messageId: 'm', queued: false, text: 'Updated caption' } },
  ].map(event => ({ ...event, time: '2026-01-01T00:00:00Z' })) as TurnwireEvent[];
  const projected = conversation(events, args.sessionId);
  expect(projected).toHaveLength(1);
  expect(projected[0]).toMatchObject({ role: 'user', text: 'Updated caption', queued: false, images: [attachment] });
  expect(JSON.stringify(projected)).not.toContain(chunk.data);
  const markdown = transcriptMarkdown({ id: args.sessionId, cwd: '/workspace', title: 'Images' } as Session, projected);
  for (const value of [attachment.attachmentId, attachment.mediaType, attachment.name, '"bytes": 4', '"width": 1', '"height": 1']) expect(markdown).toContain(value);
  expect(markdown).not.toContain(chunk.data);
  expect(conversation(events.slice(0, 1), args.sessionId)[0]).toMatchObject({ text: '', images: [attachment] });
});
