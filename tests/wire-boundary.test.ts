import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as wire from '@turnwire/wire';
import * as sdk from '@turnwire/sdk';
import { pairingSchema, relayAuthSchema, sessionPayloadSchema, transportPayloadSchema } from '@turnwire/protocol';

describe('independent wire package boundary', () => {
  it('rejects legacy ciphertext at the transport boundary and inside negotiated sessions', async () => {
    const secret = wire.randomSecret();
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    const handshake = await wire.createClientHandshake([secret], 'host:phone');
    const host = await wire.acceptClientHandshake(handshake.hello, secret, 'host:phone');
    const client = await handshake.complete(host.reply);
    const legacy = { v: 1, iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' };
    expect(transportPayloadSchema.safeParse(legacy).success).toBe(false);
    expect(sessionPayloadSchema.safeParse(legacy).success).toBe(false);
    await expect(host.channel.decrypt(legacy)).rejects.toThrow();
    const message = wire.secureMessage('request', { private: true });
    expect(await host.channel.decrypt(await client.encrypt(message))).toEqual(message);
  });

  it('rejects old pairing and omitted or downgraded host protocol declarations', () => {
    const fields = { relayUrl: 'wss://relay.example.com', hostId: 'host', clientId: 'phone', token: wire.randomSecret(), key: wire.randomSecret(), name: 'Phone' };
    expect(pairingSchema.safeParse({ ...fields, v: 2 }).success).toBe(true);
    for (const version of [undefined, 1, 3, '2']) {
      expect(pairingSchema.safeParse({ ...fields, v: version }).success).toBe(false);
      expect(relayAuthSchema.safeParse({ kind: 'host', hostId: 'host', token: fields.token, clients: [], protocol: version }).success).toBe(false);
    }
    const host = { kind: 'host', hostId: 'host', token: fields.token, clients: [], protocol: 2 };
    expect(relayAuthSchema.safeParse(host).success).toBe(true);
    expect(relayAuthSchema.safeParse({ ...host, legacy: true }).success).toBe(false);
  });

  it('provides standalone authenticated session negotiation and bidirectional traffic', async () => {
    const secret = wire.randomSecret();
    const handshake = await wire.createClientHandshake([wire.randomSecret(), secret], 'host:phone');
    await expect(wire.acceptClientHandshake(handshake.hello, secret, 'host:other')).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    const host = await wire.acceptClientHandshake(handshake.hello, secret, 'host:phone');
    expect(host.reply.credential).toBe(1);
    const client = await handshake.complete(host.reply);
    expect(client).toBeInstanceOf(wire.SessionChannel);
    expect(host.channel).toBeInstanceOf(wire.SessionChannel);
    expect(client.session).toBe(host.channel.session);
    const request = wire.secureMessage('request', { prompt: 'standalone session request' });
    const encrypted = await client.encrypt(request);
    expect(await host.channel.decrypt(encrypted)).toEqual(request);
    await expect(host.channel.decrypt(encrypted)).rejects.toMatchObject({ code: 'REPLAYED_MESSAGE' });
    const response = wire.secureMessage('response', { ok: true });
    expect(await client.decrypt(await host.channel.encrypt(response))).toEqual(response);
    await expect(handshake.complete(host.reply)).rejects.toMatchObject({ code: 'HANDSHAKE_REUSED' });
  });

  it('provides standalone pairing, endpoint validation and retry helpers', () => {
    const pairing = { v: 2 as const, relayUrl: 'wss://relay.example.com', hostId: 'host', clientId: 'phone', token: wire.randomSecret(), key: wire.randomSecret(), name: '我的手机' };
    expect(wire.decodePairing(`https://remote.example.com/#pair=${wire.encodePairing(pairing)}`)).toEqual(pairing);
    expect(wire.validateEndpoint('http://127.0.0.1:9898').hostname).toBe('127.0.0.1');
    expect(wire.validateEndpoint('wss://relay.example.com', true).protocol).toBe('wss:');
    expect(() => wire.validateEndpoint('http://remote.example.com')).toThrow('HTTPS / WSS');
    expect(() => wire.validateEndpoint('https://name:secret@remote.example.com')).toThrow('Invalid connection URL');
    expect(wire.retryDelay(0, () => 0)).toBe(250);
    expect(wire.retryDelay(0, () => 1)).toBe(1000);
    expect(wire.retryDelay(100, () => 1)).toBe(30_000);
  });

  it('exposes primitives only from wire without SDK compatibility modules or legacy encryption', async () => {
    for (const name of ['validateEndpoint', 'encodePairing', 'decodePairing', 'retryDelay', 'randomSecret', 'secureMessage', 'createClientHandshake', 'acceptClientHandshake', 'SessionChannel']) {
      expect(wire).toHaveProperty(name);
      expect(sdk).not.toHaveProperty(name);
    }
    expect(wire).not.toHaveProperty('SecureChannel');
    expect(sdk).not.toHaveProperty('SecureChannel');
    const files = await readdir(new URL('../packages/sdk/src/', import.meta.url));
    expect(files).not.toContain('crypto.ts');
    expect(files).not.toContain('session-crypto.ts');
  });

  it('keeps wire source dependencies limited to protocol and local wire modules', async () => {
    const root = new URL('../packages/wire/src/', import.meta.url);
    const files = (await readdir(root)).filter(name => name.endsWith('.ts'));
    expect(files).toEqual(expect.arrayContaining(['index.ts', 'crypto.ts', 'session-crypto.ts']));
    for (const file of files) {
      const source = await readFile(new URL(file, root), 'utf8');
      expect(source).not.toMatch(/@turnwire\/sdk|packages\/sdk/);
      const dependencies = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(match => match[1]!);
      for (const dependency of dependencies) {
        expect(dependency === '@turnwire/protocol' || /^\.\/[^/]+\.js$/.test(dependency)).toBe(true);
      }
    }
  });
});
