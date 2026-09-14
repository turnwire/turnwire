import type { SecureMessage } from '@turnwire/protocol';

export function randomSecret(): string { return [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join(''); }
export function secureMessage(kind: SecureMessage['kind'], body: unknown): SecureMessage { return { id: crypto.randomUUID(), sentAt: Date.now(), kind, body }; }
