import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { connectionPingSchema, connectionAckSchema, TurnwireError, projectHistoryEvent } from '@turnwire/protocol';
import { setImmediate as yieldToIO } from 'node:timers/promises';

const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_QUEUE_ITEMS = 256;
const REPLAY_BATCH = 32;
import type { SecureMessage, Pairing } from '@turnwire/protocol';
import type { TurnwireCore } from '@turnwire/core';
import { SecureChannel, secureMessage, acceptClientHandshake } from '@turnwire/wire';
import type { SessionChannel } from '@turnwire/wire';
import { DevicePresence } from './presence.js';

/** One authenticated device connection, shared by outbound Relay and inbound TLS bridge. */
export class RemotePeer {
  private channel?: SecureChannel | SessionChannel;
  private queue: Promise<void> = Promise.resolve(); private outgoing: Promise<void> = Promise.resolve();
  private active = true; private subscribed?: number; private challenge?: { value: string; started: number };
  private authenticatedDevice?: Pairing;
  private incomingBytes = 0; private outgoingBytes = 0;
  private incomingItems = 0; private outgoingItems = 0;
  private replayGeneration = 0; private requests = 0; private requestBytes = 0;
  private fail() { if (!this.active) return; this.close(); try { this.disconnect(); } catch { /* Transport may already be gone. */ } }
  private unsubscribe: () => void;
  constructor(private core: TurnwireCore, readonly id: string, private write: (payload: unknown) => void | Promise<void>, private disconnect: () => void, private presence: DevicePresence, private routes: () => string[] = () => []) {
    this.unsubscribe = core.subscribe(event => { if (this.subscribed !== undefined && event.seq > this.subscribed) { this.subscribed = event.seq; this.send('event', event); } });
  }
  receive(payload: unknown) {
    if (!this.active) return;
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(payload)); } catch { this.fail(); return; }
    if (this.incomingBytes + bytes > MAX_QUEUE_BYTES || this.incomingItems >= MAX_QUEUE_ITEMS) { this.fail(); return; }
    this.incomingBytes += bytes; this.incomingItems++;
    this.queue = this.queue.then(async () => {
      if (!this.active) return;
      const device = this.core.store.devices().find(d => d.clientId === this.id); if (!device) throw new Error('Revoked device');
      if (device.v === 2 && (payload as { type?: string })?.type === 'hello') {
        if (this.channel) throw new Error('Handshake already established');
        if (device.bootstrap && (!device.expiresAt || Date.parse(device.expiresAt) < Date.now())) throw new Error('Pairing expired');
        const accepted = await acceptClientHandshake(payload, device.key, `${device.hostId}:${device.clientId}`);
        if (!this.active) return;
        this.channel = accepted.channel; this.authenticatedDevice = device; await this.write(accepted.reply); return;
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
        if (this.requests >= MAX_QUEUE_ITEMS || this.requestBytes + bytes > MAX_QUEUE_BYTES) throw new Error('Request overload');
        this.requests++; this.requestBytes += bytes;
        void this.core.handle(message.body, { clientId: this.id }).then(response => { if (this.active) this.send('response', response); })
          .catch(() => this.fail()).finally(() => { this.requests--; this.requestBytes -= bytes; });
      } else if (message.kind === 'subscribe') {
        const { after } = z.object({ after: z.union([z.number().int().nonnegative(), z.literal('latest')]) }).strict().parse(message.body);
        if (typeof after === 'number' && after > this.core.store.cursor()) throw new TurnwireError('INVALID_CURSOR', 'Event cursor is beyond the host journal; read state again');
        this.subscribed = undefined;
        const generation = ++this.replayGeneration;
        // Replay never holds the inbound chain: ping/cancel remain reachable during catchup.
        void this.replay(after === 'latest' ? this.core.store.cursor() : after, generation, device.v === 2).catch(() => this.fail());
      }
    }).catch(() => this.fail()).finally(() => { this.incomingBytes -= bytes; this.incomingItems--; });
  }
  private async replay(cursor: number, generation: number, routes: boolean) {
    while (this.active && generation === this.replayGeneration) {
      // Live notifications are disabled until an empty journal read. Events written while
      // yielding are read from the journal next time, without an unbounded side buffer.
      const events = this.core.store.events(cursor, REPLAY_BATCH, undefined, true);
      if (!events.length) {
        this.subscribed = cursor;
        // No await between the empty read, subscription, and enqueuing its confirmation.
        this.send('subscribed', { cursor, heartbeat: true });
        if (routes) this.send('routes', { urls: this.routes() });
        return;
      }
      for (const event of events) {
        if (!this.active || generation !== this.replayGeneration) return;
        await this.send('event', event); cursor = event.seq;
      }
      await yieldToIO();
    }
  }
  private send(kind: SecureMessage['kind'], body: unknown): Promise<void> {
    if (!this.active) return Promise.resolve();
    const channel = this.channel;
    let message: SecureMessage; let bytes: number;
    try {
      message = secureMessage(kind, kind === 'event' ? projectHistoryEvent(body as import('@turnwire/protocol').TurnwireEvent) : body);
      bytes = Buffer.byteLength(JSON.stringify(message));
    } catch { this.fail(); return Promise.resolve(); }
    if (this.outgoingBytes + bytes > MAX_QUEUE_BYTES || this.outgoingItems >= MAX_QUEUE_ITEMS) { this.fail(); return Promise.resolve(); }
    this.outgoingBytes += bytes; this.outgoingItems++;
    this.outgoing = this.outgoing.then(async () => {
      if (!channel || !this.active) return;
      const payload = await channel.encrypt(message);
      if (this.active) await this.write(payload);
    }).catch(() => this.fail()).finally(() => { this.outgoingBytes -= bytes; this.outgoingItems--; });
    return this.outgoing;
  }
  close() { this.active = false; this.replayGeneration++; this.unsubscribe(); this.subscribed = undefined; }
}
