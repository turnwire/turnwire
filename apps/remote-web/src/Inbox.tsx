import { useEffect, useState } from 'react';
import type { TurnwireClient } from '@turnwire/sdk';
import type { InboxPage, NotificationStatus } from '@turnwire/protocol';
import { useLocale, errorText } from './i18n';

export function Inbox({ client, cursor, connected, onOpen, remember }: { client: TurnwireClient; cursor: number; connected: boolean; onOpen: (id: string) => void; remember: () => void }) {
  const t = useLocale();
  const [items, setItems] = useState<InboxPage['items']>([]); const [before, setBefore] = useState<number | null>(null); const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notifications, setNotifications] = useState<NotificationStatus>();
  const [requestId, setRequestId] = useState(''); const [result, setResult] = useState('');
  async function load(older?: number) {
    const page = await client.request<InboxPage>('inbox.page', { status: all ? 'all' : 'pending', before: older });
    setItems(current => older ? [...current.filter(item => !page.items.some(next => next.approval.id === item.approval.id)), ...page.items] : page.items); setBefore(page.nextBefore);
  }
  useEffect(() => {
    let active = true; if (!connected) return;
    void client.request<InboxPage>('inbox.page', { status: all ? 'all' : 'pending' }).then(page => { if (active) { setItems(page.items); setBefore(page.nextBefore); } }).catch(error => { if (active) setError(errorText(error)); });
    void client.request<NotificationStatus>('notifications.status').then(value => { if (active) setNotifications(value); }).catch(() => {});
    return () => { active = false; };
  }, [client, cursor, connected, all]);
  async function act(action: () => Promise<unknown>) { setBusy(true); setError(''); try { await action(); } catch (error) { setError(errorText(error)); } finally { setBusy(false); } }
  async function enable() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error(t('inbox.pushUnsupported'));
    if (!notifications?.publicKey) throw new Error(t('inbox.needRelay'));
    // Permission is requested directly from the button gesture, before other asynchronous work.
    if (await Notification.requestPermission() !== 'granted') throw new Error(t('inbox.notAuthorised'));
    remember();
    const registration = await navigator.serviceWorker.ready;
    let existing = await registration.pushManager.getSubscription();
    const key = notifications.publicKey.replaceAll('-', '+').replaceAll('_', '/');
    if (existing) { const currentKey = existing.options.applicationServerKey; const expected = Uint8Array.from(atob(key), c => c.charCodeAt(0)); if (!currentKey || new Uint8Array(currentKey).length !== expected.length || !new Uint8Array(currentKey).every((byte, index) => byte === expected[index])) { await existing.unsubscribe(); existing = null; } }
    const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key), c => c.charCodeAt(0)) });
    const value = subscription.toJSON();
    setNotifications(await client.request<NotificationStatus>('notifications.subscribe', { endpoint: value.endpoint, keys: value.keys }));
  }
  async function disable() {
    const registration = await navigator.serviceWorker.ready;
    await (await registration.pushManager.getSubscription())?.unsubscribe();
    setNotifications(await client.request<NotificationStatus>('notifications.unsubscribe'));
  }
  return <section className="inbox-view"><div className="inbox-heading"><div><h1>{t('inbox.title')}</h1><p>{t('inbox.subtitle')}</p></div><label><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} />{t('inbox.includeHandled')}</label></div>
    <div className="notification-settings"><div><strong>{t('inbox.remindersTitle')}</strong><p>{notifications?.message ?? t('inbox.loadingStatus')}</p><small>{t('inbox.iosHint')}</small></div><button disabled={busy || !connected || !notifications?.available || !notifications.enabled} onClick={() => void act(notifications?.subscribed ? disable : enable)}>{notifications?.subscribed ? t('inbox.disable') : t('inbox.enable')}</button></div>
    {error && <p role="alert">{error}</p>}
    {!items.length && <p className="inbox-empty">{connected ? t('inbox.emptyConnected') : t('inbox.emptyDisconnected')}</p>}
    {items.map(({ approval, sessionTitle }) => <article className="inbox-item" key={approval.id}><div><button onClick={() => onOpen(approval.sessionId)}>{sessionTitle}</button><span>{({ pending: t('inbox.status.pending'), approved: t('inbox.status.approved'), rejected: t('inbox.status.rejected'), cancelled: t('inbox.status.cancelled') })[approval.status]}</span></div><strong>{approval.tool}</strong><p>{approval.reason}</p><time>{new Date(approval.createdAt).toLocaleString()}</time>{approval.status === 'pending' && <div className="approval-actions"><button disabled={!connected || busy} onClick={() => void act(async () => { await client.request('approval.decide', { approvalId: approval.id, decision: 'rejected' }); await load(); })}>{t('common.reject')}</button><button className="primary" disabled={!connected || busy} onClick={() => void act(async () => { await client.request('approval.decide', { approvalId: approval.id, decision: 'approved' }); await load(); })}>{t('common.approveOnce')}</button></div>}</article>)}
    {before !== null && <button disabled={!connected || busy} onClick={() => void act(() => load(before))}>{t('inbox.loadEarlier')}</button>}
    <details className="request-result"><summary>{t('inbox.requestResult')}</summary><form onSubmit={e => { e.preventDefault(); void act(async () => setResult(JSON.stringify(await client.request('request.result', { requestId }), null, 2))); }}><label>{t('inbox.requestId')}<input value={requestId} onChange={e => setRequestId(e.target.value)} required /></label><button disabled={!connected || busy}>{t('inbox.check')}</button></form>{result && <pre>{result}</pre>}</details>
  </section>;
}
