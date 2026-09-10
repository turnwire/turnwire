import { z } from 'zod';
import type { SubagentHistoryRecord } from '@turnwire/protocol';
import { assistantId, compactText, record, textContent, wireEventSchema, type WireEvent } from './mapper.js';

export const historyPageSchema = z.object({ records: z.array(z.object({ type: z.literal('event'), event: wireEventSchema })).max(10_000), hasMore: z.boolean() });
export const historySnapshotSchema = historyPageSchema.extend({ type: z.literal('snapshot'), cursor: z.number().int().min(-1), header: z.object({ isSeeded: z.boolean() }).passthrough(), projections: z.unknown().optional(), assistantStream: z.unknown().optional() });
export type HistorySnapshot = z.infer<typeof historySnapshotSchema>;
const bounded = (text: string) => text.length > 32_000 ? `${text.slice(0, 32_000)}\n[truncated]` : text;
const time = (ms: number) => new Date(Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? ms : 0).toISOString();
/** Only explicit public text blocks are read; never serialize arbitrary stream/message metadata. */
export function historyRecords(childId: string, events: WireEvent[], context: WireEvent[] = []): SubagentHistoryRecord[] {
  const calls = new Map<string, WireEvent>();
  for (const event of [...context, ...events]) if (event.type === 'tool/call' && typeof event.data.callId === 'string') calls.set(event.data.callId, event);
  const rows = new Map<string, SubagentHistoryRecord>();
  for (const event of events) {
    const d = event.data;
    const base = { id: `dsh:${childId}:event:${event.seq}`, time: time(event.time), complete: true };
    if (event.type === 'user/message') {
      const text = textContent(d.content);
      if (text) rows.set(base.id, { ...base, role: 'user', text: bounded(text) });
    } else if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const text = textContent(record(d.message).content) || compactText(d.stream);
      const id = assistantId(childId, d.turn, d.step);
      if (text) rows.set(id, { ...base, id, role: 'assistant', text: bounded(text) });
    } else if (event.type === 'tool/call' && typeof d.callId === 'string') {
      const id = `dsh:${childId}:tool:${d.callId}`;
      const input = bounded(typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? {}));
      rows.set(id, { ...base, id, role: 'tool', tool: String(d.name ?? 'tool'), text: input, input, complete: false });
    } else if (event.type === 'tool/result') {
      const message = record(d.message);
      for (const value of Array.isArray(message.content) ? message.content : []) {
        const block = record(value);
        const callId = block.toolCallId ?? block.callId ?? message.toolCallId ?? message.id;
        if (block.type !== 'tool-result' || typeof callId !== 'string') continue;
        const call = calls.get(callId);
        const id = `dsh:${childId}:tool:${callId}`;
        const output = bounded(typeof block.content === 'string' ? block.content : textContent(block.content));
        const input = call ? bounded(typeof call.data.arguments === 'string' ? call.data.arguments : JSON.stringify(call.data.arguments ?? {})) : undefined;
        rows.set(id, { ...base, time: call ? time(call.time) : base.time, id, role: 'tool', tool: String(call?.data.name ?? block.name ?? 'tool'), text: output, ...(input === undefined ? {} : { input }), output, ...(typeof block.isError === 'boolean' ? { isError: block.isError } : {}) });
      }
    }
  }
  return [...rows.values()];
}
export function liveHistoryRecord(childId: string, snapshot: HistorySnapshot): SubagentHistoryRecord | undefined {
  const active = record(record(snapshot.assistantStream).activeAttempt);
  const text = compactText(active.stream);
  if (typeof active.attemptId !== 'string' || !text) return;
  // No wall-clock timestamp is invented on each poll: use the durable snapshot watermark's time.
  return { id: assistantId(childId, active.turn, active.step), role: 'assistant', text: bounded(text), time: time(snapshot.records.at(-1)?.event.time ?? 0), complete: false };
}
