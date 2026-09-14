import { randomUUID } from 'node:crypto';
import type { ReleaseIdentity } from '../../../packages/protocol/src/release-identity.mjs';
import { requireBuiltIdentity } from '../../../packages/protocol/src/release-identity.mjs';

declare const __TURNWIRE_BUILD_IDENTITY__: ReleaseIdentity | undefined;
// Capture once when the module loads. Source execution may mix source and built dependencies,
// so it must never claim a publishable contract by inspecting mutable files on disk.
export const daemonIdentity: ReleaseIdentity = Object.freeze(typeof __TURNWIRE_BUILD_IDENTITY__ === 'undefined'
  ? { kind: 'source' as const, buildId: randomUUID(), contractDigest: null }
  : requireBuiltIdentity(__TURNWIRE_BUILD_IDENTITY__));
