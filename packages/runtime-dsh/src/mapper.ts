import { z } from 'zod';
import { imageAttachmentSchema, modelSelectionSchema, type ImageAttachment } from '@turnwire/protocol';
import type { RuntimeEvent } from '@turnwire/runtime';

export const wireEventSchema = z.object({ type: z.string(), seq: z.number().int().nonnegative(), time: z.number(), data: z.record(z.unknown()) }).passthrough();
export type WireEvent = z.infer<typeof wireEventSchema>;
export function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function textContent(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map(part => { const p = record(part); return p.type === 'text' && typeof p.text === 'string' ? p.text : ''; }).join('');
}
/** Select only validated references; inline image bytes must never enter events. */
export function imageContent(value: unknown): ImageAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(part => {
    const block = record(part);
    if (block.type !== 'image') return [];
    const parsed = imageAttachmentSchema.strip().safeParse(block.attachment);
    return parsed.success ? [parsed.data] : [];
  });
}
/** Read-only surfaces without attachment rendering retain an explicit placeholder. */
export function imagePlaceholders(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.filter(part => record(part).type === 'image').map(() => '[Image attachment]').join('\n');
}
export function compactText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map(item => {
    const r = record(item);
    if (r.type === 'text-chunks' && Array.isArray(r.texts)) return r.texts.filter(x => typeof x === 'string').join('');
    const chunk = record(r.chunk);
    return r.type === 'chunk' && chunk.type === 'text-delta' && typeof chunk.text === 'string' ? chunk.text : '';
  }).join('');
}
export function assistantId(sessionId: string, turn: unknown, step: unknown) { return `dsh:${sessionId}:${String(turn)}:${String(step)}`; }
export function mapEvent(sessionId: string, event: WireEvent): RuntimeEvent[] {
  const d = event.data;
  switch (event.type) {
    case 'turn/start': return [{ type: 'status', status: 'running' }];
    case 'turn/end': return [{ type: 'status', status: 'idle' }];
    case 'user/message': {
      const source = record(d.source);
      if (source.kind !== 'user') return [];
      const images = imageContent(d.content);
      const text = textContent(d.content) + (images.length ? '' : imagePlaceholders(d.content));
      return [{ type: 'message.user', messageId: typeof source.rpcId === 'string' ? source.rpcId : String(d.id ?? `dsh-user-${event.seq}`), text, ...(images.length ? { images } : {}) }];
    }
    case 'assistant/message':
    case 'assistant/attempt': {
      const message = record(d.message);
      const text = textContent(message.content) || compactText(d.stream);
      return [{ type: 'message.completed', messageId: assistantId(sessionId, d.turn, d.step), text }];
    }
    case 'tool/call': return [{ type: 'tool.started', callId: String(d.callId), tool: String(d.name), detail: typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? {}) }];
    case 'tool/result': {
      const message = record(d.message);
      const blocks = Array.isArray(message.content) ? message.content : [];
      return blocks.flatMap(block => {
        const b = record(block); const callId = b.toolCallId ?? b.callId ?? message.toolCallId ?? message.id;
        if (!callId || b.type !== 'tool-result') return [];
        return [{ type: 'tool.finished' as const, callId: String(callId), tool: String(b.name ?? '工具结果'), detail: typeof b.content === 'string' ? b.content : textContent(b.content) || imagePlaceholders(b.content) || '', ...(typeof b.isError === 'boolean' ? { isError: b.isError } : {}) }];
      });
    }
    // The Host records the durable selection, so a change made anywhere (including the
    // DSH Web UI) reaches Turnwire through the same stream. Only the known fields are
    // read, so an additive Host change cannot drop the update or break the stream.
    case 'model/selection': return [{ type: 'model.selected', selection: modelSelectionSchema.parse({ provider: d.provider, model: d.model, ...(d.reasoningEffort === undefined ? {} : { reasoningEffort: d.reasoningEffort }) }) }];
    default: return [];
  }
}
