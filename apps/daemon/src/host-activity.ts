import { AsyncLocalStorage } from 'node:async_hooks';
import { TurnwireError } from '@turnwire/protocol';

/** Host-owned admission; the core supplies only a maintenance lease counter. */
export class HostActivity {
  private context = new AsyncLocalStorage<{ active: boolean }>();
  private pending = new Set<Promise<unknown>>();
  private closing = false;
  constructor(private enter: (recovery: boolean) => () => void) {}
  run<T>(work: () => T, recovery = false): T {
    const inherited = this.context.getStore()?.active === true;
    if (this.closing && !recovery && !inherited) throw new TurnwireError('MAINTENANCE', 'Host is shutting down');
    const leave = this.enter(recovery || inherited);
    const scope = { active: true };
    const finish = () => { scope.active = false; leave(); };
    try {
      const result = this.context.run(scope, work);
      if (result instanceof Promise) {
        const tracked = result.finally(() => { finish(); this.pending.delete(tracked); });
        this.pending.add(tracked);
        return tracked as T;
      }
      finish(); return result;
    } catch (error) { finish(); throw error; }
  }
  stopIntake() { this.closing = true; }
  async drain() { while (this.pending.size) await Promise.allSettled([...this.pending]); }
}
