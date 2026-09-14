import { sessionContextSchema, type SessionContext } from '@turnwire/protocol';
import { t } from './i18n.js';

export function showContext(value?: SessionContext): string {
  const parsed = sessionContextSchema.safeParse(value);
  const context = parsed.success ? parsed.data : undefined;
  const tokens = context?.projectedTokens ?? context?.pressureTokens;
  const capacity = context?.contextWindow;
  const usage = tokens === undefined ? t('context.unknown') : String(Math.round(tokens));
  const ratio = tokens !== undefined && capacity !== undefined ? ` (${Math.round(tokens / capacity * 100)}%)` : '';
  return `${t('context.label')}: ${usage} / ${capacity ?? t('context.unknown')}${ratio}${context?.projectedTokens !== undefined ? ` · ${t('context.estimated')}` : ''}`;
}
