import { describe, expect, it } from 'vitest';
import { resolveManagedHostPaths, resolveTurnwirePaths } from '../packages/sdk/src/node-paths.js';

const home = '/fixture/home';
const defaults = { home, env: {} };
describe('XDG Node paths', () => {
  it('splits HOME defaults without filesystem discovery', () => {
    expect(resolveTurnwirePaths(defaults)).toEqual({ state: `${home}/.local/state/turnwire`, config: `${home}/.config/turnwire`, data: `${home}/.local/share/turnwire`, cache: `${home}/.cache/turnwire`, clientConfig: `${home}/.config/turnwire/client.json` });
  });
  it('accepts absolute XDG values and ignores relative or empty values independently', () => {
    const paths = resolveTurnwirePaths({ ...defaults, env: { XDG_STATE_HOME: '/state', XDG_CONFIG_HOME: 'relative', XDG_DATA_HOME: '', XDG_CACHE_HOME: '/cache' } });
    expect(paths.state).toBe('/state/turnwire'); expect(paths.config).toBe(`${home}/.config/turnwire`); expect(paths.data).toBe(`${home}/.local/share/turnwire`); expect(paths.cache).toBe('/cache/turnwire');
  });
  it.each(['/removed', ''])('rejects removed TURNWIRE_HOME (%j)', value => {
    expect(() => resolveTurnwirePaths({ ...defaults, env: { TURNWIRE_HOME: value } })).toThrow('TURNWIRE_HOME has been removed');
  });
  it('honors independent explicit paths', () => {
    const paths = resolveTurnwirePaths({ ...defaults, env: { TURNWIRE_STATE_HOME: '/state', TURNWIRE_CONFIG_HOME: '/config', TURNWIRE_DATA_HOME: '/data', TURNWIRE_CACHE_HOME: '/cache' } });
    expect([paths.state, paths.config, paths.data, paths.cache]).toEqual(['/state', '/config', '/data', '/cache']);
  });
  it('state override never redirects other kinds', () => {
    const paths = resolveTurnwirePaths({ ...defaults, env: { TURNWIRE_STATE_HOME: '/state' } });
    expect(paths.config).toBe(`${home}/.config/turnwire`);
    expect(paths.data).toBe(`${home}/.local/share/turnwire`);
  });
});
describe('managed host paths', () => {
  it('puts runtime data and private environment in XDG homes, ignoring generic DSH aliases', () => {
    const paths = resolveManagedHostPaths({ ...defaults, env: { DSH_HOME: '/ignored', DSH_ENTRY: '/ignored', DSH_ENV_FILE: '/ignored' } });
    expect(paths.dshHome).toBe(`${home}/.local/state/turnwire/dsh`);
    expect(paths.dshEnvFile).toBe(`${home}/.config/turnwire/dsh.env.json`);
    expect(paths.dshEntry).toBe(`${home}/.local/share/turnwire/runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`);
  });
  it('honors only namespaced runtime overrides', () => {
    const paths = resolveManagedHostPaths({ ...defaults, env: { TURNWIRE_STATE_HOME: '/state', TURNWIRE_DATA_HOME: '/data', TURNWIRE_DSH_HOME: '/runtime-state', TURNWIRE_DSH_ENV_FILE: '/private.json', TURNWIRE_DSH_ENTRY: '/entry.js' } });
    expect(paths.state).toBe('/state'); expect(paths.data).toBe('/data'); expect(paths.dshHome).toBe('/runtime-state'); expect(paths.dshEnvFile).toBe('/private.json'); expect(paths.dshEntry).toBe('/entry.js');
  });
});
