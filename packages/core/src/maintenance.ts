import { randomUUID } from 'node:crypto';
import { TurnwireError, maintenanceRequestSchema } from '@turnwire/protocol';
import type { MaintenanceStatus } from '@turnwire/protocol';
import type { Store } from './store.js';
import { compactStore } from './storage-maintenance.js';

/** Synchronous admission and durable lease changes share a single event-loop critical section. */
export class MaintenanceGate {
  private token?: string;
  private active = 0;
  private revision = 0;
  constructor(private store: Store, private probe: () => Promise<number>) {
    const saved = store.setting<unknown>('maintenance-hold');
    if (saved !== undefined && saved !== null) {
      if (typeof saved !== 'string' || !saved) throw new Error('Invalid durable maintenance hold');
      this.token = saved;
    }
  }
  get held() { return this.token !== undefined; }
  changed() { this.revision++; }
  enter(allowedDuringDrain: boolean): () => void {
    if (this.held && !allowedDuringDrain) throw new TurnwireError('MAINTENANCE', 'Maintenance is draining; new commands are paused until local administration resumes intake');
    this.active++; this.changed();
    return () => { this.active--; this.changed(); };
  }
  async configure(value: unknown): Promise<MaintenanceStatus> {
    const input = maintenanceRequestSchema.parse(value);
    if (input.action === 'begin') {
      if (this.token && input.token !== this.token) throw new TurnwireError('MAINTENANCE_LEASE', 'Maintenance is held by another lease; retrieve local status to recover its token');
      if (!this.token) {
        if (input.token) throw new TurnwireError('MAINTENANCE_LEASE', 'The maintenance lease is no longer held');
        const token = randomUUID();
        this.store.setSetting('maintenance-hold', token); this.token = token; this.changed();
      }
    } else if (input.action === 'compact') {
      const revision = this.revision;
      if (!this.token || input.token !== this.token) throw new TurnwireError('MAINTENANCE_LEASE', 'Maintenance token does not match the active lease');
      const status = await this.status();
      if (status.state !== 'ready' || revision !== this.revision || this.active || input.token !== this.token) throw new TurnwireError('MAINTENANCE_BUSY', 'Compaction requires a stable drained maintenance lease');
      // No await between the final lease check and SQLite maintenance.
      compactStore(this.store);
    } else {
      if (!this.token || input.token !== this.token) throw new TurnwireError('MAINTENANCE_LEASE', 'Maintenance token does not match the active lease');
      this.store.setSetting('maintenance-hold', null); this.token = undefined; this.changed();
    }
    return this.status();
  }
  async status(): Promise<MaintenanceStatus> {
    const revision = this.revision;
    let busy: number | null = null;
    let reason: string | undefined;
    try {
      busy = await this.probe();
      if (!Number.isSafeInteger(busy) || busy < 0) throw new Error('Runtime activity is unknown');
    } catch { busy = null; reason = 'Managed runtime activity could not be verified'; }
    const stable = revision === this.revision;
    if (!stable) { busy = null; reason = 'Activity changed during the drain check; check again'; }
    return { state: !this.held ? 'accepting' : stable && !this.active && busy === 0 ? 'ready' : 'draining', scope: 'turnwire-managed', ...(this.token ? { token: this.token } : {}), inFlight: this.active, busy, ...(reason ? { reason } : {}) };
  }
}
