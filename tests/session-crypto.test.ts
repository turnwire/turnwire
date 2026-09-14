import { expect, it } from 'vitest';
import { createClientHandshake, acceptClientHandshake, randomSecret, secureMessage } from '@turnwire/wire';

async function pair(secret = randomSecret()) {
  const phone = await createClientHandshake([secret], 'host:phone');
  const host = await acceptClientHandshake(phone.hello, secret, 'host:phone');
  return { phone: await phone.complete(host.reply), host: host.channel, secret };
}
it('authenticates both roles and binds fresh keys to the full handshake', async () => {
  const secret = randomSecret(); const phone = await createClientHandshake([secret], 'host:phone');
  await expect(acceptClientHandshake(phone.hello, randomSecret(), 'host:phone')).rejects.toThrow();
  await expect(acceptClientHandshake(phone.hello, secret, 'host:other')).rejects.toThrow();
  const host = await acceptClientHandshake(phone.hello, secret, 'host:phone');
  await expect(phone.complete({ ...host.reply, nonce: randomSecret() })).rejects.toThrow();
  const channel = await phone.complete(host.reply);
  expect(await host.channel.decrypt(await channel.encrypt(secureMessage('request', { private: true })))).toMatchObject({ body: { private: true } });
  await expect(phone.complete(host.reply)).rejects.toThrow();
});
it('rejects replay, out-of-order, reflection and old sessions without relying on device clocks', async () => {
  const { phone, host, secret } = await pair();
  const first = await phone.encrypt({ ...secureMessage('ping', {}), sentAt: 1 });
  const second = await phone.encrypt({ ...secureMessage('ping', {}), sentAt: Date.now() + 86_400_000 });
  await expect(host.decrypt(second)).rejects.toThrow();
  await expect(phone.decrypt(first)).rejects.toThrow();
  await host.decrypt(first); await expect(host.decrypt(first)).rejects.toThrow(); await host.decrypt(second);
  const next = await pair(secret); expect(next.host.session).not.toBe(host.session);
  await expect(next.host.decrypt(first)).rejects.toThrow();
  expect(await phone.decrypt(await host.encrypt(secureMessage('pong', { ok: true })))).toMatchObject({ body: { ok: true } });
});
it('serializes concurrent encryption and refuses altered ciphertext without consuming receive sequence', async () => {
  const { phone, host } = await pair();
  const payloads = await Promise.all(Array.from({ length: 30 }, (_, i) => phone.encrypt(secureMessage('request', i))));
  expect(payloads.map(p => p.sequence)).toEqual(Array.from({ length: 30 }, (_, i) => String(i)));
  await expect(host.decrypt({ ...payloads[0], ciphertext: (payloads[0]!.ciphertext[0] === 'A' ? 'B' : 'A') + payloads[0]!.ciphertext.slice(1) })).rejects.toThrow();
  for (let i = 0; i < payloads.length; i++) expect((await host.decrypt(payloads[i])).body).toBe(i);
});
