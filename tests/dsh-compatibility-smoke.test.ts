import { expect, it } from 'vitest';

it('isolates runtime and npm configuration from ambient credentials', async () => {
  // @ts-expect-error Node maintenance script intentionally has no declaration file.
  const { isolatedEnvironment } = await import('../scripts/dsh-compatibility.mjs');
  const env = isolatedEnvironment('/tmp/compatibility-fixture', {
    PATH: '/bin', HOME: '/real-home', XDG_CONFIG_HOME: '/real-config',
    NODE_OPTIONS: '--require evil', OPENAI_API_KEY: 'private', TURNWIRE_HARNESS_DEEPSEEK_API_KEY: 'private',
    NPM_TOKEN: 'private', npm_config_userconfig: '/real-npmrc', TURNWIRE_DSH_URL: 'private',
  });
  expect(env.PATH).toBe('/bin');
  for (const key of ['NODE_OPTIONS', 'OPENAI_API_KEY', 'TURNWIRE_HARNESS_DEEPSEEK_API_KEY', 'NPM_TOKEN', 'TURNWIRE_DSH_URL']) expect(env[key]).toBeUndefined();
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'npm_config_cache', 'npm_config_userconfig', 'npm_config_globalconfig']) expect(env[key]).toMatch(/^\/tmp\/compatibility-fixture(?:\/|$)/);
});
