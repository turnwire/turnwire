export type BuiltIdentity = Readonly<{ kind: 'built'; buildId: string; contractDigest: string }>;
export type ReleaseIdentity = BuiltIdentity | Readonly<{ kind: 'source'; buildId: string; contractDigest: null }>;
export function requireBuiltIdentity(value: unknown): BuiltIdentity;
export function requireContract(identity: unknown, requiredContract: unknown): BuiltIdentity;
export function requireSameBuild(identity: unknown, expected: unknown): BuiltIdentity;
