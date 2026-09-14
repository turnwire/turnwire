import type { EventData, TurnwireEvent } from './index.js';

export const HISTORY_EVENT_BYTES = 64 * 1024;
export const HISTORY_PAGE_BYTES = 512 * 1024;
export const HISTORY_TRUNCATION_MARKER = '\n[Transport preview truncated; full content remains in the host journal.]';
const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** Deterministic transport-only projection. Never write this preview back to the journal. */
export function projectHistoryEvent(event: TurnwireEvent): TurnwireEvent {
  const originalBytes = encodedBytes(event);
  if (originalBytes <= HISTORY_EVENT_BYTES) return event;
  const data = { ...event.data };
  const field = 'text' in data ? 'text' : 'detail' in data ? 'detail' : 'message' in data ? 'message' : undefined;
  if (!field || typeof (data as Record<string, unknown>)[field] !== 'string') throw new Error('History entity exceeds transport limit without a previewable text field');
  const text = (data as Record<string, unknown>)[field] as string;
  const projected = { ...event, data, truncation: { originalBytes, reason: 'transport-preview' as const } };
  let low = 0; let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    (data as Record<string, unknown>)[field] = text.slice(0, middle) + HISTORY_TRUNCATION_MARKER;
    if (encodedBytes(projected) <= HISTORY_EVENT_BYTES) low = middle; else high = middle - 1;
  }
  // Avoid splitting a surrogate pair at the preview boundary.
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
  (data as Record<string, unknown>)[field] = text.slice(0, low) + HISTORY_TRUNCATION_MARKER;
  if (encodedBytes(projected) > HISTORY_EVENT_BYTES) throw new Error('History metadata exceeds transport limit');
  return projected;
}

/** A page contains whole messages / tool calls, never a slice of token deltas. */
export interface HistoryPage { events: TurnwireEvent[]; cursor: number; hasMore: boolean; nextBefore: number | null }
export function historyKey(event: TurnwireEvent): string | undefined {
  const d = event.data;
  if ('messageId' in d) return `${d.sessionId}:message:${d.messageId}`;
  if ('callId' in d) return `${d.sessionId}:tool:${d.callId}`;
  if ('approval' in d) return `${d.approval.sessionId}:approval:${d.approval.id}`;
  // A question is its own entity, so a page carries the asked-and-answered pair as one record.
  if ('question' in d) return `${d.question.sessionId}:question:${d.question.id}`;
  if (d.type === 'session.error') return `${d.sessionId}:error:${event.seq}`;
  return undefined;
}
/** The session an event belongs to. Approvals and questions carry theirs inside the payload. */
export function eventSessionId(data: EventData): string | undefined {
  if ('sessionId' in data) return data.sessionId;
  if ('session' in data) return data.session.id;
  if ('approval' in data) return data.approval.sessionId;
  if ('question' in data) return data.question.sessionId;
  return undefined;
}
/** Display order is independent of the stable originSeq used to page/export records. */
export function historyOrder(a: TurnwireEvent, b: TurnwireEvent): number { return (a.displaySeq ?? a.originSeq ?? a.seq) - (b.displaySeq ?? b.originSeq ?? b.seq) || a.seq - b.seq; }
/** Reduce one entity; keep the tool input alongside its result. Replayed frames are idempotent. */
export function reduceHistory(existing: TurnwireEvent[], event: TurnwireEvent): TurnwireEvent[] {
  if (existing.some(e => e.seq >= event.seq)) return existing;
  const first = existing[0]; const originSeq = first?.originSeq ?? first?.seq ?? event.originSeq ?? event.seq;
  const d = event.data;
  if ('messageId' in d) {
    const previous = first?.data;
    // A prompt that never ran can be patched or taken back after it was journaled. An update keeps
    // the entity it describes — including the fields it does not mention — and a removal drops it.
    if (d.type === 'message.updated') {
      if (previous === undefined || previous.type !== 'message.user') return existing;
      // Only the queued -> running transition moves the row; edits/steer and repeated false do not.
      const displaySeq = previous.queued === true && d.queued === false ? event.seq : first?.displaySeq;
      return [{ ...event, originSeq, ...(displaySeq === undefined ? {} : { displaySeq }), time: first?.time ?? event.time, data: { ...previous, ...(d.text === undefined ? {} : { text: d.text }), ...(d.queued === undefined ? {} : { queued: d.queued }), ...(d.steer === undefined ? {} : { steer: d.steer }) } }];
    }
    if (d.type === 'message.removed') return [];
    const text = d.type === 'message.delta' ? (previous && 'text' in previous ? previous.text : '') + d.text : d.text;
    const displaySeq = event.displaySeq ?? first?.displaySeq;
    return [{ ...(d.type === 'message.delta' && first?.truncation ? { truncation: first.truncation } : {}), ...event, originSeq, ...(displaySeq === undefined ? {} : { displaySeq }), time: first?.time ?? event.time, data: { ...d, text } }];
  }
  const value = { ...event, originSeq };
  if (d.type === 'tool.finished' || d.type === 'approval.resolved' || d.type === 'question.resolved') return [...existing.filter(e => e.data.type === 'tool.started' || e.data.type === 'approval.requested' || e.data.type === 'question.requested'), value];
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
