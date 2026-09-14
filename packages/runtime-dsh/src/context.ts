import { sessionContextSchema, type SessionContext } from '@turnwire/protocol';
import { record } from './mapper.js';

/** Per-connection projection watermarks: list hints never override live observations. */
export class ContextProjection {
  private values = new Map<string, { seq: number; context?: SessionContext }>();
  constructor(private publish: (id: string, context: SessionContext | undefined) => void) {}
  reset() { this.values.clear(); }
  current(id: string) { return this.values.get(id)?.context; }
  baseline(id: string, value: unknown) {
    const baseline = record(value);
    this.update(id, baseline.asOfSeq, record(baseline.values).contextPressure);
  }
  update(id: string, seq: unknown, value: unknown) {
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < -1) return;
    const previous = this.values.get(id);
    if (previous && seq <= previous.seq) return;
    const parsed = sessionContextSchema.safeParse(value);
    const context = parsed.success && Object.values(parsed.data).some(value => value !== undefined) ? parsed.data : undefined;
    this.values.set(id, { seq, context });
    this.publish(id, context);
  }
  frame(value: Record<string, unknown>) {
    if (value.type === 'baseline') {
      for (const [id, baseline] of Object.entries(record(record(value.value).projections))) this.baseline(id, baseline);
    } else if (value.type === 'projection' && value.key === 'contextPressure' && typeof value.sessionId === 'string') {
      this.update(value.sessionId, value.seq, value.value);
    }
  }
}
