import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as wire from '@turnwire/wire';
import * as sdk from '@turnwire/sdk';
import * as legacyCrypto from '../packages/sdk/src/crypto.js';
import * as legacySessionCrypto from '../packages/sdk/src/session-crypto.js';

describe('independent wire package boundary', () => {
  it('provides standalone legacy encryption in both directions and rejects replay', async () => {
    const secret = wire.randomSecret();
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    const host = new wire.SecureChannel(secret, 'host:phone', 'host');
    const client = new wire.SecureChannel(secret, 'host:phone', 'client');
    const request = wire.secureMessage('request', { prompt: 'standalone private request' });
    const encrypted = await client.encrypt(request);
    expect(JSON.stringify(encrypted)).not.toContain('standalone private request');
    expect(await host.decrypt(encrypted)).toEqual(request);
    await expect(host.decrypt(encrypted)).rejects.toMatchObject({ code: 'REPLAYED_MESSAGE' });
    const response = wire.secureMessage('response', { ok: true });
    expect(await client.decrypt(await host.encrypt(response))).toEqual(response);
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
    const pairing = { v: 1 as const, relayUrl: 'wss://relay.example.com', hostId: 'host', clientId: 'phone', token: wire.randomSecret(), key: wire.randomSecret(), name: '我的手机' };
    expect(wire.decodePairing(`https://remote.example.com/#pair=${wire.encodePairing(pairing)}`)).toEqual(pairing);
    expect(wire.validateEndpoint('http://127.0.0.1:9898').hostname).toBe('127.0.0.1');
    expect(wire.validateEndpoint('wss://relay.example.com', true).protocol).toBe('wss:');
    expect(() => wire.validateEndpoint('http://remote.example.com')).toThrow('HTTPS / WSS');
    expect(() => wire.validateEndpoint('https://name:secret@remote.example.com')).toThrow('Invalid connection URL');
    expect(wire.retryDelay(0, () => 0)).toBe(250);
    expect(wire.retryDelay(0, () => 1)).toBe(1000);
    expect(wire.retryDelay(100, () => 1)).toBe(30_000);
  });

  it('preserves exact helper and class identity through every SDK compatibility export', () => {
    for (const name of ['validateEndpoint', 'encodePairing', 'decodePairing', 'retryDelay'] as const) {
      expect(sdk[name]).toBe(wire[name]);
    }
    for (const name of ['randomSecret', 'secureMessage', 'SecureChannel'] as const) {
      expect(sdk[name]).toBe(wire[name]);
      expect(legacyCrypto[name]).toBe(wire[name]);
    }
    for (const name of ['createClientHandshake', 'acceptClientHandshake', 'SessionChannel'] as const) {
      expect(sdk[name]).toBe(wire[name]);
      expect(legacySessionCrypto[name]).toBe(wire[name]);
    }
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
