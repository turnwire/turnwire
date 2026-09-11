import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalClient } from '@turnwire/sdk';
import { createProgram } from '../apps/cli/src/program.js';
import { runTui } from '../apps/cli/src/terminal.js';
import { imageSummary } from '../apps/cli/src/images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'turnwire-cli-images-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
async function file(name = 'tiny raster.png', bytes: Buffer = png) { const path = join(directory, name); await writeFile(path, bytes); return path; }
function setup(imageInput: boolean | undefined = true) {
  const snapshot = { sessions: [{ id: 's', runtimeId: 'runtime' }], runtimes: [{ id: 'runtime', capabilities: { imageInput } }] };
  const request = vi.spyOn(LocalClient.prototype, 'request').mockImplementation(async method => method === 'system.snapshot' ? snapshot : { accepted: true });
  const close = vi.spyOn(LocalClient.prototype, 'close').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const dispatch = (args: string[], lang = 'en', json = true) => createProgram({ url: 'http://localhost:1', token: 'test', lang, json }).parseAsync(args, { from: 'user' });
  return { request, close, log, dispatch };
}
it('sends text and locally read bytes with signature MIME, basename and steer, never prints base64', async () => {
  const { request, log, close, dispatch } = setup();
  const path = await file('misleading.jpg');
  await dispatch(['send', 's', 'Look', '--image', path, '--steer']);
  expect(request).toHaveBeenLastCalledWith('session.message', { sessionId: 's', text: 'Look', steer: true, images: [{ mediaType: 'image/png', data: png.toString('base64'), name: 'misleading.jpg' }] });
  expect(log.mock.calls.flat().join('')).not.toContain(png.toString('base64'));
  expect(close).toHaveBeenCalledOnce();
});
it.each([false, true])('supports image-only messages and multiple images (repeat flags: %s)', async repeat => {
  const { request, dispatch } = setup();
  const first = await file(); const second = await file('tiny.gif', gif);
  await dispatch(['send', 's', '--image', first, ...(repeat ? ['--image'] : []), second]);
  expect(request).toHaveBeenLastCalledWith('session.message', { sessionId: 's', text: '', images: [{ name: 'tiny raster.png', mediaType: 'image/png', data: png.toString('base64') }, { name: 'tiny.gif', mediaType: 'image/gif', data: gif.toString('base64') }] });
});
it.each([
  ['jpeg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9])],
  ['webp', 'image/webp', Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')],
])('recognizes %s signatures without extension-based MIME guessing', async (extension, mediaType, bytes) => {
  const { request, dispatch } = setup();
  await dispatch(['send', 's', '--image', await file(`raster.${extension}`, bytes as Buffer)]);
  expect(request).toHaveBeenLastCalledWith('session.message', expect.objectContaining({ images: [expect.objectContaining({ mediaType })] }));
});
it('keeps ordinary send payload and does not require a capability snapshot', async () => {
  const { request, dispatch } = setup();
  await dispatch(['send', 's', ' ordinary text ']);
  expect(request).toHaveBeenCalledExactlyOnceWith('session.message', { sessionId: 's', text: ' ordinary text ' });
});
it('rejects count, size, unsupported signature, missing files, directories, URLs and long text before any request', async () => {
  const { request, dispatch } = setup();
  const path = await file();
  const huge = await file('huge.png', Buffer.alloc(256 * 1024 + 1));
  const fake = await file('fake.png', Buffer.from('<svg></svg>'));
  for (const [args, error] of [
    [['send', 's', '--image', path, path, path], /at most 2/],
    [['send', 's', '--image', huge], /256 KiB.*Resize/],
    [['send', 's', '--image', fake], /signature/],
    [['send', 's', '--image', join(directory, 'missing.png')], /ENOENT/],
    [['send', 's', '--image', directory], /regular local file/],
    [['send', 's', '--image', 'https:\/\/host/image.png'], /local files/],
    [['send', 's', 'a'.repeat(16001), '--image', path], /16000/],
    [['send', 's'], /Provide text/],
  ] as const) await expect(dispatch([...args])).rejects.toThrow(error);
  expect(request).not.toHaveBeenCalled();
});
it.each([false, undefined])('rejects unsupported or absent runtime image capability (%s)', async capability => {
  const { request, close, dispatch } = setup(false);
  request.mockResolvedValueOnce({ sessions: [{ id: 's', runtimeId: 'runtime' }], runtimes: [{ id: 'runtime', capabilities: capability === undefined ? {} : { imageInput: false } }] });
  await expect(dispatch(['send', 's', '--image', await file()])).rejects.toThrow(/transport support/);
  expect(request).toHaveBeenCalledExactlyOnceWith('system.snapshot');
  expect(close).toHaveBeenCalledOnce();
});
it('accepts the exact per-image, total and image-text boundaries', async () => {
  const { request, dispatch } = setup();
  const bytes = Buffer.alloc(256 * 1024); png.copy(bytes);
  const path = await file('boundary.png', bytes);
  await dispatch(['send', 's', 'a'.repeat(16000), '--image', path, path]);
  expect(request).toHaveBeenLastCalledWith('session.message', expect.objectContaining({ images: [expect.objectContaining({ data: bytes.toString('base64') }), expect.objectContaining({ data: bytes.toString('base64') })] }));
});
it('propagates send errors and still closes the SDK connection', async () => {
  const { request, close, dispatch } = setup();
  request.mockRejectedValueOnce(new Error('Host unavailable'));
  await expect(dispatch(['send', 's', '--image', await file()])).rejects.toThrow('Host unavailable');
  expect(close).toHaveBeenCalledOnce();
});
it('dispatches quoted local image paths and image-only sends through TUI', async () => {
  const { request, dispatch } = setup();
  const path = await file();
  const lines = [`send s --image "${path}"`, 'quit'];
  const output: string[] = [];
  await runTui(dispatch, '', { ask: async () => lines.shift(), write: text => output.push(text) });
  expect(request).toHaveBeenLastCalledWith('session.message', expect.objectContaining({ text: '', images: [expect.objectContaining({ name: 'tiny raster.png' })] }));
});
it('provides English and Chinese help, localized limits, and metadata-only summaries', async () => {
  const { dispatch } = setup();
  for (const lang of ['en', 'zh']) {
    const program = createProgram({ lang });
    const help = program.commands.find(command => command.name() === 'send')!.helpInformation();
    expect(help).toContain('--image <path...>'); expect(help).toContain('256 KiB'); expect(help).toContain('[text]');
  }
  await expect(dispatch(['send', 's'], 'zh')).rejects.toThrow('请提供文字');
  expect(imageSummary([{ mediaType: 'image/png', name: 'tiny.png' }])).toContain('1 张图片附件');
  expect(imageSummary()).toBe('');
});
it('acknowledges image-only live messages while attached', async () => {
  const { request, log, close, dispatch } = setup();
  request.mockResolvedValueOnce({ sessions: [{ id: 's' }] }).mockResolvedValueOnce({ events: [], cursor: 0, hasMore: false, nextBefore: null });
  const unsubscribe = vi.fn();
  vi.spyOn(LocalClient.prototype, 'subscribe').mockImplementation(handler => {
    setImmediate(() => {
      handler({ seq: 1, time: 'now', data: { type: 'message.user', sessionId: 's', messageId: 'm', text: '', images: [{ attachmentId: 'a', mediaType: 'image/png', name: 'live.png', bytes: png.length, width: 1, height: 1 }] } });
      process.emit('SIGINT');
    });
    return unsubscribe;
  });
  await dispatch(['attach', 's'], 'en', false);
  expect(log.mock.calls.flat().join('')).toContain('[1 image attachment(s)]');
  expect(log.mock.calls.flat().join('')).toContain('live.png');
  expect(unsubscribe).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});
it('acknowledges image-only records in human history without exposing image input bytes', async () => {
  const { request, log, dispatch } = setup();
  request.mockResolvedValue({ events: [{ seq: 1, time: 'now', data: { type: 'message.user', sessionId: 's', messageId: 'm', text: '', images: [{ attachmentId: 'a', name: 'tiny.png', mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }] } }], cursor: 1, hasMore: false, nextBefore: null });
  await dispatch(['history', 's'], 'en', false);
  expect(log.mock.calls.flat().join('')).toContain('[1 image attachment(s)]');
  expect(log.mock.calls.flat().join('')).toContain('tiny.png');
});
