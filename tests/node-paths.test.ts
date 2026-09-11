import { describe, expect, it } from 'vitest';
import { resolveManagedHostPaths, resolveTurnwirePaths } from '../packages/sdk/src/node-paths.js';

const home = '/fixture/home';
const exists = () => false;
const defaults = { home, exists, env: {} };
describe('new-install Node path defaults', () => {
  it('splits standard HOME defaults without inspecting or creating live user directories', () => {
    expect(resolveTurnwirePaths(defaults)).toEqual({ layout: 'xdg', state: `${home}/.local/state/turnwire`, config: `${home}/.config/turnwire`, data: `${home}/.local/share/turnwire`, cache: `${home}/.cache/turnwire`, clientConfig: `${home}/.config/turnwire/client.json` });
  });
  it('accepts absolute XDG values and rejects relative or empty values independently', () => {
    const paths = resolveTurnwirePaths({ ...defaults, env: { XDG_STATE_HOME: '/state', XDG_CONFIG_HOME: 'relative', XDG_DATA_HOME: '', XDG_CACHE_HOME: '/cache' } });
    expect(paths.state).toBe('/state/turnwire'); expect(paths.config).toBe(`${home}/.config/turnwire`); expect(paths.data).toBe(`${home}/.local/share/turnwire`); expect(paths.cache).toBe('/cache/turnwire');
  });
  it('preserves the complete explicit single-root layout, even with XDG variables', () => {
    const paths = resolveTurnwirePaths({ ...defaults, env: { TURNWIRE_HOME: '/explicit', XDG_CONFIG_HOME: '/config' } });
    expect([paths.state, paths.config, paths.data, paths.cache]).toEqual(Array(4).fill('/explicit'));
    expect(paths.clientConfig).toBe('/explicit/client.json');
  });
  it('preserves detected ~/.turnwire before XDG, with per-kind overrides still winning', () => {
    const paths = resolveTurnwirePaths({ ...defaults, exists: path => path === `${home}/.turnwire`, env: { XDG_STATE_HOME: '/state', TURNWIRE_CACHE_HOME: '/explicit-cache' } });
    expect(paths.state).toBe(`${home}/.turnwire`); expect(paths.config).toBe(paths.state); expect(paths.data).toBe(paths.state); expect(paths.cache).toBe('/explicit-cache');
  });
  it('keeps installer-resolved split paths when state is explicitly supplied', () => {
    const paths = resolveTurnwirePaths({ ...defaults, env: { TURNWIRE_HOME: '/state', TURNWIRE_CONFIG_HOME: '/config', TURNWIRE_DATA_HOME: '/data', TURNWIRE_CACHE_HOME: '/cache' } });
    expect([paths.state, paths.config, paths.data, paths.cache]).toEqual(['/state', '/config', '/data', '/cache']);
  });
});
describe('managed host paths', () => {
  it('puts new runtime data and private environment in their XDG homes', () => {
    const paths = resolveManagedHostPaths('/install', defaults);
    expect(paths.dshHome).toBe(`${home}/.local/state/turnwire/dsh`);
    expect(paths.dshEnvFile).toBe(`${home}/.config/turnwire/dsh.env.json`);
    expect(paths.dshEntry).toBe(`${home}/.local/share/turnwire/runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`);
  });
  it.each(['state', 'runtime', 'dsh-state', 'config/dsh.env.json'])('retains installed layout when %s exists', marker => {
    const paths = resolveManagedHostPaths('/install', { ...defaults, exists: path => path === `/install/${marker}` });
    expect(paths.state).toBe('/install/state'); expect(paths.config).toBe('/install/state'); expect(paths.data).toBe('/install'); expect(paths.cache).toBe('/install/state');
    expect(paths.dshHome).toBe('/install/dsh-state'); expect(paths.dshEnvFile).toBe('/install/config/dsh.env.json'); expect(paths.dshEntry).toBe('/install/runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js');
  });
  it('honors explicit runtime overrides over a detected installation', () => {
    const paths = resolveManagedHostPaths('/install', { ...defaults, exists: () => true, env: { TURNWIRE_HOME: '/state', TURNWIRE_DATA_HOME: '/data', TURNWIRE_DSH_HOME: '/runtime-state', TURNWIRE_DSH_ENV_FILE: '/private.json', TURNWIRE_DSH_ENTRY: '/entry.js' } });
    expect(paths.state).toBe('/state'); expect(paths.data).toBe('/data'); expect(paths.dshHome).toBe('/runtime-state'); expect(paths.dshEnvFile).toBe('/private.json'); expect(paths.dshEntry).toBe('/entry.js');
  });
});
