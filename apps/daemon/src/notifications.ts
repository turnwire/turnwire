import { randomUUID } from 'node:crypto';
import type { TurnwireCore, NotificationService } from '@turnwire/core';
import { notificationStatusSchema, pushSubscriptionSchema } from '@turnwire/protocol';
import type { NotificationStatus, PushSubscriptionData } from '@turnwire/protocol';
import type { RemoteBridge } from './remote.js';
import { HostActivity } from './host-activity.js';

/** The daemon owns approval state and a durable outbox; Relay receives generic hints only. */
export class NotificationController implements NotificationService {
  private bridge?: RemoteBridge; private namespace = ''; private publicKey?: string;
  private enabled: boolean; private subscriptions: Record<string, PushSubscriptionData> = {};
  private pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private lastError?: string; private timer: ReturnType<typeof setInterval>; private running?: Promise<void>; private stopped = false; private generation = 0;
  private operations = new Set<Promise<unknown>>();
  constructor(private core: TurnwireCore, private activity = new HostActivity(recovery => core.enterHostActivity(recovery))) {
    this.enabled = core.store.setting<boolean>('notifications-enabled') ?? true;
    this.timer = setInterval(() => { void this.flush().catch(() => {}); }, 1000); this.timer.unref(); core.notifications = this;
  }
  private run<T>(work: () => Promise<T>, recovery = false): Promise<T> {
    try {
      if (this.stopped) return Promise.reject(new Error('Notification controller is closed'));
      const operation = this.activity.run(work, recovery);
      this.operations.add(operation);
      void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
      return operation;
    } catch (error) { return Promise.reject(error); }
  }
  private key(name: string) { return `notifications:${this.namespace}:${name}`; }
  attach(bridge: RemoteBridge, namespace: string) {
    return this.activity.run(() => {
    if (this.stopped) throw new Error('Notification controller is closed');
    ++this.generation; this.bridge = bridge; this.namespace = namespace; this.publicKey = undefined;
    this.subscriptions = this.core.store.setting(this.key('subscriptions')) ?? {};
    if (this.core.store.setting(this.key('cursor')) === undefined) this.core.store.setSetting(this.key('cursor'), this.core.store.cursor());
    bridge.onControl = frame => {
      if (this.bridge !== bridge || this.stopped) return;
      if (frame.type === 'ready') { this.publicKey = (frame.push as { publicKey?: string } | undefined)?.publicKey; void this.restore().catch(() => {}); }
      if (frame.type === 'push.response' && typeof frame.id === 'string') {
        const pending = this.pending.get(frame.id); if (!pending) return; this.pending.delete(frame.id); clearTimeout(pending.timer);
        if (frame.ok) pending.resolve(frame.result as Record<string, unknown>); else pending.reject(new Error(typeof frame.error === 'string' ? frame.error : 'Push service request failed'));
      }
    };
    });
  }
  detach() { ++this.generation; this.bridge = undefined; this.publicKey = undefined; for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Relay disconnected')); } this.pending.clear(); }
  status(clientId?: string): NotificationStatus {
    return notificationStatusSchema.parse({ enabled: this.enabled, available: !!this.publicKey && !!this.bridge?.connected, subscribed: !!clientId && !!this.subscriptions[clientId], publicKey: this.publicKey,
      queued: this.namespace ? Object.keys(this.core.store.setting<Record<string, string>>(this.key('outbox')) ?? {}).length : 0, lastError: this.lastError,
      message: !this.enabled ? 'Host notifications are off' : !this.bridge?.connected ? 'Relay is offline; pending items stay in the host inbox' : !this.publicKey ? 'This Relay does not have Web Push configured; temporary addresses do not support long-term notifications' : 'Push service is ready; authorize notifications on your phone' });
  }
  configure(enabled: boolean) {
    return this.activity.run(() => {
      if (this.stopped) throw new Error('Notification controller is closed');
      this.enabled = enabled; this.core.store.setSetting('notifications-enabled', enabled);
      if (!enabled && this.namespace) this.core.store.setSetting(this.key('outbox'), {});
      void this.restore().catch(() => {}); return this.status();
    }, !enabled);
  }
  subscribe(clientId: string, value: PushSubscriptionData) {
    return this.run(async () => {
    const generation = this.generation;
    if (!this.enabled) throw new Error('Host notifications are off');
    const subscription = pushSubscriptionSchema.parse(value);
    await this.rpc({ action: 'subscribe', clientId, subscription });
    if (generation !== this.generation || this.stopped) throw new Error('Relay disconnected');
    this.subscriptions[clientId] = subscription; this.core.store.setSetting(this.key('subscriptions'), this.subscriptions);
    if (this.core.store.approvals().some(a => a.status === 'pending')) this.queue(clientId);
    return this.status(clientId);
    });
  }
  unsubscribe(clientId: string) {
    return this.run(async () => {
    // Persist the local opt-out even if Relay is temporarily unavailable.
    delete this.subscriptions[clientId]; this.core.store.setSetting(this.key('subscriptions'), this.subscriptions);
    const outbox = this.core.store.setting<Record<string, string>>(this.key('outbox')) ?? {}; delete outbox[clientId]; this.core.store.setSetting(this.key('outbox'), outbox);
    const removed = new Set(this.core.store.setting<string[]>(this.key('removed')) ?? []); removed.add(clientId); this.core.store.setSetting(this.key('removed'), [...removed]);
    if (this.bridge?.connected && this.publicKey) await this.restore(); return this.status(clientId);
    }, true);
  }
  private queue(clientId: string) { const outbox = this.core.store.setting<Record<string, string>>(this.key('outbox')) ?? {}; outbox[clientId] = randomUUID(); this.core.store.setSetting(this.key('outbox'), outbox); }
  private rpc(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.bridge?.connected || !this.publicKey) return Promise.reject(new Error('Push service is currently unavailable'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Push service response timed out')); }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.bridge!.sendControl({ type: 'push.request', id, ...value }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private restore() {
    return this.run(async () => {
    if (!this.publicKey || !this.bridge?.connected) return;
    const generation = this.generation;
    try {
      await this.rpc({ action: 'configure', enabled: this.enabled });
      if (generation !== this.generation || this.stopped) return;
      const removed = this.core.store.setting<string[]>(this.key('removed')) ?? [];
      for (const clientId of removed) { if (this.core.store.devices().some(d => d.clientId === clientId)) await this.rpc({ action: 'unsubscribe', clientId }); if (generation !== this.generation || this.stopped) return; }
      this.core.store.setSetting(this.key('removed'), []);
      for (const [clientId, subscription] of Object.entries(this.subscriptions)) {
        if (!this.core.store.devices().some(d => d.clientId === clientId)) { delete this.subscriptions[clientId]; continue; }
        await this.rpc({ action: 'subscribe', clientId, subscription });
        if (generation !== this.generation || this.stopped) return;
      }
      this.core.store.setSetting(this.key('subscriptions'), this.subscriptions); this.lastError = undefined;
    } catch (error) { this.lastError = error instanceof Error ? error.message : 'Failed to restore the push service'; }
    });
  }
  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run(async () => {
      if (!this.namespace || this.stopped) return;
      const generation = this.generation; const store = this.core.store; let cursor = store.setting<number>(this.key('cursor')) ?? store.cursor();
      const events = store.events(cursor, 1000);
      store.db.exec('BEGIN IMMEDIATE');
      try {
        for (const event of events) { if (this.enabled && event.data.type === 'approval.requested' && store.approval(event.data.approval.id)?.status === 'pending') for (const id of Object.keys(this.subscriptions)) this.queue(id); cursor = event.seq; }
        store.setSetting(this.key('cursor'), cursor); store.db.exec('COMMIT');
      } catch (error) { store.db.exec('ROLLBACK'); throw error; }
      if (!this.enabled || !this.publicKey || !this.bridge?.connected) return;
      const outbox = store.setting<Record<string, string>>(this.key('outbox')) ?? {};
      for (const [clientId, notificationId] of Object.entries(outbox)) {
        if (!this.subscriptions[clientId] || !store.devices().some(d => d.clientId === clientId) || !store.approvals().some(a => a.status === 'pending')) { delete outbox[clientId]; store.setSetting(this.key('outbox'), outbox); continue; }
        const result = await this.rpc({ action: 'notify', clientId, notificationId });
        if (generation !== this.generation || this.stopped) return;
        if (result.reason === 'unsubscribed') { delete this.subscriptions[clientId]; store.setSetting(this.key('subscriptions'), this.subscriptions); }
        const latest = store.setting<Record<string, string>>(this.key('outbox')) ?? {};
        if (latest[clientId] === notificationId) delete latest[clientId]; store.setSetting(this.key('outbox'), latest);
      }
      this.lastError = undefined;
    }).catch(error => { if (!this.stopped) this.lastError = error instanceof Error ? error.message : 'Push not delivered yet'; }).finally(() => { this.running = undefined; }); return this.running;
  }
  async close() {
    this.stopped = true; clearInterval(this.timer); this.detach();
    // The activity is shared with other host controllers; only drain our own work.
    while (this.operations.size) await Promise.allSettled([...this.operations]);
    await this.running;
  }
}
