import { NotificationController } from './notifications.js';
import { DirectController } from './direct.js';
import { remoteConfigurationSchema } from '@turnwire/protocol';
import type { RemoteMode, RemoteStatus, TunnelProvider, TunnelProviderInfo, PairedDevice } from '@turnwire/protocol';
import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { TurnwireCore } from '@turnwire/core';
import { validateEndpoint } from '@turnwire/sdk';
import { startRelay } from '../../relay/src/server.js';
import { RemoteBridge } from './remote.js';
import type { TunnelHandle, TunnelOptions, NamedTunnelOptions } from './tunnel.js';
import { DevicePresence } from './presence.js';

export type { RemoteMode, RemoteStatus } from '@turnwire/protocol';
interface RelaySettings { serverUrl: string; relayUrl: string; remoteUrl?: string; token: string }
interface Preferences { mode: RemoteMode; relay?: RelaySettings; provider?: TunnelProvider; cpolarToken?: string; namedTunnel?: NamedTunnelOptions }
export interface RemoteAccess {
  status(): RemoteStatus;
  configure(value: unknown): RemoteStatus;
  endpoints(): { relayUrl: string; remoteUrl?: string } | undefined;
  refreshDevices(): void;
  notificationStatus?(): import('@turnwire/protocol').NotificationStatus;
  configureNotifications?(enabled: boolean): import('@turnwire/protocol').NotificationStatus;
  directStatus?(): import('@turnwire/protocol').DirectStatus;
  configureDirect?(value: unknown): import('@turnwire/protocol').DirectStatus;
  deviceStatus?(id: string): Pick<PairedDevice, 'connection' | 'lastConfirmedAt' | 'latencyMs'>;
}
interface Options {
  directory: string; toolsDirectory?: string; webRoot: string;
  initialRelay?: { relayUrl: string; remoteUrl?: string; token: string };
  startTunnel?: (options: TunnelOptions) => Promise<TunnelHandle>;
  notices?: string[];
  providers?: Array<TunnelProviderInfo & { start: (options: TunnelOptions) => Promise<TunnelHandle> }>;
}

/** Owns transport changes independently of the core and DSH session lifecycle. */
export class RemoteController implements RemoteAccess {
  private preferences: Preferences;
  readonly direct: DirectController;
  readonly notifications: NotificationController;
  private presence = new DevicePresence();
  private phase: RemoteStatus['state'] = 'off'; private message = 'Remote access is off';
  private active?: { relayUrl: string; remoteUrl?: string };
  private bridge?: RemoteBridge; private relay?: Awaited<ReturnType<typeof startRelay>>; private tunnel?: TunnelHandle;
  private operation: Promise<void> = Promise.resolve(); private aborter?: AbortController; private disposed = false;
  constructor(private core: TurnwireCore, private options: Options) {
    this.notifications = new NotificationController(core);
    this.direct = new DirectController(core, () => this.active?.remoteUrl ?? this.preferences?.relay?.remoteUrl, () => this.preferences?.mode !== 'off');
    const saved = core.store.setting<Preferences>('remote-preferences');
    if (saved) { this.preferences = saved; return; }
    const initial = options.initialRelay;
    if (initial) {
      validateEndpoint(initial.relayUrl, true);
      if (initial.remoteUrl) validateEndpoint(initial.remoteUrl);
      if (initial.token.length < 32) throw new Error('TURNWIRE_RELAY_TOKEN must contain at least 32 characters');
    }
    this.preferences = initial ? { mode: 'relay', relay: { ...initial, serverUrl: initial.remoteUrl ?? initial.relayUrl.replace(/^ws/, 'http').replace(/\/relay\/?$/, '') } } : { mode: 'off' };
  }
  start() { this.schedule(this.preferences); }
  status(): RemoteStatus {
    let state = this.phase; let message = this.message;
    if (this.phase === 'online' || this.phase === 'offline') {
      state = this.bridge?.connected ? 'online' : 'offline';
      message = state === 'online' ? 'Channel is ready; check paired devices for phone connection status' : this.bridge?.statusMessage ?? 'Connecting to the remote service…';
    }
    return { mode: this.preferences.mode, state, message, ...this.active, relayServerUrl: this.preferences.relay?.serverUrl, hasRelayToken: !!this.preferences.relay?.token, provider: this.preferences.provider ?? 'cloudflare', hasCpolarToken: !!this.preferences.cpolarToken, providers: (this.options.providers ?? []).map(({ start, ...info }) => info), notices: this.preferences.mode === 'temporary' ? [this.options.providers?.find(p => p.id === (this.preferences.provider ?? 'cloudflare'))?.description, ...(this.options.notices ?? [])].filter((s): s is string => !!s) : [] };
  }
  configure(value: unknown): RemoteStatus {
    if (this.disposed) throw new Error('The remote service is shutting down');
    const parsed = remoteConfigurationSchema.safeParse(value);
    if (!parsed.success) throw new Error('Invalid remote configuration; check the channel name, address, and token format (Relay keys must be 32–500 characters)');
    const request = parsed.data;
    const next: Preferences = { ...this.preferences, mode: request.mode };
    if (request.mode === 'temporary') {
      next.provider = request.provider ?? this.preferences.provider ?? 'cloudflare';
      if (request.cpolarToken && next.provider !== 'cpolar') throw new Error('The cpolar token can only be used with the cpolar channel');
      if (request.cpolarToken) next.cpolarToken = request.cpolarToken;
      if (next.provider === 'cpolar' && !next.cpolarToken) throw new Error('First cpolar use: enter the account Auth Token');
      // A named tunnel already exists under the operator's account; only its reference is stored.
      if (request.namedTunnel) next.namedTunnel = request.namedTunnel;
      if (next.provider === 'cloudflare-named' && !next.namedTunnel) throw new Error('A named tunnel requires a tunnel name, public hostname, and credentials file');
      if (!this.options.providers?.some(p => p.id === next.provider) && !(next.provider === 'cloudflare' && this.options.startTunnel)) throw new Error('This daemon does not include the selected channel; update the service');
    }
    if (request.mode === 'relay') {
      const url = validateEndpoint(request.serverUrl);
      if (url.search || url.hash) throw new Error('The server address cannot contain query parameters or a fragment');
      const serverUrl = url.href.replace(/\/$/, '');
      const saved = this.preferences.relay;
      const token = request.token ?? (saved?.serverUrl === serverUrl ? saved.token : undefined);
      if (!token) throw new Error('Enter the Relay connection key for this server');
      const relayUrl = new URL(serverUrl + '/relay'); relayUrl.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      next.relay = { serverUrl, remoteUrl: serverUrl, relayUrl: relayUrl.href, token };
    }
    this.core.store.setSetting('remote-preferences', next);
    this.preferences = next; this.schedule(next); return this.status();
  }
  endpoints() { return this.bridge?.connected ? this.active : undefined; }
  refreshDevices() { this.bridge?.refreshDevices(); this.direct.refreshDevices(); }
  notificationStatus() { return this.notifications.status(); }
  configureNotifications(enabled: boolean) { return this.notifications.configure(enabled); }
  directStatus() { return this.direct.status(); }
  configureDirect(value: unknown) { return this.direct.configure(value); }
  deviceStatus(id: string) { const direct = this.direct.presence.get(id); const relay = this.presence.get(id); return direct.connection === 'connected' || relay.connection === 'unconfirmed' ? direct : relay; }
  private schedule(preferences: Preferences) {
    this.direct.start();
    this.aborter?.abort(); const aborter = new AbortController(); this.aborter = aborter;
    this.phase = preferences.mode === 'off' ? 'off' : 'starting';
    this.message = preferences.mode === 'off' ? 'Remote access is off' : 'Turning on remote access…';
    this.active = undefined;
    this.operation = this.operation.catch(() => {}).then(async () => {
      await this.release();
      if (aborter.signal.aborted || preferences.mode === 'off') return;
      try {
        let token: string; let relayUrl: string; let remoteUrl: string | undefined; let bridgeUrl: string | undefined;
        if (preferences.mode === 'temporary') {
          const provider = preferences.provider ?? 'cloudflare';
          const startTunnel = this.options.providers?.find(p => p.id === provider)?.start ?? (provider === 'cloudflare' ? this.options.startTunnel : undefined);
          if (!startTunnel) throw new Error('The selected tunnel service is not configured; update the daemon');
          await access(join(this.options.webRoot, 'index.html')).catch(() => { throw new Error('The phone page is not built yet; run npm run build first'); });
          token = randomBytes(32).toString('hex');
          this.relay = await startRelay({ token, port: 0, host: '127.0.0.1', webRoot: this.options.webRoot });
          bridgeUrl = 'ws://127.0.0.1:' + this.relay.port + '/relay';
          aborter.signal.throwIfAborted();
          this.tunnel = await startTunnel({
            directory: this.options.directory, toolsDirectory: this.options.toolsDirectory, port: this.relay.port, signal: aborter.signal, ...(provider === 'cpolar' ? { token: preferences.cpolarToken } : {}), ...(preferences.namedTunnel ? { namedTunnel: preferences.namedTunnel } : {}),
            changed: url => { if (!aborter.signal.aborted && this.active) { this.active = { remoteUrl: url, relayUrl: url.replace(/^http/, 'ws') + '/relay' }; } },
            progress: message => { if (!aborter.signal.aborted) this.message = message; },
            exited: () => {
              if (aborter.signal.aborted) return;
              this.phase = 'error'; this.message = 'The temporary channel stopped; turn it on again — the new address requires re-pairing'; this.active = undefined;
              aborter.abort(); this.operation = this.operation.then(() => this.release());
            },
          });
          remoteUrl = this.tunnel.url;
          relayUrl = remoteUrl.replace(/^http/, 'ws') + '/relay';
        } else {
          if (!preferences.relay) throw new Error('Fill in the self-hosted Relay configuration first');
          ({ token, relayUrl, remoteUrl } = preferences.relay);
        }
        aborter.signal.throwIfAborted();
        this.active = { relayUrl, remoteUrl };
        this.bridge = new RemoteBridge(this.core, bridgeUrl ?? relayUrl, token, this.presence, () => this.direct.endpoints()); this.notifications.attach(this.bridge, relayUrl); this.bridge.start(); this.phase = 'offline';
      } catch (error) {
        await this.release();
        if (!aborter.signal.aborted) { this.active = undefined; this.phase = 'error'; this.message = error instanceof Error ? error.message : 'Failed to start remote access'; }
      }
    });
  }
  private async release() {
    this.presence.disconnect(); this.notifications.detach();
    await this.bridge?.close(); this.bridge = undefined;
    await this.tunnel?.close(); this.tunnel = undefined;
    await this.relay?.close(); this.relay = undefined;
  }
  async close() { this.disposed = true; this.aborter?.abort(); await this.operation; await this.release(); await this.direct.close(); await this.notifications.close(); }
}
