// Host-side provider boundary. Clients never install or spawn tunnel processes.
export interface TunnelHandle { url: string; close(): Promise<void> }
export interface TunnelOptions { directory: string; port: number; signal: AbortSignal; progress(message: string): void; exited(): void; token?: string; changed?(url: string): void }
