import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import WebSocket, { WebSocketServer } from 'ws';
import { directConfigurationSchema, relayAuthSchema } from '@turnwire/protocol';
import type { DirectConfiguration, DirectStatus } from '@turnwire/protocol';
import type { TurnwireCore } from '@turnwire/core';
import { equalSecret } from '../../relay/src/server.js';
import { RemotePeer } from './remote-peer.js';
import { DevicePresence } from './presence.js';
import { HostActivity } from './host-activity.js';

export class DirectController {
  readonly presence = new DevicePresence();
  private configuration: DirectConfiguration;
  private activeUrl?: string;
  private state: DirectStatus['state'] = 'off'; private message = 'LAN direct connection is off';
  private server?: ReturnType<typeof createServer>; private wss?: WebSocketServer;
  private peers = new Map<string, { socket: WebSocket; peer: RemotePeer }>();
  private operation = Promise.resolve(); private generation = 0; private stopped = false; private closing?: Promise<void>;
  private scheduledConfiguration?: string;
  constructor(private core: TurnwireCore, private origin: () => string | undefined, private allowed: () => boolean,
    private activity = new HostActivity(recovery => core.enterHostActivity(recovery))) { this.configuration = core.store.setting<DirectConfiguration>('direct-preferences') ?? { enabled: false }; }
  endpoints() { return this.state === 'online' && this.activeUrl ? [this.activeUrl] : []; }
  status(): DirectStatus {
    const candidates = [...new Set(Object.values(networkInterfaces()).flatMap(addresses => addresses?.filter(a => !a.internal && a.family === 'IPv4').map(a => a.address) ?? []))];
    return { enabled: this.configuration.enabled, state: this.state, message: this.message, url: this.endpoints()[0], candidates, configuration: this.configuration };
  }
  configure(value: unknown) {
    const configuration = directConfigurationSchema.parse(value);
    if (configuration.enabled) {
      if (!configuration.url || !configuration.certificatePath || !configuration.privateKeyPath) throw new Error('Enter the WSS address, a browser-trusted certificate, and the private key path');
      const url = new URL(configuration.url);
      if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash) throw new Error('LAN direct connection requires a credential-free WSS address');
    }
    return this.activity.run(() => {
      if (this.stopped) throw new Error('Direct controller is closed');
      this.core.store.setSetting('direct-preferences', configuration); this.configuration = configuration;
      void this.start().catch(() => {}); return this.status();
    }, !configuration.enabled);
  }
  start(): Promise<void> {
    const operation = this.activity.run(() => {
    if (this.stopped) throw new Error('Direct controller is closed');
    const configuration = this.configuration;
    const enabled = configuration.enabled && this.allowed();
    const desired = JSON.stringify(enabled ? [configuration.url, configuration.certificatePath, configuration.privateKeyPath, configuration.port, configuration.listenHost] : ['off']);
    // Reconcile intent with actual lifecycle: identical startup/online work is owned
    // already, but saved enabled intent with no listener (or a failed one) must resume.
    if (desired === this.scheduledConfiguration && (this.state === 'starting' || this.state === 'online' || (!enabled && this.state === 'off'))) return this.operation;
    this.scheduledConfiguration = desired;
    const generation = ++this.generation;
    this.state = enabled ? 'starting' : 'off';
    this.message = this.state === 'starting' ? 'Starting the LAN encrypted endpoint…' : configuration.enabled ? 'Enable LAN direct connection after turning on remote control' : 'LAN direct connection is off';
    this.operation = this.operation.catch(() => {}).then(async () => {
      await this.release(); if (generation !== this.generation || !configuration.enabled || !this.allowed()) return;
      try {
        const url = new URL(configuration.url!);
        const [cert, key] = await Promise.all([readFile(configuration.certificatePath!), readFile(configuration.privateKeyPath!)]);
        const certificate = new X509Certificate(cert);
        if (!certificate.checkHost(url.hostname) && !certificate.checkIP(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Certificate does not match the LAN WSS address');
        if (Date.parse(certificate.validTo) <= Date.now() || Date.parse(certificate.validFrom) > Date.now()) throw new Error('LAN certificate is not yet valid or has expired');
        if (generation !== this.generation) return;
        const server = createServer({ cert, key, minVersion: 'TLSv1.2' }, (_req, res) => { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); });
        const wss = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024 }); this.server = server; this.wss = wss;
        server.on('upgrade', (req, socket, head) => {
          const allowedOrigin = this.origin(); const origin = req.headers.origin;
          if ((req.url ?? '/') !== url.pathname || (origin && origin !== url.origin.replace(/^wss:/, 'https:') && (!allowedOrigin || origin !== new URL(allowedOrigin).origin))) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
          wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
        });
        wss.on('connection', socket => {
          if (wss.clients.size > 100) { socket.close(4429); return; }
          let id: string | undefined; let peer: RemotePeer | undefined; let messages = 0; let windowStart = performance.now();
          const timer = setTimeout(() => socket.close(4401), 5000); socket.on('error', () => {});
          socket.on('message', raw => {
            try {
              if (performance.now() - windowStart > 1000) { windowStart = performance.now(); messages = 0; }
              if (++messages > 1000) { socket.close(4429); return; }
              const frame = JSON.parse(raw.toString());
              if (!peer) {
                const auth = relayAuthSchema.parse(frame); if (auth.kind !== 'client' || auth.hostId !== this.core.device.id) throw new Error('Invalid device');
                const device = this.core.store.devices().find(d => d.clientId === auth.clientId);
                if (!device || !equalSecret(auth.token, device.token)) { socket.close(4401); return; }
                id = auth.clientId; this.peers.get(id)?.socket.close(4001); this.peers.get(id)?.peer.close();
                peer = new RemotePeer(this.core, id, payload => {
                  if (socket.readyState !== WebSocket.OPEN) throw new Error('Direct socket closed');
                  const frame = JSON.stringify({ type: 'payload', payload });
                  if (socket.bufferedAmount + Buffer.byteLength(frame) > 4 * 1024 * 1024) { socket.terminate(); throw new Error('Direct write overload'); }
                  return new Promise<void>((resolve, reject) => socket.send(frame, error => error ? reject(error) : resolve()));
                }, () => socket.close(4002), this.presence, () => this.endpoints());
                this.peers.set(id, { socket, peer }); clearTimeout(timer); socket.send(JSON.stringify({ type: 'ready', online: true })); return;
              }
              if (frame.type !== 'payload') throw new Error('Invalid payload'); peer.receive(frame.payload);
            } catch { socket.close(4002); }
          });
          socket.on('close', () => { clearTimeout(timer); peer?.close(); if (id && this.peers.get(id)?.socket === socket) { this.peers.delete(id); this.presence.disconnect(id); } });
        });
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(configuration.port ?? Number(url.port || 443), configuration.listenHost ?? '0.0.0.0', resolve); });
        if (generation !== this.generation) { await this.release(); return; }
        const address = server.address(); if (address && typeof address !== 'string') { url.port = String(address.port); this.activeUrl = url.href; }
        this.state = 'online'; this.message = 'LAN encrypted endpoint is ready; the phone browser must trust the certificate and allow LAN access';
      } catch (error) { await this.release(); if (generation === this.generation) { this.state = 'error'; this.message = error instanceof Error ? error.message : 'Failed to start the LAN endpoint'; } }
    });
    // start is also used as a fire-and-forget maintenance hook.
    void this.operation.catch(() => {});
    return this.operation;
    }, !this.configuration.enabled || !this.allowed());
    this.operation = operation;
    void operation.catch(() => {});
    return operation;
  }
  refreshDevices() { for (const [id, entry] of this.peers) { const device = this.core.store.devices().find(d => d.clientId === id); if (!device || device.bootstrap) entry.socket.close(4401); } }
  private async release() {
    this.activeUrl = undefined;
    for (const entry of this.peers.values()) entry.peer.close(); this.peers.clear(); this.presence.disconnect();
    const wss = this.wss; this.wss = undefined; const server = this.server; this.server = undefined;
    if (wss) { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); }
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true; ++this.generation;
    this.closing = this.activity.run(async () => { await this.operation.catch(() => {}); await this.release(); this.state = 'off'; }, true);
    return this.closing;
  }
}
