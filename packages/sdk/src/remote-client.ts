import { z } from 'zod';
import { pairingSchema, connectionPongSchema, responseSchema, eventSchema, TurnwireError } from '@turnwire/protocol';
import type { Pairing, Method, TurnwireEvent, SecureMessage } from '@turnwire/protocol';
import { SecureChannel, secureMessage, randomSecret } from './crypto.js';
import { createClientHandshake } from './session-crypto.js';
import type { SessionChannel } from './session-crypto.js';
import { retryDelay } from './retry.js';
import { validateEndpoint } from './index.js';
import type { TurnwireClient, ConnectionState } from './index.js';

export interface ConnectionHealth {
  phase: 'connecting' | 'verifying' | 'connected' | 'offline' | 'error'; message: string;
  lastVerifiedAt?: string; latencyMs?: number; route?: 'relay' | 'direct';
  stage?: 'transport' | 'relay' | 'handshake' | 'verification' | 'ready';
  attempt?: number; retryInMs?: number; protocol?: 1 | 2; elapsedMs?: number; code?: string;
}
export interface RemoteClientOptions {
  heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number; connectTimeoutMs?: number;
  /** Must finish durable storage before a one-time pairing is consumed. */
  persistPairing?: (pairing: Pairing) => void | Promise<void>;
}
class Transport {
  readonly ready: Promise<void>;
  verifiedHealth: Partial<ConnectionHealth> = {};
  private resolve!: () => void; private reject!: (error: Error) => void;
  private socket: WebSocket; private active = true; private verified = false;
  private channel?: SecureChannel | SessionChannel;
  private handshake?: Awaited<ReturnType<typeof createClientHandshake>>;
  private incoming = Promise.resolve(); private outgoing = Promise.resolve();
  private deadline?: ReturnType<typeof setTimeout>; private heartbeat?: ReturnType<typeof setInterval>;
  private probe?: { nonce: string; challenge?: string; started: number; resolve: () => void; reject: (error: Error) => void; promise: Promise<void>; timer: ReturnType<typeof setTimeout> };
  constructor(readonly url: string, readonly route: 'relay' | 'direct', private pairing: Pairing, private options: RemoteClientOptions,
    private health: (value: Partial<ConnectionHealth>) => void, private message: (value: SecureMessage) => void,
    private failed: (error: Error) => void, private save: (value: Pairing) => Promise<void>) {
    this.ready = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.socket = new WebSocket(validateEndpoint(url, true));
    this.stage('transport', 'Connecting to the remote entry…');
    this.socket.onopen = () => { this.stage('relay', 'Entry connected, confirming the host…'); this.socket.send(JSON.stringify({ kind: 'client', hostId: pairing.hostId, clientId: pairing.clientId, token: pairing.token })); };
    this.socket.onerror = () => {};
    this.socket.onclose = event => this.abort(new TurnwireError(event.code === 4401 ? 'UNAUTHORIZED' : event.code === 4002 || event.code === 4003 ? 'AUTHENTICATION_FAILED' : 'DISCONNECTED', event.code === 4401 ? 'Pairing credentials are invalid or revoked; pair again on the host' : event.code === 4002 ? 'Encrypted connection verification failed; pair again or update the host' : event.code === 4404 ? 'The host is offline' : 'Remote connection closed'));
    this.socket.onmessage = raw => {
      this.incoming = this.incoming.then(async () => {
        if (!this.active) return;
        const frame = JSON.parse(String(raw.data));
        if (frame.type === 'ready') {
          if (!frame.online) throw new TurnwireError('HOST_OFFLINE', 'The host is offline');
          if (this.channel || this.handshake) throw new Error('Duplicate relay ready');
          if (pairing.v === 2) {
            this.stage('handshake', 'Verifying the device identity and deriving session keys…');
            this.handshake = await createClientHandshake([pairing.key, ...(pairing.pendingKey ? [pairing.pendingKey] : [])], `${pairing.hostId}:${pairing.clientId}`);
            if (this.active) this.socket.send(JSON.stringify({ type: 'payload', payload: this.handshake.hello }));
          } else { this.channel = new SecureChannel(pairing.key, `${pairing.hostId}:${pairing.clientId}`, 'client'); await this.initialize(); }
          return;
        }
        if (frame.type !== 'payload') return;
        if (pairing.v === 2 && frame.payload?.type === 'hello.reply') {
          if (!this.handshake || this.channel) throw new Error('Unexpected handshake reply');
          this.channel = await this.handshake.complete(frame.payload); this.handshake = undefined;
          if (pairing.bootstrap) await this.send('enroll', { key: pairing.pendingKey }); else await this.initialize();
          return;
        }
        if (!this.channel) throw new Error('Encrypted session required');
        const value = await this.channel.decrypt(frame.payload); if (!this.active) return;
        if (value.kind === 'enrolled') {
          if (pairing.v !== 2 || !pairing.pendingKey || !pairing.bootstrap) throw new Error('Unexpected enrollment');
          await this.save({ ...pairing, key: pairing.pendingKey, bootstrap: false, pendingKey: undefined, expiresAt: undefined });
          await this.initialize();
        } else if (value.kind === 'subscribed') {
          if (!(value.body as { heartbeat?: boolean })?.heartbeat) throw new TurnwireError('AUTHENTICATION_FAILED', 'Update the Turnwire service on the host to verify the connection');
          if (!this.verified) void this.ping().catch(() => {});
        } else if (value.kind === 'pong') {
          const pong = connectionPongSchema.parse(value.body); const probe = this.probe;
          if (!probe || pong.nonce !== probe.nonce || pong.hostId !== pairing.hostId) throw new TurnwireError('AUTHENTICATION_FAILED', 'Encrypted connection verification failed: mismatched response');
          probe.challenge = pong.challenge; await this.send('ack', { challenge: pong.challenge });
          if (pairing.v === 1) this.confirm();
        } else if (value.kind === 'confirmed') {
          if (pairing.v !== 2 || !this.probe?.challenge || (value.body as { challenge?: string })?.challenge !== this.probe.challenge) throw new Error('Invalid confirmation');
          this.confirm();
        } else if (value.kind === 'error') throw new TurnwireError('REMOTE_ERROR', 'The host refused the connection; check host diagnostics');
        else this.message(value);
      }).catch(error => { const failure = error instanceof TurnwireError ? error : new TurnwireError('AUTHENTICATION_FAILED', 'Encrypted connection verification failed'); if (failure !== error) failure.cause = error; this.abort(failure); });
    };
  }
  private stage(stage: ConnectionHealth['stage'], message: string) {
    clearTimeout(this.deadline); this.health({ phase: stage === 'transport' || stage === 'relay' ? 'connecting' : 'verifying', stage, message });
    this.deadline = setTimeout(() => this.abort(new TurnwireError('STAGE_TIMEOUT', `${message.replace(/…$/, '')} timed out`)), this.options.connectTimeoutMs ?? 5000);
  }
  private async initialize() { this.stage('verification', 'Verifying the two-way connection with the host…'); await this.send('subscribe', { after: 'latest' }); }
  private confirm() {
    const probe = this.probe; if (!probe) return;
    const latencyMs = performance.now() - probe.started;
    if (latencyMs > (this.options.heartbeatTimeoutMs ?? 5000)) throw new TurnwireError('PROBE_TIMEOUT', 'The connection probe response expired');
    clearTimeout(probe.timer); clearTimeout(this.deadline); this.probe = undefined; this.verified = true;
    this.verifiedHealth = { phase: 'connected', stage: 'ready', message: 'Connected to the host, verified', latencyMs: Math.round(latencyMs), lastVerifiedAt: new Date().toISOString() };
    this.health(this.verifiedHealth);
    probe.resolve(); this.resolve();
  }
  ping(): Promise<void> {
    if (this.probe) return this.probe.promise;
    let resolve!: () => void; let reject!: (error: Error) => void;
    const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    const nonce = crypto.randomUUID(); const timer = setTimeout(() => this.abort(new TurnwireError('PROBE_TIMEOUT', 'Host connectivity probe timed out')), this.options.heartbeatTimeoutMs ?? 5000);
    this.probe = { nonce, started: performance.now(), promise, resolve, reject, timer };
    void this.send('ping', { nonce }).catch(error => this.abort(error)); return promise;
  }
  activate() { this.heartbeat = setInterval(() => { void this.ping().catch(() => {}); }, this.options.heartbeatIntervalMs ?? 15_000); }
  send(kind: SecureMessage['kind'], body: unknown): Promise<void> {
    const task = this.outgoing.then(async () => {
      if (!this.active || !this.channel) throw new TurnwireError('DISCONNECTED', 'Remote connection unavailable');
      const payload = await this.channel.encrypt(secureMessage(kind, body));
      if (!this.active || this.socket.readyState !== WebSocket.OPEN) throw new TurnwireError('DISCONNECTED', 'Remote connection unavailable');
      this.socket.send(JSON.stringify({ type: 'payload', payload }));
    }); this.outgoing = task.catch(() => {}); return task;
  }
  private abort(error: Error) { if (!this.active) return; this.close(error); this.failed(error); }
  close(error: Error = new TurnwireError('DISCONNECTED', 'Connection closed')) {
    if (!this.active) return; this.active = false; clearTimeout(this.deadline); clearInterval(this.heartbeat);
    if (this.probe) { clearTimeout(this.probe.timer); this.probe.reject(error); this.probe = undefined; }
    this.reject(error); this.socket.close();
  }
}
export class RemoteClient implements TurnwireClient {
  private transport?: Transport; private candidates = new Set<Transport>(); private ready?: Promise<void>;
  private stopped = false; private suspended = false; private terminal = false; private generation = 0; private attempts = 0;
  private timer?: ReturnType<typeof setTimeout>; private cursor = 0;
  private listeners = new Set<(event: TurnwireEvent) => void>(); private states = new Set<(state: ConnectionState) => void>(); private state: ConnectionState = 'offline';
  private health: ConnectionHealth = { phase: 'offline', message: 'The host connection is not verified yet' }; private healthListeners = new Set<(health: ConnectionHealth) => void>();
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private saved: Promise<void> = Promise.resolve();
  constructor(private pairing: Pairing, private options: RemoteClientOptions = {}) { this.pairing = pairingSchema.parse(pairing); validateEndpoint(pairing.relayUrl, true); }
  get currentPairing(): Pairing { return structuredClone(this.pairing); }
  observeConnection(listener: (health: ConnectionHealth) => void) { this.healthListeners.add(listener); listener(this.health); return () => { this.healthListeners.delete(listener); }; }
  private healthChanged(values: Partial<ConnectionHealth>) { this.health = { ...this.health, ...values }; for (const listener of this.healthListeners) listener(this.health); }
  private save(value: Pairing) { this.saved = this.saved.then(async () => { await this.options.persistPairing?.(value); this.pairing = value; }); return this.saved; }
  private connect(): Promise<void> {
    if (this.transport) return Promise.resolve(); if (this.ready) return this.ready;
    if (this.stopped || this.suspended || this.terminal) return Promise.reject(new TurnwireError('DISCONNECTED', this.terminal ? this.health.message : 'Connection paused or closed'));
    clearTimeout(this.timer); this.timer = undefined;
    const generation = ++this.generation; const started = performance.now(); this.setState('connecting');
    this.healthChanged({ phase: 'connecting', message: 'Connecting to the remote entry…', attempt: this.attempts + 1, retryInMs: undefined, protocol: this.pairing.v, code: undefined });
    const task = (async () => {
      if (this.pairing.v === 2 && this.pairing.bootstrap && !this.pairing.pendingKey) await this.save({ ...this.pairing, pendingKey: randomSecret() });
      if (generation !== this.generation) throw new Error('Connection cancelled');
      const direct = this.pairing.v === 2 && !this.pairing.bootstrap ? this.pairing.directUrls ?? [] : [];
      const endpoints = [...new Set([...direct, this.pairing.relayUrl])];
      const transports = endpoints.map(url => {
        const route = url === this.pairing.relayUrl ? 'relay' as const : 'direct' as const;
        let transport: Transport;
        transport = new Transport(url, route, this.pairing, this.options, value => {
          if (generation !== this.generation) return;
          if (this.transport === transport || (!this.transport && value.phase !== 'connected' && route === 'relay')) this.healthChanged({ ...value, route, elapsedMs: Math.round(performance.now() - started) });
        }, message => { if (this.transport === transport) this.receive(message); }, error => { if (this.transport === transport) this.lost(error); }, value => this.save(value));
        this.candidates.add(transport); return transport;
      });
      try {
        const winner = await Promise.any(transports.map(async transport => { await transport.ready; return transport; }));
        if (generation !== this.generation) throw new Error('Connection cancelled');
        this.transport = winner; this.attempts = 0;
        for (const transport of transports) if (transport !== winner) transport.close(); this.candidates.clear();
        winner.activate();
        // Only the verified winner subscribes to history or dispatches commands.
        await winner.send('subscribe', { after: this.listeners.size ? this.cursor : 'latest' });
        this.healthChanged({ ...winner.verifiedHealth, phase: 'connected', stage: 'ready', message: 'Connected to the host, verified', route: winner.route, protocol: this.pairing.v, lastVerifiedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), retryInMs: undefined });
        this.setState('connected');
      } catch (error) {
        if (generation !== this.generation) throw error;
        const errors = error instanceof AggregateError ? error.errors as Error[] : [error as Error];
        const failure = errors.find(e => e instanceof TurnwireError && ['UNAUTHORIZED', 'AUTHENTICATION_FAILED'].includes(e.code)) ?? errors.at(-1)!;
        for (const transport of transports) transport.close(); this.candidates.clear(); this.lost(failure); throw failure;
      }
    })();
    this.ready = task; void task.finally(() => { if (this.ready === task) this.ready = undefined; }).catch(() => {}); return task;
  }
  private lost(error: Error) {
    this.transport?.close(); this.transport = undefined; this.ready = undefined; this.rejectPending(); this.setState('offline');
    this.terminal = error instanceof TurnwireError && ['UNAUTHORIZED', 'AUTHENTICATION_FAILED'].includes(error.code);
    const delay = retryDelay(this.attempts++);
    this.healthChanged({ phase: this.terminal ? 'error' : 'offline', message: error.message, code: error instanceof TurnwireError ? error.code : 'CONNECTION_FAILED', retryInMs: this.terminal || this.suspended || this.stopped ? undefined : delay });
    if (!this.terminal && !this.suspended && !this.stopped) { clearTimeout(this.timer); this.timer = setTimeout(() => { this.timer = undefined; void this.connect().catch(() => {}); }, delay); }
  }
  private receive(message: SecureMessage) {
    if (message.kind === 'event') { const event = eventSchema.parse(message.body); if (this.listeners.size && event.seq > this.cursor) { this.cursor = event.seq; for (const listener of this.listeners) listener(event); } }
    if (message.kind === 'response') {
      const response = responseSchema.parse(message.body); const pending = this.pending.get(response.id); if (!pending) return;
      this.pending.delete(response.id); clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response.result); else pending.reject(new TurnwireError(response.error.code, response.error.message));
    }
    if (message.kind === 'routes' && this.pairing.v === 2) {
      const { urls } = z.object({ urls: z.array(z.string().url()).max(4) }).parse(message.body);
      for (const url of urls) validateEndpoint(url, true);
      if (JSON.stringify(urls) !== JSON.stringify(this.pairing.directUrls ?? [])) void this.save({ ...this.pairing, directUrls: urls }).catch(() => {});
    }
  }
  async request<T = unknown>(method: Method, params: unknown = {}, id = crypto.randomUUID()): Promise<T> {
    await this.connect();
    if (this.pending.has(id)) throw new TurnwireError('REQUEST_PENDING', 'This request is already awaiting a result');
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new TurnwireError('OUTCOME_UNKNOWN', `Request result unknown; check it with request ID ${id}`)); }, 35_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      void this.transport!.send('request', { v: 1, id, method, params }).catch(() => { this.pending.delete(id); clearTimeout(timer); reject(new TurnwireError('OUTCOME_UNKNOWN', `Connection interrupted; check the result with request ID ${id}`)); });
    });
  }
  subscribe(listener: (event: TurnwireEvent) => void, state?: (state: ConnectionState) => void, after = 0) {
    this.listeners.add(listener); if (state) { this.states.add(state); state(this.state); } this.cursor = Math.max(this.cursor, after); this.stopped = false;
    if (this.transport) void this.transport.send('subscribe', { after: this.cursor }).catch(() => {}); else void this.connect().catch(() => {});
    return () => { this.listeners.delete(listener); if (state) this.states.delete(state); if (!this.listeners.size) this.close(); };
  }
  /** Foreground/manual reconnect discards zombie sockets and bypasses background backoff. */
  async checkConnection(): Promise<ConnectionHealth> { this.resume(); await this.connect(); return this.health; }
  suspend() { this.suspended = true; this.reset(); this.healthChanged({ phase: 'offline', message: 'Background connection paused; it resumes on return', retryInMs: undefined }); }
  resume() { const reset = this.suspended || this.stopped || this.terminal || !!this.transport; this.suspended = false; this.stopped = false; this.terminal = false; this.attempts = 0; if (reset) this.reset(); void this.connect().catch(() => {}); }
  private reset() { ++this.generation; clearTimeout(this.timer); this.timer = undefined; this.transport?.close(); this.transport = undefined; for (const transport of this.candidates) transport.close(); this.candidates.clear(); this.ready = undefined; this.rejectPending(); this.setState('offline'); }
  private setState(value: ConnectionState) { if (this.state === value) return; this.state = value; for (const listener of this.states) listener(value); }
  private rejectPending() { for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new TurnwireError('OUTCOME_UNKNOWN', `Connection interrupted; check the result with request ID ${id}`)); } this.pending.clear(); }
  close() { this.stopped = true; this.reset(); this.healthChanged({ phase: 'offline', message: 'Connection closed', retryInMs: undefined }); }
}
