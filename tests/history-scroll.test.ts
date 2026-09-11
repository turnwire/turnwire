import { expect, it } from 'vitest';
import { HISTORY_TOP_THRESHOLD, prependScrollTop, shouldLoadEarlier } from '../apps/remote-web/src/historyScroll.js';

const ready = { scrollTop: 0, before: 41, loading: false, upward: true };

it('requests a bounded page only on an upward reach with earlier records available', () => {
  expect(shouldLoadEarlier(ready)).toBe(true);
  expect(shouldLoadEarlier({ ...ready, scrollTop: HISTORY_TOP_THRESHOLD - 1 })).toBe(true);
  expect(shouldLoadEarlier({ ...ready, scrollTop: HISTORY_TOP_THRESHOLD })).toBe(false);
  expect(shouldLoadEarlier({ ...ready, before: null })).toBe(false);
  expect(shouldLoadEarlier({ ...ready, loading: true })).toBe(false);
});

it('never eagerly drains a short viewport or retries from layout alone', () => {
  expect(shouldLoadEarlier({ ...ready, upward: false })).toBe(false);
  expect(shouldLoadEarlier({ ...ready, before: null, initialFailed: true, upward: false })).toBe(false);
  expect(shouldLoadEarlier({ ...ready, before: null, initialFailed: true })).toBe(true);
});

it('allows every deliberate top reach without a session page cap', () => {
  for (let page = 0; page < 100; page++) expect(shouldLoadEarlier({ ...ready, before: 1000 - page })).toBe(true);
});

it('preserves viewport-relative geometry through repeated prepends', () => {
  let height = 1200; let top = 35; let anchor = 180;
  const relative = anchor - top;
  for (const added of [500, 37, 1000, 0]) {
    top = prependScrollTop({ height, top }, height + added);
    height += added; anchor += added;
    expect(anchor - top).toBe(relative);
  }
});
