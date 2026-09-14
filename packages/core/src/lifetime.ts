import { TurnwireError } from '@turnwire/protocol';

/** Shutdown ownership is independent of maintenance authorization. Admission is synchronous. */
export class CoreLifetime {
  private closing = false;
  private active = 0;
  private draining = false;
  private drained?: () => void;
  get sealed() { return this.closing; }
  seal() { this.closing = true; }
  assertOpen() { if (this.closing) throw new TurnwireError('CORE_CLOSING', 'Core is shutting down'); }
  enter(hostRecovery = false): () => void {
    if (!hostRecovery || this.draining) this.assertOpen();
    this.active++;
    let left = false;
    return () => { if (left) return; left = true; if (--this.active === 0) { this.drained?.(); this.drained = undefined; } };
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const leave = this.enter();
    try { return await operation(); } finally { leave(); }
  }
  async drain() {
    this.seal(); this.draining = true;
    if (this.active) await new Promise<void>(resolve => { this.drained = resolve; });
  }
}
