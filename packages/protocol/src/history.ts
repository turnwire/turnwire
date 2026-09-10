import type { TurnwireEvent } from './index.js';

/** A page contains whole messages / tool calls, never a slice of token deltas. */
export interface HistoryPage { events: TurnwireEvent[]; cursor: number; hasMore: boolean; nextBefore: number | null }
export function historyKey(event: TurnwireEvent): string | undefined {
  const d = event.data;
  if ('messageId' in d) return `${d.sessionId}:message:${d.messageId}`;
  if ('callId' in d) return `${d.sessionId}:tool:${d.callId}`;
  if ('approval' in d) return `${d.approval.sessionId}:approval:${d.approval.id}`;
  if (d.type === 'session.error') return `${d.sessionId}:error:${event.seq}`;
  return undefined;
}
export function historyOrder(a: TurnwireEvent, b: TurnwireEvent): number { return (a.originSeq ?? a.seq) - (b.originSeq ?? b.seq) || a.seq - b.seq; }
/** Reduce one entity; keep the tool input alongside its result. Replayed frames are idempotent. */
export function reduceHistory(existing: TurnwireEvent[], event: TurnwireEvent): TurnwireEvent[] {
  if (existing.some(e => e.seq >= event.seq)) return existing;
  const first = existing[0]; const originSeq = first?.originSeq ?? first?.seq ?? event.originSeq ?? event.seq;
  const d = event.data;
  if ('messageId' in d) {
    const previous = first?.data;
    const text = d.type === 'message.delta' ? (previous && 'text' in previous ? previous.text : '') + d.text : d.text;
    return [{ ...event, originSeq, time: first?.time ?? event.time, data: { ...d, text } }];
  }
  const value = { ...event, originSeq };
  if (d.type === 'tool.finished' || d.type === 'approval.resolved') return [...existing.filter(e => e.data.type === 'tool.started' || e.data.type === 'approval.requested'), value];
  return [value];
}
/** Client projection: bounded by visible records, not the number of streaming tokens. */
export class HistoryBuffer {
  private records = new Map<string, TurnwireEvent[]>();
  // Retain live events while a page is in flight, so a full-text baseline can absorb older deltas.
  private pending?: TurnwireEvent[];
  begin() { this.pending = []; }
  apply(event: TurnwireEvent) {
    this.pending?.push(event);
    const key = historyKey(event); if (key) this.records.set(key, reduceHistory(this.records.get(key) ?? [], event));
  }
  merge(page: HistoryPage, replace = false) {
    const pending = this.pending ?? []; this.pending = undefined;
    if (replace) this.records.clear();
    const keys = new Set(page.events.map(historyKey));
    for (const key of keys) if (key) this.records.delete(key);
    for (const event of [...page.events].sort((a, b) => a.seq - b.seq)) this.apply(event);
    for (const event of pending) if (event.seq > page.cursor && (replace || keys.has(historyKey(event)))) this.apply(event);
  }
  cancel() { this.pending = undefined; }
  get events(): TurnwireEvent[] { return [...this.records.values()].flat().sort(historyOrder); }
}
