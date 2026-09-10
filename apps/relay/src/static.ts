import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

/** Optional public PWA assets. Never proxy the daemon or serve its state. */
export async function serveRemoteWeb(root: string | undefined, req: IncomingMessage, res: ServerResponse) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
  if (!root) { res.writeHead(404); res.end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (pathname.split('/').some(part => part.startsWith('.'))) { res.writeHead(404); res.end(); return; }
    const base = await realpath(root);
    const path = await realpath(resolve(base, `.${pathname === '/' ? '/index.html' : pathname}`));
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
    const type = types[extname(path)];
    if (!path.startsWith(base + sep) || !type || !(await stat(path)).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', type);
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.end(req.method === 'HEAD' ? undefined : await readFile(path));
  } catch { res.writeHead(404); res.end(); }
}
