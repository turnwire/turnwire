import { describe, expect, it } from 'vitest';
import { contextUsage } from '../apps/remote-web/src/formatContextUsage.js';

describe('context occupancy presentation', () => {
  it('does not represent missing or invalid values as zero', () => {
    expect(contextUsage().text).toBeUndefined();
    expect(contextUsage({ contextWindow: 100 }).text).toBeUndefined();
    expect(contextUsage({ projectedTokens: NaN, pressureTokens: -1 }).text).toBeUndefined();
  });
  it('prefers next-request estimates including zero after compaction', () => {
    expect(contextUsage({ projectedTokens: 0, pressureTokens: 99, contextWindow: 100 })).toMatchObject({ tokens: 0, estimated: true, percent: 0, text: '≈ 0 / 100 · 0.0%' });
  });
  it('labels reported input separately and omits unknown capacity', () => {
    expect(contextUsage({ pressureTokens: 1234 })).toMatchObject({ estimated: false, text: '1,234', percent: undefined });
    expect(contextUsage({ pressureTokens: 10, contextWindow: 0 }).percent).toBeUndefined();
  });
  it('does not hide usage beyond the model window', () => {
    expect(contextUsage({ projectedTokens: 125, contextWindow: 100 })).toMatchObject({ percent: 125, text: '≈ 125 / 100 · 125.0%' });
  });
});
