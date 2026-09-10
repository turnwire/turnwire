import type { ModelCatalog } from '@turnwire/protocol';

export interface ModelChoice { provider: string; model: string; reasoningEffort?: string }

/**
 * The effort a new selection should carry: only one the target model itself declares.
 *
 * A reasoning effort belongs to the model it was chosen for. Carrying `high` from a DeepSeek session
 * into a model with no efforts makes the Host refuse the whole selection as unavailable, which reads
 * like "that model does not exist" when the truth is "that model has no such effort".
 */
export function carriedEffort(catalog: ModelCatalog | undefined, current: ModelChoice | undefined, target: { provider: string; model: string }): string | undefined {
  const effort = current?.reasoningEffort;
  if (!effort || !catalog) return undefined;
  const declared = catalog.groups.find(group => group.id === target.provider)?.models.find(model => model.id === target.model)?.reasoning?.efforts ?? [];
  return declared.some(entry => entry.id === effort) ? effort : undefined;
}
