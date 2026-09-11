/** Distance from the oldest loaded record at which an upward reach requests one page. */
export const HISTORY_TOP_THRESHOLD = 120;

export interface EarlierLoadState {
  scrollTop: number;
  before: number | null;
  loading: boolean;
  /** A deliberate upward scroll or a fresh wheel/touch/keyboard gesture, not layout. */
  upward: boolean;
  /** The initial page may be retried even though it has not supplied a cursor yet. */
  initialFailed?: boolean;
}

/** One bounded request per upward reach; no lifetime cap and no render-driven draining. */
export function shouldLoadEarlier(state: EarlierLoadState): boolean {
  return (state.before !== null || state.initialFailed === true) && !state.loading && state.upward && state.scrollTop < HISTORY_TOP_THRESHOLD;
}

/** Preserve the same viewport-relative content position after a prepend. */
export function prependScrollTop(old: { height: number; top: number }, height: number): number {
  return old.top + height - old.height;
}
