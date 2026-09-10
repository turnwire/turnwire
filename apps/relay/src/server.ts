import { RelayPush, pushRequestSchema } from './push.js';
import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { relayAuthSchema, transportPayloadSchema } from '@turnwire/protocol';
import { serveRemoteWeb } from './static.js';

export function equalSecret(actual: string, expected: string) { const a = Buffer.from(actual), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b); }
export function startRelay(options: { token: string; port: number; host?: string; webRoot?: string; push?: { path: string; subject: string; deliver?: ConstructorParameters<typeof RelayPush>[2] } }) {
  if (options.token.length < 32) throw new Error('TURNWIRE_RELAY_TOKEN must contain at least 32 characters');
  const push = options.push ? new RelayPush(options.push.path, options.push.subject, options.push.deliver) : undefined;
  const hosts = new Map<string, { socket: WebSocket; protocol?: 2; clients: Map<string, string> }>();
  const connections = new WeakMap<WebSocket, string>();
  const clients = new Map<string, Map<string, WebSocket>>();
  const server = createServer((req, res) => { if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); } else { void serveRemoteWeb(options.webRoot, req, res); } });
  const wss = new WebSocketServer({ server, maxPayload: 3 * 1024 * 1024 });
  const send = (socket: WebSocket | undefined, frame: unknown) => { if (socket?.readyState !== WebSocket.OPEN) return; if (socket.bufferedAmount > 4 * 1024 * 1024) { socket.terminate(); return; } socket.send(JSON.stringify(frame)); };
  const live = new WeakSet<WebSocket>();
  wss.on('connection', socket => {
    if (wss.clients.size > 200) { socket.close(4429, 'Relay at capacity'); return; }
    let identity: { kind: 'host' | 'client'; hostId: string; clientId?: string } | undefined;
    let count = 0; let windowStart = Date.now();
    const timeout = setTimeout(() => socket.close(4401, 'Authentication required'), 5000);
    live.add(socket); socket.on('pong', () => live.add(socket)); socket.on('error', () => {});
    socket.on('message', raw => {
      try {
        if (Date.now() - windowStart > 1000) { windowStart = Date.now(); count = 0; }
        // A trusted host can replay thousands of stored events in one burst.
        // Keep the phone ingress limit; payload and slow-consumer bounds apply to both roles.
        if (identity?.kind !== 'host' && ++count > 1000) { socket.close(4429, 'Rate limit'); return; }
        const frame: unknown = JSON.parse(raw.toString());
        if (!identity) {
          const auth = relayAuthSchema.parse(frame);
          if (auth.kind === 'host') {
            if (!equalSecret(auth.token, options.token) || hosts.has(auth.hostId)) { socket.close(4401, 'Host authentication failed'); return; }
            identity = { kind: 'host', hostId: auth.hostId };
            hosts.set(auth.hostId, { socket, protocol: auth.protocol, clients: new Map(auth.clients.map(client => [client.id, client.token])) });
            push?.reconcile(auth.hostId, auth.clients.map(c => c.id));
            send(socket, { type: 'ready', ...(push ? { push: { publicKey: push.publicKey } } : {}) });
            // A host reconnect always requires remote clients to reauthenticate against the new allowlist.
            for (const client of clients.get(auth.hostId)?.values() ?? []) client.close(4001, 'Host reconnected');
          } else {
            const host = hosts.get(auth.hostId);
            const expected = host?.clients.get(auth.clientId);
            if (!host || !expected || !equalSecret(auth.token, expected)) { socket.close(host ? 4401 : 4404, host ? 'Device authentication failed' : 'Host offline'); return; }
            identity = { kind: 'client', hostId: auth.hostId, clientId: auth.clientId };
            const group = clients.get(auth.hostId) ?? new Map<string, WebSocket>(); clients.set(auth.hostId, group);
            group.get(auth.clientId)?.close(4001, 'Device reconnected'); group.set(auth.clientId, socket);
            const connectionId = randomUUID(); connections.set(socket, connectionId);
            send(host.socket, { type: 'client.connected', clientId: auth.clientId, connectionId });
            send(socket, { type: 'ready', online: true });
          }
          clearTimeout(timeout); return;
        }
        if (typeof frame !== 'object' || frame === null) throw new Error('Invalid frame');
        const data = frame as { type?: string; clientId?: string; payload?: unknown; connectionId?: string };
        if (data.type === 'push.request' && identity.kind === 'host') {
          const request = pushRequestSchema.parse(frame);
          try { if (!push) throw new Error('Web Push is not enabled on this Relay'); const result = push.handle(identity.hostId, new Set(hosts.get(identity.hostId)?.clients.keys()), request); send(socket, { type: 'push.response', id: request.id, ok: true, result }); }
          catch (error) { send(socket, { type: 'push.response', id: request.id, ok: false, error: error instanceof Error ? error.message : 'Push request failed' }); }
          return;
        }
        if (data.type === 'client.close' && identity.kind === 'host' && typeof data.clientId === 'string') { const target = clients.get(identity.hostId)?.get(data.clientId); if (target && data.connectionId === connections.get(target)) target.close(4002, 'Device verification failed'); return; }
        if (data.type !== 'payload') throw new Error('Invalid frame');
        const payload = transportPayloadSchema.parse(data.payload);
        if (identity.kind === 'host') {
          if (typeof data.clientId !== 'string' || !hosts.get(identity.hostId)?.clients.has(data.clientId)) throw new Error('Unknown client');
          const target = clients.get(identity.hostId)?.get(data.clientId);
          if (target && (hosts.get(identity.hostId)?.protocol !== 2 || connections.get(target) === data.connectionId)) send(target, { type: 'payload', payload });
        } else send(hosts.get(identity.hostId)?.socket, { type: 'payload', clientId: identity.clientId, connectionId: connections.get(socket), payload });
      } catch { socket.close(4002, 'Invalid protocol'); }
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      if (!identity) return;
      if (identity.kind === 'host' && hosts.get(identity.hostId)?.socket === socket) { hosts.delete(identity.hostId); for (const client of clients.get(identity.hostId)?.values() ?? []) client.close(4001, 'Host disconnected'); }
      if (identity.kind === 'client') { const group = clients.get(identity.hostId); if (group?.get(identity.clientId!) === socket) { group.delete(identity.clientId!); send(hosts.get(identity.hostId)?.socket, { type: 'client.disconnected', clientId: identity.clientId, connectionId: connections.get(socket) }); } if (!group?.size) clients.delete(identity.hostId); }
    });
  });
  const heartbeat = setInterval(() => { for (const socket of wss.clients) { if (!live.has(socket)) { socket.terminate(); continue; } live.delete(socket); socket.ping(); } }, 20_000); heartbeat.unref();
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
    server.once('error', reject); server.listen(options.port, options.host ?? '127.0.0.1', () => {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
      resolve({ port: address.port, close: async () => { clearInterval(heartbeat); await push?.close(); for (const socket of wss.clients) socket.terminate(); await new Promise<void>(done => wss.close(() => done())); await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); } });
    });
  });
}
