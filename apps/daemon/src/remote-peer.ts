import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { connectionPingSchema, connectionAckSchema, TurnwireError } from '@turnwire/protocol';
import type { SecureMessage, Pairing } from '@turnwire/protocol';
import type { TurnwireCore } from '@turnwire/core';
import { SecureChannel, secureMessage, acceptClientHandshake } from '@turnwire/sdk';
import type { SessionChannel } from '@turnwire/sdk';
import { DevicePresence } from './presence.js';

/** One authenticated device connection, shared by outbound Relay and inbound TLS bridge. */
export class RemotePeer {
  private channel?: SecureChannel | SessionChannel;
  private queue: Promise<void> = Promise.resolve(); private outgoing: Promise<void> = Promise.resolve();
  private active = true; private subscribed?: number; private challenge?: { value: string; started: number };
  private authenticatedDevice?: Pairing;
  private unsubscribe: () => void;
  constructor(private core: TurnwireCore, readonly id: string, private write: (payload: unknown) => void, private disconnect: () => void, private presence: DevicePresence, private routes: () => string[] = () => []) {
    this.unsubscribe = core.subscribe(event => { if (this.subscribed !== undefined && event.seq > this.subscribed) { this.subscribed = event.seq; this.send('event', event); } });
  }
  receive(payload: unknown) {
    this.queue = this.queue.then(async () => {
      if (!this.active) return;
      const device = this.core.store.devices().find(d => d.clientId === this.id); if (!device) throw new Error('Revoked device');
      if (device.v === 2 && (payload as { type?: string })?.type === 'hello') {
        if (this.channel) throw new Error('Handshake already established');
        if (device.bootstrap && (!device.expiresAt || Date.parse(device.expiresAt) < Date.now())) throw new Error('Pairing expired');
        const accepted = await acceptClientHandshake(payload, device.key, `${device.hostId}:${device.clientId}`);
        if (!this.active) return;
        this.channel = accepted.channel; this.authenticatedDevice = device; this.write(accepted.reply); return;
      }
      if (!this.channel && device.v === 1) { this.channel = new SecureChannel(device.key, `${device.hostId}:${device.clientId}`, 'host'); this.authenticatedDevice = device; }
      if (!this.channel) throw new Error('Handshake required');
      const message = await this.channel.decrypt(payload); if (!this.active) return;
      if (message.kind === 'enroll' && device.v === 2) {
        const { key } = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(message.body);
        if (device.bootstrap) {
          if (this.authenticatedDevice?.key !== device.key) throw new Error('Enrollment changed');
          this.core.store.updateDevice({ ...device, key, bootstrap: false, expiresAt: undefined, pendingKey: undefined });
        } else if (device.key !== key) throw new Error('Pairing already consumed');
        this.authenticatedDevice = this.core.store.devices().find(d => d.clientId === this.id);
        this.send('enrolled', {}); return;
      }
      if (device.v === 2 && device.bootstrap) throw new Error('Enrollment required');
      if (message.kind === 'ping') {
        const { nonce } = connectionPingSchema.parse(message.body); const challenge = randomUUID();
        this.challenge = { value: challenge, started: performance.now() };
        this.send('pong', { nonce, challenge, hostId: this.core.device.id });
      } else if (message.kind === 'ack') {
        const { challenge } = connectionAckSchema.parse(message.body); const issued = this.challenge;
        if (!issued || issued.value !== challenge || performance.now() - issued.started > 25_000) throw new Error('Invalid connection confirmation');
        this.presence.confirm(this.id, performance.now() - issued.started); this.challenge = undefined;
        if (device.v === 2) this.send('confirmed', { challenge });
      } else if (message.kind === 'request') {
        // Runtime operations never hold the receive queue; cancellation remains reachable.
        void this.core.handle(message.body, { clientId: this.id }).then(response => { if (this.active) this.send('response', response); });
      } else if (message.kind === 'subscribe') {
        const { after } = z.object({ after: z.union([z.number().int().nonnegative(), z.literal('latest')]) }).strict().parse(message.body);
        if (typeof after === 'number' && after > this.core.store.cursor()) throw new TurnwireError('INVALID_CURSOR', 'Event cursor is beyond the host journal; read state again');
        let cursor = after === 'latest' ? this.core.store.cursor() : after;
        while (true) { const events = this.core.store.events(cursor, 1000); for (const event of events) { this.send('event', event); cursor = event.seq; } if (events.length < 1000) break; }
        this.subscribed = cursor; this.send('subscribed', { cursor, heartbeat: true });
        if (device.v === 2) this.send('routes', { urls: this.routes() });
      }
    }).catch(() => { if (this.active) this.disconnect(); });
  }
  private send(kind: SecureMessage['kind'], body: unknown) {
    const channel = this.channel;
    this.outgoing = this.outgoing.then(async () => {
      if (!channel || !this.active) return;
      const payload = await channel.encrypt(secureMessage(kind, body));
      if (this.active) this.write(payload);
    }).catch(() => { if (this.active) this.disconnect(); });
  }
  close() { this.active = false; this.unsubscribe(); this.subscribed = undefined; }
}
