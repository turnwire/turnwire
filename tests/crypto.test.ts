import { describe, expect, it } from 'vitest';
import { createClientHandshake, acceptClientHandshake, secureMessage, randomSecret, encodePairing, decodePairing, validateEndpoint } from '@turnwire/wire';

async function pair(key = randomSecret(), context = 'mac:phone') {
  const handshake = await createClientHandshake([key], context);
  const host = await acceptClientHandshake(handshake.hello, key, context);
  return { host: host.channel, phone: await handshake.complete(host.reply) };
}
describe('remote encrypted session', () => {
  it('encrypts both directions without exposing the command', async () => {
    const { host, phone } = await pair();
    const message = secureMessage('request', { prompt: 'private source text' }); const payload = await phone.encrypt(message);
    expect(payload.v).toBe(2);
    expect(JSON.stringify(payload)).not.toContain('private source text'); expect(await host.decrypt(payload)).toEqual(message);
    const response = secureMessage('response', { ok: true }); expect(await phone.decrypt(await host.encrypt(response))).toEqual(response);
  });
  it('rejects tampering, reflection, cross-device delivery and replay without consuming valid traffic', async () => {
    const key = randomSecret(); const { host, phone } = await pair(key);
    const other = await pair(key, 'mac:other');
    const payload = await phone.encrypt(secureMessage('request', {}));
    await expect(phone.decrypt(payload)).rejects.toThrow();
    await expect(other.host.decrypt(payload)).rejects.toThrow();
    await expect(host.decrypt({ ...payload, ciphertext: (payload.ciphertext[0] === 'A' ? 'B' : 'A') + payload.ciphertext.slice(1) })).rejects.toThrow();
    await host.decrypt(payload); await expect(host.decrypt(payload)).rejects.toMatchObject({ code: 'REPLAYED_MESSAGE' });
  });
  it('round trips Chinese v2 pairing names and keeps credentials in a URL fragment', () => {
    const pairing = { v: 2 as const, relayUrl: 'wss://relay.example.com', hostId: 'mac', clientId: 'phone', token: randomSecret(), key: randomSecret(), name: '我的手机' };
    const url = new URL(`https://remote.example.com/#pair=${encodePairing(pairing)}`);
    expect(url.search).toBe(''); expect(url.pathname).toBe('/');
    expect(decodePairing(url.href)).toEqual(pairing);
    const legacy = Buffer.from(JSON.stringify({ ...pairing, v: 1 })).toString('base64url');
    expect(() => decodePairing(legacy)).toThrow();
    expect(() => decodePairing(`https://remote.example.com/#pair=${legacy}`)).toThrow();
  });
  it('allows loopback development and requires TLS for remote transport', () => {
    expect(validateEndpoint('http://127.0.0.1:9898').hostname).toBe('127.0.0.1');
    expect(() => validateEndpoint('ws://192.168.1.2', true)).toThrow(); expect(() => validateEndpoint('https://name:secret@host')).toThrow();
  });
});
