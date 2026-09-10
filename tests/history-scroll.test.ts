import { expect, it } from 'vitest';
import { HISTORY_AUTO_PAGES, HISTORY_TOP_THRESHOLD, shouldLoadEarlier } from '../apps/remote-web/src/historyScroll.js';

const ready = { scrollTop: 0, before: 41, loading: false, failed: false, pages: 0 };

it('loads older records only while the reader holds the top with earlier pages left', () => {
  expect(shouldLoadEarlier(ready)).toBe(true);
  expect(shouldLoadEarlier({ ...ready, scrollTop: HISTORY_TOP_THRESHOLD - 1 })).toBe(true);
  expect(shouldLoadEarlier({ ...ready, scrollTop: HISTORY_TOP_THRESHOLD })).toBe(false);
  expect(shouldLoadEarlier({ ...ready, before: null })).toBe(false);
  expect(shouldLoadEarlier({ ...ready, loading: true })).toBe(false);
  expect(shouldLoadEarlier({ ...ready, failed: true })).toBe(false);
});

it('bounds automatic paging while an explicit manual load stays unlimited', () => {
  expect(shouldLoadEarlier({ ...ready, pages: HISTORY_AUTO_PAGES - 1 })).toBe(true);
  expect(shouldLoadEarlier({ ...ready, pages: HISTORY_AUTO_PAGES })).toBe(false);
  expect(shouldLoadEarlier({ ...ready, pages: HISTORY_AUTO_PAGES * 3, limit: HISTORY_AUTO_PAGES * 4 })).toBe(true);
});
