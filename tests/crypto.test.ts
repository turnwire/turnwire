import { describe, expect, it } from 'vitest';
import { SecureChannel, secureMessage, randomSecret, encodePairing, decodePairing, validateEndpoint } from '@turnwire/sdk';
describe('remote encrypted channel', () => {
  it('encrypts both directions without exposing the command', async () => {
    const key = randomSecret(); const host = new SecureChannel(key, 'mac:phone', 'host'); const phone = new SecureChannel(key, 'mac:phone', 'client');
    const message = secureMessage('request', { prompt: 'private source text' }); const payload = await phone.encrypt(message);
    expect(JSON.stringify(payload)).not.toContain('private source text'); expect(await host.decrypt(payload)).toEqual(message);
    const response = secureMessage('response', { ok: true }); expect(await phone.decrypt(await host.encrypt(response))).toEqual(response);
  });
  it('rejects tampering, reflection, cross-device delivery, replay and expired messages', async () => {
    const key = randomSecret(); const host = new SecureChannel(key, 'mac:phone', 'host'); const phone = new SecureChannel(key, 'mac:phone', 'client');
    const payload = await phone.encrypt(secureMessage('request', {}));
    await expect(phone.decrypt(payload)).rejects.toThrow();
    await expect(new SecureChannel(key, 'mac:other', 'host').decrypt(payload)).rejects.toThrow();
    await expect(host.decrypt({ ...payload, ciphertext: 'AAAA' + payload.ciphertext.slice(4) })).rejects.toThrow();
    await host.decrypt(payload); await expect(host.decrypt(payload)).rejects.toThrow('Duplicate');
    await expect(host.decrypt(await phone.encrypt({ ...secureMessage('request', {}), sentAt: Date.now() - 120_000 }))).rejects.toThrow();
  });
  it('round trips Chinese pairing names and keeps credentials in a URL fragment', () => {
    const pairing = { v: 1 as const, relayUrl: 'wss://relay.example.com', hostId: 'mac', clientId: 'phone', token: randomSecret(), key: randomSecret(), name: '我的手机' };
    expect(decodePairing(`https://remote.example.com/#pair=${encodePairing(pairing)}`)).toEqual(pairing);
  });
  it('allows loopback development and requires TLS for remote transport', () => {
    expect(validateEndpoint('http://127.0.0.1:9898').hostname).toBe('127.0.0.1');
    expect(() => validateEndpoint('ws://192.168.1.2', true)).toThrow(); expect(() => validateEndpoint('https://name:secret@host')).toThrow();
  });
});
