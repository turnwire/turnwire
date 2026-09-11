import WebSocket from 'ws';
import type { TurnwireCore } from '@turnwire/core';
import { validateEndpoint, retryDelay } from '@turnwire/wire';
import { DevicePresence } from './presence.js';
import { RemotePeer } from './remote-peer.js';

export class RemoteBridge {
  private socket?: WebSocket; private timer?: ReturnType<typeof setTimeout>; private stopped = false;
  private registered = false; private attempts = 0; private peers = new Map<string, RemotePeer>();
  private connectionMessage = 'Connecting to the remote service…';
  private registrationFailed = false;
  get connected() { return this.registered; }
  get health(): 'ready' | 'unknown' | 'error' { return this.registered ? 'ready' : this.registrationFailed ? 'error' : 'unknown'; }
  get statusMessage() { return this.connectionMessage; }
  onControl?: (frame: Record<string, unknown>) => void;
  constructor(private core: TurnwireCore, private url: string, private token: string, private presence = new DevicePresence(), private routes: () => string[] = () => []) { validateEndpoint(url, true); }
  sendControl(frame: unknown) { if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Relay is offline'); this.socket.send(JSON.stringify(frame)); }
  start() {
    if (this.stopped || this.socket) return;
    const devices = this.core.store.devices();
    const socket = new WebSocket(this.url, { maxPayload: 3 * 1024 * 1024, handshakeTimeout: 5000 }); this.socket = socket;
    let readyTimeout: ReturnType<typeof setTimeout> | undefined;
    socket.on('open', () => {
      readyTimeout = setTimeout(() => { this.registrationFailed = true; this.connectionMessage = 'Relay authentication response timed out'; socket.terminate(); }, 5000);
      socket.send(JSON.stringify({ kind: 'host', protocol: 2, hostId: this.core.device.id, token: this.token, clients: devices.map(device => ({ id: device.clientId, token: device.token })) }));
    });
    socket.on('message', raw => {
      if (this.socket !== socket) return;
      try {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (frame.type === 'ready') { clearTimeout(readyTimeout); this.registered = true; this.registrationFailed = false; this.attempts = 0; this.connectionMessage = 'Remote service connected'; this.onControl?.(frame); return; }
        if (typeof frame.type === 'string' && frame.type.startsWith('push.')) { this.onControl?.(frame); return; }
        const connectionId = frame.connectionId;
        const id = frame.clientId; if (typeof id !== 'string') return;
        if (frame.type === 'client.connected' || frame.type === 'client.disconnected') { this.peers.get(id)?.close(); this.peers.delete(id); this.presence.disconnect(id); return; }
        if (frame.type !== 'payload' || !this.core.store.devices().some(d => d.clientId === id)) return;
        let peer = this.peers.get(id);
        if (!peer) {
          peer = new RemotePeer(this.core, id, payload => {
            if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) throw new Error('Relay socket closed');
            const frame = JSON.stringify({ type: 'payload', clientId: id, connectionId, payload });
            if (socket.bufferedAmount + Buffer.byteLength(frame) > 4 * 1024 * 1024) { socket.terminate(); throw new Error('Relay write overload'); }
            return new Promise<void>((resolve, reject) => socket.send(frame, error => error ? reject(error) : resolve()));
          }, () => { this.peers.get(id)?.close(); this.peers.delete(id); this.sendControl({ type: 'client.close', clientId: id, connectionId }); }, this.presence, this.routes);
          this.peers.set(id, peer);
        }
        peer.receive(frame.payload);
      } catch { socket.close(4002, 'Invalid relay frame'); }
    });
    socket.on('error', () => { this.registrationFailed = true; this.connectionMessage = 'Cannot reach the remote service; check the address and network'; });
    socket.on('close', code => {
      clearTimeout(readyTimeout); if (this.socket !== socket) return;
      if (code === 4401) this.connectionMessage = 'Relay authentication failed; check the key or a duplicate host connection';
      else if (this.registered) this.connectionMessage = 'Remote connection lost; reconnecting…';
      this.registrationFailed = code !== 4001; this.registered = false; this.presence.disconnect(); this.socket = undefined;
      for (const peer of this.peers.values()) peer.close(); this.peers.clear();
      if (!this.stopped && code !== 4401) this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, retryDelay(this.attempts++));
    });
  }
  refreshDevices() { this.presence.disconnect(); this.registered = false; this.attempts = 0; this.connectionMessage = 'Updating paired devices…'; if (this.socket) this.socket.close(4001, 'Pairing changed'); else { clearTimeout(this.timer); this.start(); } }
  async close() { this.stopped = true; this.registered = false; clearTimeout(this.timer); const socket = this.socket; this.socket = undefined; socket?.terminate(); for (const peer of this.peers.values()) peer.close(); this.peers.clear(); this.presence.disconnect(); }
}
