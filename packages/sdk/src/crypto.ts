import { encryptedSchema, secureMessageSchema, TurnwireError } from '@turnwire/protocol';
import type { EncryptedPayload, SecureMessage } from '@turnwire/protocol';

function base64(bytes: Uint8Array): string { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); }
function unbase64(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export function randomSecret(): string { return [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join(''); }
export class SecureChannel {
  private key: Promise<CryptoKey>;
  private seen = new Map<string, number>();
  constructor(secret: string, private context: string, private role: 'host' | 'client') {
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid pairing key');
    const bytes = Uint8Array.from(secret.match(/../g)!, n => parseInt(n, 16));
    this.key = crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  private aad(role: string) { return new TextEncoder().encode(`turnwire.v1:${this.context}:${role}`); }
  async encrypt(message: SecureMessage): Promise<EncryptedPayload> {
    secureMessageSchema.parse(message);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: this.aad(this.role) }, await this.key, new TextEncoder().encode(JSON.stringify(message)));
    return { nonce: base64(nonce), ciphertext: base64(new Uint8Array(ciphertext)) };
  }
  async decrypt(value: unknown): Promise<SecureMessage> {
    const encrypted = encryptedSchema.parse(value); const nonce = unbase64(encrypted.nonce);
    if (nonce.length !== 12) throw new TurnwireError('INVALID_CIPHERTEXT', 'Invalid encryption nonce');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: this.aad(this.role === 'host' ? 'client' : 'host') }, await this.key, unbase64(encrypted.ciphertext));
    const message = secureMessageSchema.parse(JSON.parse(new TextDecoder().decode(plain)));
    const now = Date.now();
    if (Math.abs(now - message.sentAt) > 60_000) throw new TurnwireError('EXPIRED_MESSAGE', '设备时间相差超过一分钟，请同步设备时间');
    for (const [id, time] of this.seen) if (now - time > 120_000) this.seen.delete(id);
    if (this.seen.has(message.id)) throw new TurnwireError('REPLAYED_MESSAGE', 'Duplicate encrypted message');
    if (this.seen.size >= 50_000) throw new TurnwireError('RATE_LIMITED', 'Too many remote messages');
    this.seen.set(message.id, now); return message;
  }
}
export function secureMessage(kind: SecureMessage['kind'], body: unknown): SecureMessage { return { id: crypto.randomUUID(), sentAt: Date.now(), kind, body }; }
