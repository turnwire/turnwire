// Host-side provider boundary. Clients never install or spawn tunnel processes.
export interface TunnelHandle { url: string; close(): Promise<void> }
/** A tunnel the operator already runs under their own account; Turnwire only targets it. */
export interface NamedTunnelOptions {
  /** Tunnel name or id registered with the provider. */
  name: string;
  /** Public hostname the provider routes to this tunnel. */
  hostname: string;
  /** Provider credential file, resolved on the host. */
  credentialsFile: string;
  /** Transport for the tunnel connection. `auto` lets the provider choose. */
  protocol: 'auto' | 'http2' | 'quic';
}
export interface TunnelOptions { directory: string; toolsDirectory?: string; port: number; signal: AbortSignal; progress(message: string): void; exited(): void; token?: string; namedTunnel?: NamedTunnelOptions; changed?(url: string): void }
