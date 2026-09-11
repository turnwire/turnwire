import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';
import type { TurnwireCore } from '@turnwire/core';
import type { Pairing } from '@turnwire/protocol';
import { pairDeviceSchema, revokeDeviceSchema, projectHistoryEvent } from '@turnwire/protocol';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { encodePairing, validateEndpoint } from '@turnwire/sdk';
import type { RemoteAccess } from './remote-control.js';
import type { DeploymentAccess } from './deployment.js';

async function body(req: IncomingMessage): Promise<unknown> {
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { length += (chunk as Buffer).length; if (length > 1024 * 1024) throw new Error('Request too large'); chunks.push(chunk as Buffer); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function matches(a: string, b: string) { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
export interface DaemonServerOptions { core: TurnwireCore; token: string; port: number; webRoot?: string; allowedOrigins?: string[]; relayUrl?: string; remoteUrl?: string; onPairingChanged?: () => void; remoteAccess?: RemoteAccess; deployment?: DeploymentAccess }
export function startDaemonServer(options: DaemonServerOptions) {
  const { core } = options; const origins = new Set(options.allowedOrigins ?? []);
  const trusted = (req: IncomingMessage) => {
    const host = req.headers.host; if (!host) return false;
    let url: URL; try { url = new URL(`http://${host}`); } catch { return false; }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
    const origin = req.headers.origin;
    return !origin || origin === url.origin || origins.has(origin);
  };
  const authorized = (req: IncomingMessage) => matches(req.headers.authorization ?? '', `Bearer ${options.token}`);
  const server = createServer(async (req, res) => {
    try {
      res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
      if (!trusted(req)) { res.writeHead(403); res.end('Forbidden origin or host'); return; }
      if (req.headers.origin) { res.setHeader('access-control-allow-origin', req.headers.origin); res.setHeader('vary', 'Origin'); }
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': 'authorization, content-type' }); res.end(); return; }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok","protocol":1}'); return; }
      if (url.pathname === '/rpc' || url.pathname === '/devices' || url.pathname === '/remote' || url.pathname === '/deployment' || url.pathname === '/direct' || url.pathname === '/notifications') {
        res.setHeader('cache-control', 'no-store');
        if (!authorized(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
        res.setHeader('content-type', 'application/json');
        if (url.pathname === '/notifications') {
          if (!options.remoteAccess?.notificationStatus || !options.remoteAccess.configureNotifications) throw new Error('Notifications are not configured on this host');
          if (req.method === 'GET') { res.end(JSON.stringify(options.remoteAccess.notificationStatus())); return; }
          if (req.method === 'PUT') { const value = z.object({ enabled: z.boolean() }).strict().parse(await body(req)); res.end(JSON.stringify(options.remoteAccess.configureNotifications(value.enabled))); return; }
          res.writeHead(405); res.end(); return;
        }
        if (url.pathname === '/direct') {
          if (!options.remoteAccess?.directStatus || !options.remoteAccess.configureDirect) throw new Error('The LAN endpoint is not configured on this host');
          if (req.method === 'GET') { res.end(JSON.stringify(options.remoteAccess.directStatus())); return; }
          if (req.method === 'PUT') { res.end(JSON.stringify(options.remoteAccess.configureDirect(await body(req)))); return; }
          res.writeHead(405); res.end(); return;
        }
        if (url.pathname === '/deployment') {
          if (!options.deployment) { res.writeHead(503); res.end(JSON.stringify({ error: 'Update and restart the daemon to use one-click deployment' })); return; }
          if (req.method === 'GET') { res.end(JSON.stringify(options.deployment.status())); return; }
          if (req.method === 'POST') { res.end(JSON.stringify(options.deployment.start(await body(req)))); return; }
          res.writeHead(405); res.end(); return;
        }
        if (url.pathname === '/remote') {
          if (!options.remoteAccess) { res.writeHead(503); res.end(JSON.stringify({ error: 'Update and restart the daemon to manage remote connection modes' })); return; }
          if (req.method === 'GET') { res.end(JSON.stringify(options.remoteAccess.status())); return; }
          if (req.method === 'PUT') { res.end(JSON.stringify(options.remoteAccess.configure(await body(req)))); return; }
          res.writeHead(405); res.end(); return;
        }
        if (url.pathname === '/rpc' && req.method === 'POST') { res.end(JSON.stringify(await core.handle(await body(req)))); return; }
        if (url.pathname === '/devices' && req.method === 'GET') { res.end(JSON.stringify(core.store.devices().map(d => ({ id: d.clientId, name: d.name, protocol: d.v, enrollment: d.v === 1 ? 'legacy' : d.bootstrap ? 'pending' : 'enrolled', ...options.remoteAccess?.deviceStatus?.(d.clientId) })))); return; }
        if (url.pathname === '/devices' && (req.method === 'POST' || req.method === 'PUT')) {
          const input = await body(req);
          const old = req.method === 'PUT' ? core.store.devices().find(d => d.clientId === revokeDeviceSchema.parse(input).id) : undefined;
          if (req.method === 'PUT' && !old) throw new Error('Paired device not found');
          const name = old?.name ?? pairDeviceSchema.parse(input).name;
          const endpoint = options.remoteAccess ? options.remoteAccess.endpoints() : options.relayUrl ? { relayUrl: options.relayUrl, remoteUrl: options.remoteUrl } : undefined;
          if (!endpoint) { res.writeHead(409); res.end(JSON.stringify({ error: 'Turn on temporary access or connect a self-hosted Relay, then pair the phone once connected' })); return; }
          if (!old && core.store.devices().length >= 100) { res.writeHead(409); res.end(JSON.stringify({ error: 'Reached the 100-device pairing limit' })); return; }
          validateEndpoint(endpoint.relayUrl, true);
          const pairing: Pairing = { v: 2, bootstrap: true, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), relayUrl: endpoint.relayUrl, hostId: core.device.id, clientId: old?.clientId ?? randomUUID(), token: old?.token ?? randomBytes(32).toString('hex'), key: randomBytes(32).toString('hex'), name };
          if (old) core.store.updateDevice(pairing); else core.store.addDevice(pairing); options.onPairingChanged?.(); options.remoteAccess?.refreshDevices();
          const code = encodePairing(pairing);
          res.end(JSON.stringify({ pairing, code, ...(endpoint.remoteUrl ? { url: `${endpoint.remoteUrl.replace(/\/$/, '')}/#pair=${code}` } : {}) })); return;
        }
        if (url.pathname === '/devices' && req.method === 'DELETE') { const { id } = revokeDeviceSchema.parse(await body(req)); core.store.removeDevice(id); options.onPairingChanged?.(); options.remoteAccess?.refreshDevices(); res.end('{"removed":true}'); return; }
        res.writeHead(405); res.end(); return;
      }
      if (req.method === 'GET' && options.webRoot) {
        const root = resolve(options.webRoot); const path = resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
        if (!path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
        const content = await readFile(path).catch(() => undefined);
        if (content) {
          const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
          res.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream');
          res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss: http://127.0.0.1:* http://localhost:* https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
          res.setHeader('cache-control', 'no-cache'); res.end(content); return;
        }
      }
      res.writeHead(404); res.end('Not found');
    } catch (error) { if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Bad request' })); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const live = new WeakSet<WebSocket>();
  server.on('upgrade', (req, socket, head) => {
    if (!trusted(req) || new URL(req.url ?? '/', 'http://localhost').pathname !== '/events') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', socket => {
    live.add(socket); socket.on('pong', () => live.add(socket));
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => socket.close(4401, 'Authentication required'), 5000);
    const send = (frame: unknown): Promise<void> => {
      if (socket.readyState !== WebSocket.OPEN) return Promise.resolve();
      const payload = JSON.stringify(frame);
      if (socket.bufferedAmount + Buffer.byteLength(payload) > 4 * 1024 * 1024) { socket.terminate(); return Promise.resolve(); }
      return new Promise<void>(resolve => socket.send(payload, error => { if (error) socket.terminate(); resolve(); }));
    };
    socket.on('error', () => {});
    socket.once('message', raw => {
      try {
        const auth = z.object({ type: z.literal('auth'), token: z.string().max(500), after: z.number().int().nonnegative() }).strict().parse(JSON.parse(raw.toString()));
        if (!matches(auth.token, options.token)) { socket.close(4401, 'Invalid token'); return; }
        if (auth.after > core.store.cursor()) { socket.close(4002, 'Cursor exceeds journal'); return; }
        clearTimeout(timer);
        let cursor = auth.after;
        void (async () => {
          while (socket.readyState === WebSocket.OPEN) {
            const events = core.store.events(cursor, 32, undefined, true);
            if (!events.length) {
              // Empty journal read, listener registration, and ready enqueue are one atomic
              // event-loop turn; writes during replay are caught by the next journal read.
              unsubscribe = core.subscribe(event => {
                try { void send({ type: 'event', event: projectHistoryEvent(event) }); } catch { socket.close(4002, 'Event exceeds transport limit'); }
              });
              void send({ type: 'ready', cursor }); return;
            }
            for (const event of events) {
              if (socket.readyState !== WebSocket.OPEN) return;
              await send({ type: 'event', event }); cursor = event.seq;
            }
            await yieldToIO();
          }
        })().catch(() => socket.close(4002, 'Replay failed'));
      } catch { socket.close(4002, 'Invalid authentication'); }
    });
    socket.on('close', () => { clearTimeout(timer); unsubscribe?.(); });
  });
  const heartbeat = setInterval(() => { for (const socket of wss.clients) { if (!live.has(socket)) { socket.terminate(); continue; } live.delete(socket); if (socket.readyState === WebSocket.OPEN) socket.ping(); } }, 20_000); heartbeat.unref();
  return new Promise<{ port: number; close: () => Promise<void> }>((resolvePromise, reject) => {
    server.once('error', reject); server.listen(options.port, '127.0.0.1', () => {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
      resolvePromise({ port: address.port, close: async () => { clearInterval(heartbeat); for (const socket of wss.clients) socket.terminate(); await new Promise<void>(done => wss.close(() => done())); await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); } });
    });
  });
}
