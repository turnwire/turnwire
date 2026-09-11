import { pairingSchema } from '@turnwire/protocol';
import type { Pairing } from '@turnwire/protocol';

export function encodePairing(pairing: Pairing): string { return btoa(unescape(encodeURIComponent(JSON.stringify(pairing)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
export function decodePairing(value: string): Pairing {
  const input = value.trim().includes('#pair=') ? value.trim().split('#pair=')[1]! : value.trim();
  return pairingSchema.parse(JSON.parse(decodeURIComponent(escape(atob(input.replaceAll('-', '+').replaceAll('_', '/'))))));
}
