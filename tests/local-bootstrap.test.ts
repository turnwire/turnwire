import { describe, expect, it } from 'vitest';
import { localBootstrap } from '../apps/remote-web/src/localBootstrap';
const link = (url: string, token: unknown = 'test-only-token') => '#local=' + encodeURIComponent(JSON.stringify({ url, token }));
describe('loopback browser bootstrap', () => {
  it('accepts same-origin local credentials only', () => {
    expect(localBootstrap(link('http://127.0.0.1:9898'), 'http://127.0.0.1:9898')).toEqual({ kind: 'local', url: 'http://127.0.0.1:9898', token: 'test-only-token' });
    expect(localBootstrap('', 'https://example.com')).toBeUndefined();
  });
  it('rejects non-loopback pages and different origins or URL credentials', () => {
    for (const [url, origin] of [['https://example.com', 'https://example.com'], ['http://127.0.0.1:9999', 'http://127.0.0.1:9898'], ['http://x:y@127.0.0.1:9898', 'http://127.0.0.1:9898'], ['http://localhost:9898', 'http://127.0.0.1:9898'], ['http://127.0.0.1:9898/?token=x', 'http://127.0.0.1:9898']]) expect(() => localBootstrap(link(url!), origin!)).toThrow();
  });
  it('rejects malformed credentials', () => {
    for (const value of ['', null, 4]) expect(() => localBootstrap(link('http://127.0.0.1:9898', value), 'http://127.0.0.1:9898')).toThrow();
  });
});
