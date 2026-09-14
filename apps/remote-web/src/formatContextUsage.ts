import type { SessionContext } from '@turnwire/protocol';

/** Runtime estimates and reported usage stay distinct; absent values never become zero. */
export function contextUsage(context?: SessionContext) {
  const valid = (n: number | undefined) => n !== undefined && Number.isSafeInteger(n) && n >= 0;
  const estimated = valid(context?.projectedTokens);
  const tokens = estimated ? context!.projectedTokens : valid(context?.pressureTokens) ? context!.pressureTokens : undefined;
  const window = valid(context?.contextWindow) && context!.contextWindow! > 0 ? context!.contextWindow : undefined;
  const percent = tokens !== undefined && window !== undefined ? tokens / window * 100 : undefined;
  const format = (n: number) => n.toLocaleString('en-US');
  const text = tokens === undefined ? undefined : `${estimated ? '≈ ' : ''}${format(tokens)}${window === undefined ? '' : ` / ${format(window)}`}${percent === undefined ? '' : ` · ${percent.toFixed(1)}%`}`;
  return { tokens, window, percent, estimated, text };
}
