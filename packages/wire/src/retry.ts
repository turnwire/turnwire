/** Full jitter, with a small lower bound to avoid a busy loop even with a zero RNG. */
export function retryDelay(attempt: number, random = Math.random): number {
  return Math.max(250, Math.round(random() * Math.min(30_000, 1000 * 2 ** Math.min(5, Math.max(0, attempt)))));
}
