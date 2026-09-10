import type { PairedDevice } from '@turnwire/protocol';

/** A positive state requires the phone to acknowledge a fresh, encrypted host challenge. */
export class DevicePresence {
  private records = new Map<string, { time: number; observed: number; latencyMs: number; active: boolean }>();
  confirm(id: string, latencyMs: number) { this.records.set(id, { time: Date.now(), observed: performance.now(), latencyMs: Math.max(0, Math.round(latencyMs)), active: true }); }
  disconnect(id?: string) { if (id) { const record = this.records.get(id); if (record) record.active = false; } else for (const record of this.records.values()) record.active = false; }
  get(id: string): Pick<PairedDevice, 'connection' | 'lastConfirmedAt' | 'latencyMs'> {
    const record = this.records.get(id); if (!record) return { connection: 'unconfirmed' };
    return { connection: record.active && performance.now() - record.observed < 25_000 ? 'connected' : 'offline', lastConfirmedAt: new Date(record.time).toISOString(), latencyMs: record.latencyMs };
  }
}
