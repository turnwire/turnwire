import { afterEach, expect, it, vi } from 'vitest';
import { DshRuntime, mapEvent } from '@turnwire/runtime-dsh';
import { MAX_IMAGE_BASE64_LENGTH, TurnwireError } from '@turnwire/protocol';
import { historyRecords } from '../packages/runtime-dsh/src/history.js';

const image = { mediaType: 'image/png' as const, data: 'aGVsbG8=', name: 'sample.png' };
const attachment = { attachmentId: 'a'.repeat(64), mediaType: 'image/png' as const, bytes: 5, width: 1, height: 1, name: 'sample.png' };
const event = { type: 'user/message', seq: 1, time: 1, data: { id: 'native', source: { kind: 'user', rpcId: 'm' }, content: [{ type: 'image', attachment: { ...attachment, data: 'SECRET' } }] } };
const runtimes: DshRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose(); vi.useRealTimers(); });
function fixture() {
  const runtime = new DshRuntime({ url: 'http://127.0.0.1:1', token: 'test' }); runtimes.push(runtime);
  // Replace only transport boundaries, exercising the actual send/echo/mapper lifecycle.
  const internal = runtime as unknown as { connect(): Promise<void>; follow(id: string): void; rpc(endpoint: string, args: unknown): Promise<unknown>; durable(id: string, value: { type: string; seq: number; time: number; data: Record<string, unknown> }): void };
  vi.spyOn(internal, 'connect').mockResolvedValue(); vi.spyOn(internal, 'follow').mockImplementation(() => {});
  const rpc = vi.spyOn(internal, 'rpc');
  return { runtime, internal, rpc };
}
it('maps native image references, strips bytes, and retains image-only child history placeholders', () => {
  expect(mapEvent('s', event)).toEqual([{ type: 'message.user', messageId: 'm', text: '', images: [attachment] }]);
  expect(JSON.stringify(mapEvent('s', event))).not.toContain('SECRET');
  expect(historyRecords('child', [event])[0]?.text).toBe('[Image attachment]');
  const raw = { ...event, data: { ...event.data, content: [{ type: 'image', data: 'SECRET', mediaType: 'image/png' }] } };
  expect(JSON.stringify(mapEvent('s', raw))).not.toContain('SECRET');
  expect(mapEvent('s', raw)[0]).toMatchObject({ text: '[Image attachment]' });
});
it.each(['before', 'after'] as const)('returns refs when native echo arrives %s prompt RPC acceptance', async order => {
  const { runtime, internal, rpc } = fixture();
  let accept!: () => void;
  rpc.mockImplementation(async () => { if (order === 'before') internal.durable('s', event); else await new Promise<void>(resolve => { accept = resolve; }); return { accepted: true }; });
  let settled = false;
  const sent = runtime.sendMessage('s', { id: 'm', text: '', images: [image] }).then(refs => { settled = true; return refs; });
  await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
  if (order === 'after') { accept(); await Promise.resolve(); expect(settled).toBe(false); internal.durable('s', event); }
  expect(await sent).toEqual([attachment]);
  expect(rpc).toHaveBeenCalledWith('session/prompt', { request: { requestId: 'm', sessionId: 's', mode: 'queue', content: [{ type: 'text', text: '' }, { type: 'image', ...image }] } });
  expect(runtime.capabilities().imageInput).toBe(true);
});
it('returns admitted inbox refs before a queued prompt is consumed, including replay behind cursor', async () => {
  const { runtime, internal, rpc } = fixture();
  internal.durable('s', { ...event, seq: 10 });
  rpc.mockImplementation(async () => { internal.durable('s', { type: 'agent/inbox/spliced', seq: 1, time: 1, data: { inserted: [event.data] } }); return { accepted: true }; });
  await expect(runtime.sendMessage('s', { id: 'm', text: '', images: [image] })).resolves.toEqual([attachment]);
});
it('rejects incomplete native refs with unknown outcome rather than a partial success', async () => {
  const { runtime, internal, rpc } = fixture();
  rpc.mockImplementation(async () => { internal.durable('s', event); return { accepted: true }; });
  await expect(runtime.sendMessage('s', { id: 'm', text: '', images: [image, image] })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
});
it('passes through authoritative model rejection and removes pending image waiters', async () => {
  const { runtime, rpc } = fixture();
  rpc.mockRejectedValue(new TurnwireError('session/attachment-invalid', 'Model does not support image input'));
  await expect(runtime.sendMessage('s', { id: 'm', text: '', images: [image] })).rejects.toMatchObject({ code: 'session/attachment-invalid' });
  await expect(runtime.sendMessage('s', { id: 'm', text: '', images: [image] })).rejects.toMatchObject({ code: 'session/attachment-invalid' });
});
it('rejects malformed and oversized input before sending any RPC', async () => {
  const { runtime, rpc } = fixture();
  for (const data of ['aGVsbG8', 'aGVsbG8=\n', 'A'.repeat(MAX_IMAGE_BASE64_LENGTH + 4)]) await expect(runtime.sendMessage('s', { id: 'm', text: '', images: [{ ...image, data }] })).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
it('enforces direct adapter image count, text and aggregate byte limits', async () => {
  const { runtime, rpc } = fixture();
  await expect(runtime.sendMessage('s', { id: 'm', text: '', images: [image, image, image] })).rejects.toThrow();
  await expect(runtime.sendMessage('s', { id: 'm', text: 'x'.repeat(16_001), images: [image] })).rejects.toThrow();
  const large = { ...image, data: Buffer.alloc(262_145).toString('base64') };
  await expect(runtime.sendMessage('s', { id: 'm', text: '', images: [large, large] })).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
it('uses installed session attachment contract and verifies identity, bytes, canonical base64 and cap', async () => {
  const { runtime, rpc } = fixture();
  rpc.mockResolvedValue({ attachment: { ...attachment, data: 'SECRET' }, data: image.data });
  expect(await runtime.readImage('s', attachment.attachmentId)).toEqual({ attachment, data: image.data });
  expect(rpc).toHaveBeenCalledWith('session/attachment', { request: { sessionId: 's', attachmentId: attachment.attachmentId } });
  for (const response of [{ attachment, data: 'aGVsbG8' }, { attachment: { ...attachment, bytes: 6 }, data: image.data }, { attachment: { ...attachment, attachmentId: 'b'.repeat(64) }, data: image.data }, { attachment, data: 'A'.repeat(MAX_IMAGE_BASE64_LENGTH + 4) }]) {
    rpc.mockResolvedValue(response); await expect(runtime.readImage('s', attachment.attachmentId)).rejects.toThrow();
  }
});
it('fails closed on missing echo and disconnect instead of returning an imageless success', async () => {
  vi.useFakeTimers(); const { runtime, rpc } = fixture(); rpc.mockResolvedValue({ accepted: true });
  const sent = runtime.sendMessage('s', { id: 'm', text: '', images: [image] });
  const rejected = expect(sent).rejects.toThrow('durable references');
  await vi.advanceTimersByTimeAsync(10_001); await rejected;
  const next = runtime.sendMessage('s', { id: 'm2', text: '', images: [image] });
  const disconnected = expect(next).rejects.toThrow('disconnected');
  await vi.advanceTimersByTimeAsync(0); await runtime.dispose(); await disconnected;
});
