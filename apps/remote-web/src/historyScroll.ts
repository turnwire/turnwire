/**
 * Pages a reader may pull in by holding the conversation at its oldest record. The manual
 * control stays available past the bound; this only caps what one gesture fetches over the
 * encrypted mobile link, where a single page can already reach 512 KiB.
 */
export const HISTORY_AUTO_PAGES = 10;
/** Distance in pixels from the oldest loaded record that counts as "the reader wants earlier records". */
export const HISTORY_TOP_THRESHOLD = 120;

export interface EarlierLoadState {
  /** Scroll offset of the conversation container. */
  scrollTop: number;
  /** Cursor for the next older page; null once the session's first record is loaded. */
  before: number | null;
  /** A history request is already in flight. */
  loading: boolean;
  /** The last history request failed and waits for an explicit retry. */
  failed: boolean;
  /** Pages this session already pulled in automatically. */
  pages: number;
  /** Overrides the automatic bound. */
  limit?: number;
}

/** True when reaching the top should silently load the next older page. */
export function shouldLoadEarlier(state: EarlierLoadState): boolean {
  return state.before !== null && !state.loading && !state.failed && state.scrollTop < HISTORY_TOP_THRESHOLD && state.pages < (state.limit ?? HISTORY_AUTO_PAGES);
}
