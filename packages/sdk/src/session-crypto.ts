import { clientHelloSchema, serverHelloSchema, sessionPayloadSchema, secureMessageSchema, TurnwireError } from '@turnwire/protocol';
import type { ClientHello, ServerHello, SessionPayload, SecureMessage } from '@turnwire/protocol';
import { randomSecret } from './crypto.js';

const encoder = new TextEncoder();
function bytes(value: string) { return Uint8Array.from(value.match(/../g) ?? [], n => parseInt(n, 16)); }
function hex(value: ArrayBuffer) { return [...new Uint8Array(value)].map(n => n.toString(16).padStart(2, '0')).join(''); }
function base64(value: ArrayBuffer) { let result = ''; for (const n of new Uint8Array(value)) result += String.fromCharCode(n); return btoa(result); }
function unbase64(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
function text(...values: unknown[]) { return encoder.encode(JSON.stringify(['turnwire.session.v2', ...values])); }
async function macKey(secret: string) { if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid credential'); return crypto.subtle.importKey('raw', bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function sign(secret: string, data: Uint8Array<ArrayBuffer>) { return hex(await crypto.subtle.sign('HMAC', await macKey(secret), data)); }
async function verify(secret: string, proof: string, data: Uint8Array<ArrayBuffer>) { return crypto.subtle.verify('HMAC', await macKey(secret), bytes(proof), data); }
async function ephemeral() { return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']); }
function helloData(context: string, hello: Pick<ClientHello, 'nonce' | 'publicKey'>) { return text('client', context, hello.nonce, hello.publicKey); }
function transcript(context: string, hello: ClientHello, reply: Omit<ServerHello, 'proof'>) { return text('handshake', context, hello.nonce, hello.publicKey, reply.nonce, reply.publicKey, reply.credential); }

/** PSK-authenticated ephemeral ECDH. The persisted device credential authenticates only;
 * traffic keys depend on fresh, non-exportable ephemeral private keys on both peers. */
export async function createClientHandshake(credentials: string[], context: string) {
  const keys = await ephemeral();
  const fields = { type: 'hello' as const, v: 2 as const, nonce: randomSecret(), publicKey: base64(await crypto.subtle.exportKey('raw', keys.publicKey)) };
  const hello: ClientHello = { ...fields, proofs: await Promise.all(credentials.map(secret => sign(secret, helloData(context, fields)))) };
  let completed = false;
  return { hello, async complete(value: unknown) {
    if (completed) throw new TurnwireError('HANDSHAKE_REUSED', '握手已经结束');
    const reply = serverHelloSchema.parse(value); const credential = credentials[reply.credential];
    const data = transcript(context, hello, reply);
    if (!credential || !await verify(credential, reply.proof, data)) throw new TurnwireError('AUTHENTICATION_FAILED', '加密连接验证失败：主机身份不匹配');
    completed = true;
    return derive(keys.privateKey, reply.publicKey, credential, data, 'client');
  } };
}
export async function acceptClientHandshake(value: unknown, credential: string, context: string) {
  const hello = clientHelloSchema.parse(value); let index = -1;
  for (let i = 0; i < hello.proofs.length; i++) if (await verify(credential, hello.proofs[i]!, helloData(context, hello))) { index = i; break; }
  if (index < 0) throw new TurnwireError('AUTHENTICATION_FAILED', '设备凭据无效，或一次性配对码已被使用');
  const keys = await ephemeral();
  const fields = { type: 'hello.reply' as const, v: 2 as const, nonce: randomSecret(), publicKey: base64(await crypto.subtle.exportKey('raw', keys.publicKey)), credential: index };
  const data = transcript(context, hello, fields);
  return { reply: { ...fields, proof: await sign(credential, data) }, channel: await derive(keys.privateKey, hello.publicKey, credential, data, 'host') };
}
async function derive(privateKey: CryptoKey, publicValue: string, credential: string, transcriptBytes: Uint8Array<ArrayBuffer>, role: 'host' | 'client') {
  const peer = await crypto.subtle.importKey('raw', unbase64(publicValue), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']); shared.fill(0);
  const salt = bytes(await sign(credential, transcriptBytes));
  const session = hex(await crypto.subtle.digest('SHA-256', transcriptBytes));
  const key = (direction: string) => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: text('traffic', session, direction) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const [client, host] = await Promise.all([key('client'), key('host')]);
  return new SessionChannel(session, role, role === 'client' ? client : host, role === 'client' ? host : client);
}
export class SessionChannel {
  private sent = 0n; private received = 0n;
  private sending: Promise<unknown> = Promise.resolve(); private receiving: Promise<unknown> = Promise.resolve();
  constructor(readonly session: string, private role: 'host' | 'client', private transmit: CryptoKey, private receive: CryptoKey) {}
  private nonce(sequence: bigint) { const value = new Uint8Array(12); new DataView(value.buffer).setBigUint64(4, sequence); return value; }
  encrypt(message: SecureMessage): Promise<SessionPayload> {
    const task = this.sending.then(async () => {
      secureMessageSchema.parse(message); const sequence = this.sent++;
      if (sequence >= (1n << 64n)) throw new TurnwireError('REKEY_REQUIRED', '需要重新建立加密连接');
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: this.nonce(sequence), additionalData: text('frame', this.session, this.role, sequence.toString()) }, this.transmit, encoder.encode(JSON.stringify(message)));
      return { v: 2 as const, session: this.session, sequence: sequence.toString(), ciphertext: base64(ciphertext) };
    }); this.sending = task.catch(() => {}); return task;
  }
  decrypt(value: unknown): Promise<SecureMessage> {
    const task = this.receiving.then(async () => {
      const payload = sessionPayloadSchema.parse(value);
      if (payload.session !== this.session || BigInt(payload.sequence) !== this.received) throw new TurnwireError('REPLAYED_MESSAGE', '加密会话或消息序号不匹配');
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: this.nonce(this.received), additionalData: text('frame', this.session, this.role === 'host' ? 'client' : 'host', payload.sequence) }, this.receive, unbase64(payload.ciphertext));
      const message = secureMessageSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
      this.received++; return message;
    }); this.receiving = task.catch(() => {}); return task;
  }
}
