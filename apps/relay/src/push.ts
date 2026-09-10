import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import webpush from 'web-push';
import { z } from 'zod';
import { pushSubscriptionSchema } from '@turnwire/protocol';
import type { PushSubscriptionData } from '@turnwire/protocol';

export const pushRequestSchema = z.object({ type: z.literal('push.request'), id: z.string().min(1).max(200), action: z.enum(['status', 'configure', 'subscribe', 'unsubscribe', 'notify']), clientId: z.string().max(200).optional(), subscription: pushSubscriptionSchema.optional(), notificationId: z.string().min(1).max(200).optional(), enabled: z.boolean().optional() }).strict();
export function validatePushEndpoint(value: string) {
  const url = new URL(value);
  const allowed = ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com'];
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash || !allowed.includes(url.hostname)) throw new Error('不支持此推送服务地址');
}
export class RelayPush {
  private stopped = false;
  private db: DatabaseSync; private running?: Promise<void>; private timer: ReturnType<typeof setInterval>;
  private vapid: { publicKey: string; privateKey: string };
  constructor(path: string, private subject: string, private deliver: typeof webpush.sendNotification = webpush.sendNotification) {
    if (!/^mailto:[^\s@]+@[^\s@]+$/.test(subject)) { const url = new URL(subject); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('VAPID subject must be a contact email or HTTPS URL'); }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path); if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions(host TEXT, client TEXT, body TEXT, PRIMARY KEY(host,client));
      CREATE TABLE IF NOT EXISTS notifications(host TEXT, client TEXT, id TEXT, expires INTEGER, retry INTEGER, attempts INTEGER DEFAULT 0, delivered INTEGER DEFAULT 0, PRIMARY KEY(host,client,id));`);
    const saved = this.db.prepare("SELECT body FROM settings WHERE key='vapid'").get();
    this.vapid = saved ? JSON.parse(String(saved.body)) : webpush.generateVAPIDKeys();
    if (!saved) this.db.prepare("INSERT INTO settings VALUES('vapid',?)").run(JSON.stringify(this.vapid));
    this.timer = setInterval(() => { void this.flush(); }, 1000); this.timer.unref();
  }
  get publicKey() { return this.vapid.publicKey; }
  reconcile(host: string, clients: string[]) {
    for (const row of this.db.prepare('SELECT client FROM subscriptions WHERE host=?').all(host)) if (!clients.includes(String(row.client))) this.remove(host, String(row.client));
  }
  private remove(host: string, client: string) { this.db.prepare('DELETE FROM subscriptions WHERE host=? AND client=?').run(host, client); this.db.prepare('DELETE FROM notifications WHERE host=? AND client=?').run(host, client); }
  handle(host: string, allowed: Set<string>, input: unknown) {
    const p = pushRequestSchema.parse(input); const enabled = this.db.prepare('SELECT body FROM settings WHERE key=?').get('enabled:' + host)?.body !== 'false';
    if (p.clientId && !allowed.has(p.clientId)) throw new Error('Unknown paired device');
    if (p.action === 'configure') {
      if (typeof p.enabled !== 'boolean') throw new Error('Missing notification preference');
      this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('enabled:' + host, String(p.enabled));
      if (!p.enabled) this.db.prepare('DELETE FROM notifications WHERE host=?').run(host);
    }
    if (p.action === 'subscribe') {
      if (!p.clientId || !p.subscription) throw new Error('Missing subscription'); validatePushEndpoint(p.subscription.endpoint);
      if (Buffer.from(p.subscription.keys.p256dh, 'base64url').length !== 65 || Buffer.from(p.subscription.keys.auth, 'base64url').length !== 16) throw new Error('Invalid subscription keys');
      this.db.prepare('INSERT OR REPLACE INTO subscriptions VALUES(?,?,?)').run(host, p.clientId, JSON.stringify(p.subscription));
    }
    if (p.action === 'unsubscribe') { if (!p.clientId) throw new Error('Missing device'); this.remove(host, p.clientId); }
    if (p.action === 'notify') {
      if (!p.clientId || !p.notificationId) throw new Error('Missing notification');
      if (!enabled) return { accepted: false, reason: 'disabled' };
      if (!this.db.prepare('SELECT 1 FROM subscriptions WHERE host=? AND client=?').get(host, p.clientId)) return { accepted: false, reason: 'unsubscribed' };
      if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE delivered=0').get()!.n) >= 10000) throw new Error('Push queue full');
      const now = Date.now();
      // Collapse queued hints. The phone always fetches the current inbox after opening.
      this.db.prepare('DELETE FROM notifications WHERE host=? AND client=? AND delivered=0 AND id<>?').run(host, p.clientId, p.notificationId);
      this.db.prepare('INSERT OR IGNORE INTO notifications(host,client,id,expires,retry) VALUES(?,?,?,?,?)').run(host, p.clientId, p.notificationId, now + 86400_000, now);
    }
    return { accepted: true, publicKey: this.publicKey, subscribed: p.clientId ? !!this.db.prepare('SELECT 1 FROM subscriptions WHERE host=? AND client=?').get(host, p.clientId) : false, queued: Number(this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE host=? AND delivered=0').get(host)!.n) };
  }
  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      this.db.prepare('DELETE FROM notifications WHERE expires<?').run(Date.now());
      const rows = this.db.prepare('SELECT n.*,s.body FROM notifications n JOIN subscriptions s ON s.host=n.host AND s.client=n.client WHERE n.delivered=0 AND n.retry<=? LIMIT 20').all(Date.now());
      for (const row of rows) {
        if (this.stopped) break;
        if (!this.db.prepare('SELECT 1 FROM notifications WHERE host=? AND client=? AND id=? AND delivered=0').get(row.host!, row.client!, row.id!)) continue;
        if (this.db.prepare('SELECT body FROM settings WHERE key=?').get('enabled:' + row.host)?.body === 'false') continue;
        const subscription = JSON.parse(String(row.body)) as PushSubscriptionData;
        try {
          validatePushEndpoint(subscription.endpoint);
          await this.deliver(subscription, JSON.stringify({ type: 'inbox', title: 'Turnwire 需要你的处理', body: '打开收件箱查看最新待办。', tag: 'turnwire-inbox' }), { vapidDetails: { subject: this.subject, ...this.vapid }, TTL: Math.max(0, Math.min(3600, Math.floor((Number(row.expires) - Date.now()) / 1000))), urgency: 'normal', topic: 'turnwire-inbox', timeout: 10_000 });
          this.db.prepare('UPDATE notifications SET delivered=1 WHERE host=? AND client=? AND id=?').run(row.host!, row.client!, row.id!);
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) this.remove(String(row.host), String(row.client));
          else this.db.prepare('UPDATE notifications SET attempts=attempts+1,retry=? WHERE host=? AND client=? AND id=?').run(Date.now() + Math.min(3600_000, 5000 * 2 ** Math.min(10, Number(row.attempts))), row.host!, row.client!, row.id!);
        }
      }
    })().finally(() => { this.running = undefined; }); return this.running;
  }
  async close() { this.stopped = true; clearInterval(this.timer); await this.running; this.db.close(); }
}
