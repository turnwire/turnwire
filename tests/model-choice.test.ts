import { expect, it } from 'vitest';
import { carriedEffort } from '../apps/remote-web/src/modelChoice.js';
import type { ModelCatalog } from '@turnwire/protocol';

const catalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash' },
  routableProviders: ['deepseek-official', 'bridge'],
  failures: [],
  groups: [
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }, { id: 'plain', name: 'Plain' }] },
    { id: 'bridge', name: 'Codex bridge', models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra' }] },
  ],
} as unknown as ModelCatalog;

it('carries an effort only to a model that declares it', () => {
  const current = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' };
  expect(carriedEffort(catalog, current, { provider: 'deepseek-official', model: 'deepseek-flash' })).toBe('high');
  expect(carriedEffort(catalog, current, { provider: 'deepseek-official', model: 'plain' })).toBeUndefined();
  // The bug this exists for: a model with no efforts at all must not inherit the previous one, or the
  // Host refuses the selection as unavailable.
  expect(carriedEffort(catalog, current, { provider: 'bridge', model: 'gpt-6-astra' })).toBeUndefined();
});
it('carries nothing when there is nothing to carry', () => {
  expect(carriedEffort(catalog, undefined, { provider: 'bridge', model: 'gpt-6-astra' })).toBeUndefined();
  expect(carriedEffort(catalog, { provider: 'bridge', model: 'gpt-6-astra' }, { provider: 'deepseek-official', model: 'deepseek-flash' })).toBeUndefined();
  expect(carriedEffort(undefined, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }, { provider: 'deepseek-official', model: 'deepseek-flash' })).toBeUndefined();
});
