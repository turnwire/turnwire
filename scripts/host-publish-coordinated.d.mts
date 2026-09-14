export interface PublicationOptions {
  source: string; target: string; state: string; apply?: boolean; waitMs?: number; pollMs?: number;
  env?: NodeJS.ProcessEnv;
  control?: {
    record(): { supervisorPid: number; dshPid: number; daemonPid: number; generation: number };
    pin(record: unknown): unknown;
    health(): Promise<{ identity: unknown }>;
    request(body?: { action: string; token?: string }): Promise<{ state: string; scope: string; token?: string; busy: number | null; inFlight: number }>;
    signal(record: unknown): void;
    frontend(files: Record<string, Buffer>): Promise<void>;
    remote(body?: unknown): Promise<{ mode: string; provider?: string; relayServerUrl?: string; state?: string; health?: { relayRegistration?: string; tunnelProcess?: string } }>;
  };
  preflight?: (directory: string) => Promise<unknown>;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (message: string) => void;
}
export function coordinatedControl(env: NodeJS.ProcessEnv, target: string): NonNullable<PublicationOptions['control']>;
export function publishCoordinated(options: PublicationOptions): Promise<{ dryRun?: boolean; oldIdentity: unknown; newIdentity: unknown; stage?: string }>;
