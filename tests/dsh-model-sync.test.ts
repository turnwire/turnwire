import { expect, it } from 'vitest';
import { displayName, listedModels, rewrite, routeModels } from '../scripts/dsh-model-sync.mjs';

const overlay = `- id: llm-deepseek
  config:
    apiKeyEnv: TURNWIRE_HARNESS_DEEPSEEK_API_KEY

- id: llm-pi-ai
  config:
    providers:
      bridge:
        displayName: Codex bridge
        baseURL: http://127.0.0.1:8790/v1
        api: openai-completions
        apiKeyEnv: TURNWIRE_HARNESS_CODEX_BRIDGE_KEY
        models:
          - id: gpt-5.5
            name: GPT-5.5
          - id: gpt-5.5-mini
      other:
        baseURL: https://example.test/v1
        api: openai-responses
        models:
          - id: one
            name: One
`;
it('finds each provider route and the list it owns, and skips routes without an endpoint', () => {
  const routes = routeModels(overlay);
  expect(routes.map(route => route.id)).toEqual(['bridge', 'other']);
  expect(routes[0]).toMatchObject({ baseURL: 'http://127.0.0.1:8790/v1', api: 'openai-completions', apiKeyEnv: 'TURNWIRE_HARNESS_CODEX_BRIDGE_KEY' });
  expect(listedModels(overlay.split('\n'), routes[0]!)).toEqual([{ id: 'gpt-5.5', name: 'GPT-5.5' }, { id: 'gpt-5.5-mini' }]);
  // The second route's list ends at the end of the file, not at the first route's indentation.
  expect(listedModels(overlay.split('\n'), routes[1]!)).toEqual([{ id: 'one', name: 'One' }]);
});
it('writes exactly what the endpoint answered, keeping hand-written names', () => {
  const route = routeModels(overlay)[0]!;
  const updated = rewrite(overlay, route, ['gpt-5.5', 'gpt-6-astra']);
  expect(updated).toContain('- id: gpt-5.5\n            name: GPT-5.5');
  // A new id gets a readable fallback rather than nothing to show in a picker.
  expect(updated).toContain('- id: gpt-6-astra\n            name: GPT 6 Astra');
  // and the id the endpoint no longer serves is gone.
  expect(updated).not.toContain('gpt-5.5-mini');
  // The other route is untouched, and rewriting again changes nothing.
  expect(updated).toContain('- id: one\n            name: One');
  expect(rewrite(updated, routeModels(updated)[0]!, ['gpt-5.5', 'gpt-6-astra'])).toBe(updated);
});
it('keeps a model id readable when nobody named it', () => {
  expect(displayName('gpt-6-astra')).toBe('GPT 6 Astra');
  expect(displayName('deepseek-v4-flash')).toBe('Deepseek V4 Flash');
  expect(displayName('o3-mini')).toBe('O3 Mini');
});
