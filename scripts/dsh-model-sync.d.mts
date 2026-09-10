/** Types for `scripts/dsh-model-sync.mjs`, so its tests are checked rather than implicitly `any`. */
export interface ModelRoute {
  id: string;
  baseURL?: string;
  apiKeyEnv?: string;
  api?: string;
  listIndent: number;
  start: number;
  end: number;
}
export interface ListedModel { id: string; name?: string }
export function routeModels(text: string): ModelRoute[];
export function listedModels(lines: string[], route: ModelRoute): ListedModel[];
export function displayName(id: string): string;
export function rewrite(text: string, route: ModelRoute, ids: string[]): string;
