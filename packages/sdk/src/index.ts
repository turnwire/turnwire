import { directStatusSchema, directConfigurationSchema, notificationStatusSchema } from '@turnwire/protocol';
import type { DirectStatus, DirectConfiguration, NotificationStatus } from '@turnwire/protocol';
export { acceptClientHandshake, createClientHandshake, SessionChannel } from './session-crypto.js';
export { retryDelay } from './retry.js';
import { historyOrder, connectionPongSchema, eventSchema, TurnwireError, pairingSchema, responseSchema, remoteConfigurationSchema, remoteStatusSchema, pairedDeviceSchema, pairingResultSchema, pairDeviceSchema, revokeDeviceSchema, deploymentConfigSchema, deploymentStatusSchema } from '@turnwire/protocol';
import type { DeploymentConfig, DeploymentStatus } from '@turnwire/protocol';
import type { Method, TurnwireEvent, Pairing, RpcResponse, Snapshot, RemoteConfiguration, RemoteStatus, PairedDevice, PairingResult, Session, HistoryPage } from '@turnwire/protocol';
import { SecureChannel, secureMessage } from './crypto.js';
export { HistoryBuffer } from '@turnwire/protocol';
export type { HistoryPage } from '@turnwire/protocol';
export { SecureChannel, secureMessage, randomSecret } from './crypto.js';
export type ConnectionState = 'connecting' | 'connected' | 'offline';
export interface TurnwireClient {
  request<T = unknown>(method: Method, params?: unknown, id?: string): Promise<T>;
  subscribe(listener: (event: TurnwireEvent) => void, state?: (state: ConnectionState) => void, after?: number): () => void;
  close(): void;
}
function unwrap<T>(response: ReturnType<typeof responseSchema.parse>): T { if (!response.ok) throw new TurnwireError(response.error.code, response.error.message); return response.result as T; }
export function validateEndpoint(value: string, websocket = false): URL {
  const url = new URL(value);
  if (!(websocket ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol) || url.username || url.password) throw new Error('连接地址格式无效');
  if ((url.protocol === 'http:' || url.protocol === 'ws:') && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('远程连接必须使用 HTTPS / WSS');
  return url;
}

export class LocalClient implements TurnwireClient {
  private url: URL; private socket?: WebSocket; private timer?: ReturnType<typeof setTimeout>;
  private stopped = false; private cursor = 0; private listeners = new Set<(event: TurnwireEvent) => void>();
  private states = new Set<(state: ConnectionState) => void>(); private state: ConnectionState = 'offline';
  constructor(url: string, private token: string) { this.url = validateEndpoint(url); }
  private async administration(path: string, method: string, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.url), { method, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok) {
      const value = await response.json().catch(() => undefined) as { error?: string } | undefined;
      throw new TurnwireError(response.status === 401 ? 'UNAUTHORIZED' : 'ADMIN_ERROR', response.status === 401 ? '连接令牌无效，请重新连接' : value?.error ?? `Turnwire 返回 HTTP ${response.status}`);
    }
    return response.json();
  }
  async notificationStatus(): Promise<NotificationStatus> { return notificationStatusSchema.parse(await this.administration('/notifications', 'GET')); }
  async configureNotifications(enabled: boolean): Promise<NotificationStatus> { return notificationStatusSchema.parse(await this.administration('/notifications', 'PUT', { enabled })); }
  async directStatus(): Promise<DirectStatus> { return directStatusSchema.parse(await this.administration('/direct', 'GET')); }
  async configureDirect(value: DirectConfiguration): Promise<DirectStatus> { return directStatusSchema.parse(await this.administration('/direct', 'PUT', directConfigurationSchema.parse(value))); }
  async remoteStatus(): Promise<RemoteStatus> { return remoteStatusSchema.parse(await this.administration('/remote', 'GET')); }
  async configureRemote(value: RemoteConfiguration): Promise<RemoteStatus> { return remoteStatusSchema.parse(await this.administration('/remote', 'PUT', remoteConfigurationSchema.parse(value))); }
  async deploymentStatus(): Promise<DeploymentStatus> { return deploymentStatusSchema.parse(await this.administration('/deployment', 'GET')); }
  async deployRelay(value: Partial<DeploymentConfig>): Promise<DeploymentStatus> { return deploymentStatusSchema.parse(await this.administration('/deployment', 'POST', deploymentConfigSchema.parse(value))); }
  async devices(): Promise<PairedDevice[]> { return pairedDeviceSchema.array().parse(await this.administration('/devices', 'GET')); }
  async pairDevice(name: string): Promise<PairingResult> { return pairingResultSchema.parse(await this.administration('/devices', 'POST', pairDeviceSchema.parse({ name }))); }
  async upgradeDevice(id: string): Promise<PairingResult> { return pairingResultSchema.parse(await this.administration('/devices', 'PUT', revokeDeviceSchema.parse({ id }))); }
  async revokeDevice(id: string): Promise<void> { await this.administration('/devices', 'DELETE', revokeDeviceSchema.parse({ id })); }
  async request<T = unknown>(method: Method, params: unknown = {}, id = crypto.randomUUID()): Promise<T> {
    const response = await fetch(new URL('/rpc', this.url), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` }, body: JSON.stringify({ v: 1, id, method, params }), signal: AbortSignal.timeout(35_000) }).catch(error => { if (method.startsWith('session.') || method === 'approval.decide') throw new TurnwireError('OUTCOME_UNKNOWN', `连接中断，请使用请求 ID ${id} 查询结果`); throw error; });
    if (!response.ok) throw new TurnwireError('HTTP_ERROR', response.status === 401 ? '连接令牌无效，请重新连接' : `Turnwire 返回 HTTP ${response.status}`);
    const result = responseSchema.parse(await response.json()); if (result.id !== id) throw new Error('Response ID mismatch');
    return unwrap<T>(result);
  }
  subscribe(listener: (event: TurnwireEvent) => void, state?: (state: ConnectionState) => void, after = 0) {
    this.listeners.add(listener); if (state) { this.states.add(state); state(this.state); }
    this.cursor = Math.max(this.cursor, after); this.stopped = false;
    if (!this.socket && !this.timer) this.connect();
    return () => { this.listeners.delete(listener); if (state) this.states.delete(state); if (!this.listeners.size) this.close(); };
  }
  private connect() {
    if (this.stopped) return; this.setState('connecting');
    const url = new URL('/events', this.url); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url); this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: this.token, after: this.cursor }));
    socket.onmessage = message => {
      if (this.socket !== socket || this.stopped) return;
      try { const frame = JSON.parse(String(message.data)) as { type: string; event?: unknown; cursor?: number };
        if (frame.type === 'ready') this.setState('connected');
        if (frame.type === 'event') { const event = eventSchema.parse(frame.event); if (event.seq > this.cursor) { this.cursor = event.seq; for (const listener of this.listeners) listener(event); } }
      } catch { socket.close(4002, 'Invalid protocol'); }
    };
    // A failed handshake emits close itself; closing again inside error can recurse in Node.
    socket.onerror = () => {};
    socket.onclose = event => { if (this.socket !== socket) return; this.socket = undefined; this.setState('offline'); if (!this.stopped && event.code !== 4401) this.timer = setTimeout(() => { this.timer = undefined; this.connect(); }, 1500); };
  }
  private setState(state: ConnectionState) { this.state = state; for (const listener of this.states) listener(state); }
  close() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; const socket = this.socket; this.socket = undefined; socket?.close(); this.setState('offline'); }
}

export { RemoteClient } from './remote-client.js';
export type { ConnectionHealth, RemoteClientOptions } from './remote-client.js';

export function encodePairing(pairing: Pairing): string { return btoa(unescape(encodeURIComponent(JSON.stringify(pairing)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
export function decodePairing(value: string): Pairing {
  const input = value.trim().includes('#pair=') ? value.trim().split('#pair=')[1]! : value.trim();
  return pairingSchema.parse(JSON.parse(decodeURIComponent(escape(atob(input.replaceAll('-', '+').replaceAll('_', '/'))))));
}
export interface ConversationMessage { id: string; role: 'user' | 'assistant' | 'tool' | 'error'; text: string; time: string; tool?: string; complete: boolean; input?: string; output?: string; endedAt?: string; isError?: boolean }
export function conversation(events: TurnwireEvent[], sessionId: string): ConversationMessage[] {
  const messages = new Map<string, ConversationMessage>();
  for (const event of [...events].sort(historyOrder)) {
    const d = event.data; if (!('sessionId' in d) || d.sessionId !== sessionId) continue;
    if (d.type === 'message.user' || d.type === 'message.delta' || d.type === 'message.completed') {
      const existing = messages.get(d.messageId);
      messages.set(d.messageId, { id: d.messageId, role: d.type === 'message.user' ? 'user' : 'assistant', text: d.type === 'message.delta' ? (existing?.text ?? '') + d.text : d.text, time: existing?.time ?? event.time, complete: d.type !== 'message.delta' });
    }
    if (d.type === 'tool.started' || d.type === 'tool.finished') {
      const existing = messages.get(d.callId); const finished = d.type === 'tool.finished';
      messages.set(d.callId, { id: d.callId, role: 'tool', text: d.detail, tool: existing?.tool ?? d.tool, time: existing?.time ?? event.time, complete: finished,
        input: finished ? existing?.input : d.detail, output: finished ? d.detail : existing?.output,
        endedAt: finished ? event.time : existing?.endedAt, isError: finished ? d.isError : existing?.isError });
    }
    if (d.type === 'session.error') messages.set('error:' + event.seq, { id: 'error:' + event.seq, role: 'error', text: d.message, time: event.time, complete: true });
  }
  return [...messages.values()];
}
export function loadHistoryPage(client: TurnwireClient, sessionId: string, before?: number, limit = 40): Promise<HistoryPage> {
  return client.request('history.page', { sessionId, limit, ...(before === undefined ? {} : { before }) });
}
/** Full transcript export is explicit; interactive clients use loadHistoryPage. */
export async function loadHistory(client: TurnwireClient, sessionId: string): Promise<TurnwireEvent[]> {
  const events: TurnwireEvent[] = []; let before: number | undefined;
  do { const page = await loadHistoryPage(client, sessionId, before, 100); events.push(...page.events); before = page.nextBefore ?? undefined; } while (before !== undefined);
  return events.sort(historyOrder);
}
export function applyEvent(snapshot: Snapshot, event: TurnwireEvent): Snapshot {
  if (event.seq <= snapshot.cursor) return snapshot;
  const d = event.data;
  let sessions = snapshot.sessions, approvals = snapshot.approvals;
  if ('session' in d) sessions = [d.session, ...sessions.filter(s => s.id !== d.session.id)];
  if ('approval' in d) approvals = d.approval.status === 'pending' ? [...approvals.filter(a => a.id !== d.approval.id), d.approval] : approvals.filter(a => a.id !== d.approval.id);
  const runtimes = d.type === 'runtime.status' ? snapshot.runtimes.map(r => r.id === d.runtimeId ? { ...r, online: d.online, message: d.message } : r) : snapshot.runtimes;
  return { ...snapshot, sessions, approvals, runtimes, cursor: event.seq };
}

export function transcriptMarkdown(session: Session, messages: ConversationMessage[]): string {
  const code = (text: string) => { const longest = Math.max(0, ...text.split('\n').map(line => line.match(/^`*/)?.[0].length ?? 0)); const fence = '`'.repeat(Math.max(3, longest + 1)); return fence + '\n' + text + '\n' + fence; };
  const sections = ['# ' + session.title, '工作目录：' + session.cwd + '\n\n会话：' + session.id];
  for (const message of messages) {
    if (message.role === 'tool') sections.push('## 工具 · ' + message.tool + '\n\n### 输入\n\n' + code(message.input ?? '') + '\n\n### 输出\n\n' + code(message.output ?? '尚未返回'));
    else sections.push('## ' + (message.role === 'user' ? '你' : message.role === 'error' ? '执行错误' : 'Turnwire') + '\n\n' + message.text);
  }
  return sections.join('\n\n') + '\n';
}
