import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { Store, TurnwireCore } from '@turnwire/core';
import type { Pairing } from '@turnwire/protocol';
import { createClientHandshake, randomSecret, secureMessage, SessionChannel } from '@turnwire/wire';
import { DirectController } from '../apps/daemon/src/direct.js';
import { RemoteBridge } from '../apps/daemon/src/remote.js';
import { startRelay } from '../apps/relay/src/server.js';
import { hermeticEnv } from './helpers/hermetic-env.mjs';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function connect(url: string, pairing: Pairing, ca?: Buffer, credentials = [pairing.key]) {
  const socket = new WebSocket(url, ca ? { ca } : {}); cleanup.push(() => socket.terminate());
  const messages: Record<string, unknown>[] = []; let closed = false;
  socket.on('message', raw => { messages.push(JSON.parse(raw.toString())); }); socket.on('close', () => { closed = true; }); socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const take = async (type: string) => { await vi.waitFor(() => expect(messages.some(message => message.type === type)).toBe(true), { timeout: 5000 }); return messages.splice(messages.findIndex(message => message.type === type), 1)[0]!; };
  socket.send(JSON.stringify({ kind: 'client', hostId: pairing.hostId, clientId: pairing.clientId, token: pairing.token })); await take('ready');
  const hello = await createClientHandshake(credentials, `${pairing.hostId}:${pairing.clientId}`);
  const send = (payload: unknown) => socket.send(JSON.stringify({ type: 'payload', payload })); send(hello.hello);
  const channel = await hello.complete((await take('payload')).payload);
  return { channel, messages, send, take, isClosed: () => closed };
}

it.each([false, true])('arbitrates concurrent real Relay + TLS Direct enrollment, same key %s', async same => {
  const directory = await mkdtemp(join(tmpdir(), 'turnwire-enrollment-race-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const cert = join(directory, 'cert.pem'), privateKey = join(directory, 'key.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', privateKey, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { env: hermeticEnv(directory), timeout: 10000 });
  const ca = await readFile(cert);
  const core = new TurnwireCore(new Store(':memory:'), [], { id: 'host', name: 'Host' }); cleanup.push(() => core.dispose());
  const token = randomSecret(); const relay = await startRelay({ token, port: 0 }); cleanup.push(() => relay.close());
  const pairing: Pairing = { v: 2, hostId: 'host', clientId: 'phone', name: 'Phone', token: randomSecret(), key: randomSecret(), bootstrap: true, expiresAt: new Date(Date.now() + 60_000).toISOString(), relayUrl: `ws://127.0.0.1:${relay.port}` }; core.store.addDevice(pairing);
  const bridge = new RemoteBridge(core, pairing.relayUrl, token); cleanup.push(() => bridge.close()); bridge.start();
  await vi.waitFor(() => expect(bridge.connected).toBe(true), { timeout: 5000 });
  const direct = new DirectController(core, () => 'https://phone.example', () => true); cleanup.push(() => direct.close());
  direct.configure({ enabled: true, url: 'wss://localhost:0/remote', listenHost: '127.0.0.1', port: 0, certificatePath: cert, privateKeyPath: privateKey });
  await vi.waitFor(() => expect(direct.status().state).toBe('online'), { timeout: 5000 });
  const a = await connect(pairing.relayUrl, pairing); const b = await connect(direct.endpoints()[0]!, pairing, ca);
  const keyA = randomSecret(); const keyB = same ? keyA : randomSecret();
  const entered = gate(); const blocked = gate(); cleanup.push(blocked.resolve); let decryptions = 0;
  const decrypt = SessionChannel.prototype.decrypt;
  vi.spyOn(SessionChannel.prototype, 'decrypt').mockImplementation(async function (this: SessionChannel, payload) {
    const message = await decrypt.call(this, payload);
    if (message.kind === 'enroll') { if (++decryptions === 2) entered.resolve(); await blocked.promise; }
    return message;
  });
  a.send(await a.channel.encrypt(secureMessage('enroll', { key: keyA })));
  b.send(await b.channel.encrypt(secureMessage('enroll', { key: keyB })));
  await entered.promise; blocked.resolve();
  await vi.waitFor(() => expect(core.store.devices()[0]!.bootstrap).toBe(false));
  const installed = core.store.devices()[0]!.key; expect([keyA, keyB]).toContain(installed);
  if (same) {
    expect(await a.channel.decrypt((await a.take('payload')).payload)).toMatchObject({ kind: 'enrolled' });
    expect(await b.channel.decrypt((await b.take('payload')).payload)).toMatchObject({ kind: 'enrolled' });
  } else {
    const winner = installed === keyA ? a : b, loser = installed === keyA ? b : a;
    expect(await winner.channel.decrypt((await winner.take('payload')).payload)).toMatchObject({ kind: 'enrolled' });
    await vi.waitFor(() => expect(loser.isClosed()).toBe(true)); expect(loser.messages.filter(message => message.type === 'payload')).toHaveLength(0);
  }
  // The pre-persisted SDK candidate can authenticate on either route after losing the ack.
  const recovered = await connect(pairing.relayUrl, pairing, undefined, [pairing.key, installed]);
  recovered.send(await recovered.channel.encrypt(secureMessage('enroll', { key: installed })));
  expect(await recovered.channel.decrypt((await recovered.take('payload')).payload)).toMatchObject({ kind: 'enrolled' });
  expect(core.store.devices()[0]!.key).toBe(installed);
}, 20_000);
