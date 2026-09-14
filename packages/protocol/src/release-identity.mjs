// Publication identities are separate from the wire protocol version.
export function requireBuiltIdentity(value) {
  if (value?.kind !== 'built' || !/^[a-f0-9]{64}$/.test(value.buildId ?? '') || !/^[a-f0-9]{64}$/.test(value.contractDigest ?? '')) throw Error('running backend build identity missing or invalid; publication blocked');
  return { kind: 'built', buildId: value.buildId, contractDigest: value.contractDigest };
}
export function requireContract(identity, requiredContract) {
  const built = requireBuiltIdentity(identity);
  if (!/^[a-f0-9]{64}$/.test(requiredContract ?? '') || built.contractDigest !== requiredContract) throw Error('frontend required contract does not match running backend; publication blocked');
  return built;
}
export function requireSameBuild(identity, expected) {
  const built = requireContract(identity, requireBuiltIdentity(expected).contractDigest);
  if (built.buildId !== expected.buildId) throw Error('running backend does not match staged build identity; publication blocked');
  return built;
}
