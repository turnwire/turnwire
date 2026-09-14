import { expect, it } from 'vitest';
import { TurnwireCore, Store } from '@turnwire/core';
import { DemoRuntime } from '@turnwire/runtime';
import type { ImageAttachment, ImageInput, Session } from '@turnwire/protocol';
import { LocalClient, RemoteClient, loadImage, loadHistory, conversation } from '@turnwire/sdk';
import { randomSecret } from '@turnwire/wire';
import { startDaemonServer } from '../apps/daemon/src/server.js';
import { startRelay } from '../apps/relay/src/server.js';
import { RemoteBridge } from '../apps/daemon/src/remote.js';

it('sends bounded image bytes remotely, stores only refs and reads session-scoped chunks locally', async () => {
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=';
  const image: ImageAttachment = { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: Buffer.from(data, 'base64').length, width: 1, height: 1, name: 'pixel.png' };
  class ImageRuntime extends DemoRuntime {
    calls = 0;
    override capabilities() { return { ...super.capabilities(), imageInput: true }; }
    override async sendMessage(_id: string, input: { id: string; text: string; images?: ImageInput[] }) { this.calls++; expect(input.images?.[0]?.data).toBe(data); return [image]; }
    async readImage(_id: string, attachmentId: string) { expect(attachmentId).toBe(image.attachmentId); return { attachment: image, data }; }
  }
  const runtime = new ImageRuntime();
  const core = new TurnwireCore(new Store(':memory:'), [runtime], { id: 'host', name: 'Host' });
  const token = randomSecret(); const server = await startDaemonServer({ core, token, port: 0 });
  const local = new LocalClient(`http://127.0.0.1:${server.port}`, token);
  const relayToken = randomSecret(); const relay = await startRelay({ token: relayToken, port: 0 });
  const pairing = { v: 2 as const, hostId: 'host', clientId: 'phone', name: 'Phone', relayUrl: `ws://127.0.0.1:${relay.port}`, token: randomSecret(), key: randomSecret() };
  core.store.addDevice(pairing); const bridge = new RemoteBridge(core, pairing.relayUrl, relayToken); bridge.start();
  const remote = new RemoteClient(pairing);
  try {
    await expect.poll(() => bridge.connected).toBe(true);
    const session = await local.call('session.create', { runtimeId: 'demo', title: 'Images', cwd: process.cwd() });
    const other = await local.call('session.create', { runtimeId: 'demo', title: 'Other', cwd: process.cwd() });
    await remote.call('session.message', { sessionId: session.id, text: '', images: [{ mediaType: 'image/png', name: 'pixel.png', data }] });
    const history = await loadHistory(local, session.id);
    expect(conversation(history, session.id)).toMatchObject([{ role: 'user', text: '', images: [image] }]);
    expect(JSON.stringify(history)).not.toContain(data);
    expect(await loadImage(local, { sessionId: session.id, attachmentId: image.attachmentId })).toEqual({ attachment: image, data });
    expect(await loadImage(remote, { sessionId: session.id, attachmentId: image.attachmentId })).toEqual({ attachment: image, data });
    await expect(loadImage(remote, { sessionId: other.id, attachmentId: image.attachmentId })).rejects.toThrow();
    // @ts-expect-error Deliberately send an unsupported media type to verify runtime rejection.
    await expect(remote.call('session.message', { sessionId: session.id, text: '', images: [{ mediaType: 'image/svg+xml', data }] })).rejects.toThrow();
    expect(runtime.calls).toBe(1);
  } finally { remote.close(); local.close(); await bridge.close(); await relay.close(); await server.close(); await core.dispose(); }
});
