/** Local launch links never send their fragment credential to an arbitrary host. */
export function localBootstrap(hash: string, origin: string): { kind: 'local'; url: string; token: string } | undefined {
  if (!hash.startsWith('#local=')) return undefined;
  const page = new URL(origin);
  if (page.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(page.hostname)) throw new Error('Local launch requires a loopback page');
  const value: unknown = JSON.parse(decodeURIComponent(hash.slice(7)));
  if (!value || typeof value !== 'object') throw new Error('Invalid local launch');
  const { url, token } = value as Record<string, unknown>;
  if (typeof url !== 'string' || typeof token !== 'string' || !token.trim()) throw new Error('Invalid local launch');
  const target = new URL(url);
  if (target.origin !== page.origin || target.username || target.password || target.search || target.hash || target.pathname !== '/') throw new Error('Local launch origin mismatch');
  return { kind: 'local', url: target.origin, token };
}
