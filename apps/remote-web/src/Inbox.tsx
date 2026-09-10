import { useEffect, useState } from 'react';
import type { TurnwireClient } from '@turnwire/sdk';
import type { InboxPage, NotificationStatus } from '@turnwire/protocol';

export function Inbox({ client, cursor, connected, onOpen, remember }: { client: TurnwireClient; cursor: number; connected: boolean; onOpen: (id: string) => void; remember: () => void }) {
  const [items, setItems] = useState<InboxPage['items']>([]); const [before, setBefore] = useState<number | null>(null); const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notifications, setNotifications] = useState<NotificationStatus>();
  const [requestId, setRequestId] = useState(''); const [result, setResult] = useState('');
  async function load(older?: number) {
    const page = await client.request<InboxPage>('inbox.page', { status: all ? 'all' : 'pending', before: older });
    setItems(current => older ? [...current.filter(item => !page.items.some(next => next.approval.id === item.approval.id)), ...page.items] : page.items); setBefore(page.nextBefore);
  }
  useEffect(() => {
    let active = true; if (!connected) return;
    void client.request<InboxPage>('inbox.page', { status: all ? 'all' : 'pending' }).then(page => { if (active) { setItems(page.items); setBefore(page.nextBefore); } }).catch(error => { if (active) setError(String(error)); });
    void client.request<NotificationStatus>('notifications.status').then(value => { if (active) setNotifications(value); }).catch(() => {});
    return () => { active = false; };
  }, [client, cursor, connected, all]);
  async function act(action: () => Promise<unknown>) { setBusy(true); setError(''); try { await action(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }
  async function enable() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('此浏览器尚不支持通知；iPhone 请先将页面添加到主屏幕再打开。');
    if (!notifications?.publicKey) throw new Error('请先在主机配置支持推送的固定 Relay');
    // Permission is requested directly from the button gesture, before other asynchronous work.
    if (await Notification.requestPermission() !== 'granted') throw new Error('通知尚未获得授权，请在系统设置中允许 Turnwire 通知。');
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
  return <section className="inbox-view"><div className="inbox-heading"><div><h1>收件箱</h1><p>所有会话中需要你处理的操作。</p></div><label><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} />包含已处理</label></div>
    <div className="notification-settings"><div><strong>离开页面也能收到提醒</strong><p>{notifications?.message ?? '正在读取通知状态…'}</p><small>iPhone 请先添加到主屏幕。通知只显示待办提醒，详情在连接主机后读取。</small></div><button disabled={busy || !connected || !notifications?.available || !notifications.enabled} onClick={() => void act(notifications?.subscribed ? disable : enable)}>{notifications?.subscribed ? '关闭本设备通知' : '启用通知并记住设备'}</button></div>
    {error && <p role="alert">{error}</p>}
    {!items.length && <p className="inbox-empty">{connected ? '暂无待办。' : '连接主机后更新收件箱。'}</p>}
    {items.map(({ approval, sessionTitle }) => <article className="inbox-item" key={approval.id}><div><button onClick={() => onOpen(approval.sessionId)}>{sessionTitle}</button><span>{({ pending: '待处理', approved: '已批准', rejected: '已拒绝', cancelled: '已失效' })[approval.status]}</span></div><strong>{approval.tool}</strong><p>{approval.reason}</p><time>{new Date(approval.createdAt).toLocaleString()}</time>{approval.status === 'pending' && <div className="approval-actions"><button disabled={!connected || busy} onClick={() => void act(async () => { await client.request('approval.decide', { approvalId: approval.id, decision: 'rejected' }); await load(); })}>拒绝</button><button className="primary" disabled={!connected || busy} onClick={() => void act(async () => { await client.request('approval.decide', { approvalId: approval.id, decision: 'approved' }); await load(); })}>批准本次</button></div>}</article>)}
    {before !== null && <button disabled={!connected || busy} onClick={() => void act(() => load(before))}>加载更早待办</button>}
    <details className="request-result"><summary>查询未确认的操作结果</summary><form onSubmit={e => { e.preventDefault(); void act(async () => setResult(JSON.stringify(await client.request('request.result', { requestId }), null, 2))); }}><label>请求 ID<input value={requestId} onChange={e => setRequestId(e.target.value)} required /></label><button disabled={!connected || busy}>查询</button></form>{result && <pre>{result}</pre>}</details>
  </section>;
}
