import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticEnv } from './helpers/hermetic-env.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'turnwire-hermetic-')); roots.push(value); return value; }

it('allowlists harmless inputs and excludes host endpoints, credentials and process injection', async () => {
  const directory = await root();
  const poisoned = {
    PATH: '/usr/bin:/bin', LANG: 'C', HOME: '/real/home', XDG_CONFIG_HOME: '/production/config', XDG_RUNTIME_DIR: '/run/user/1000',
    TURNWIRE_HOME: '/production/state', TURNWIRE_DSH_URL: 'http://production:3180', TURNWIRE_RUNTIME: 'dsh', TURNWIRE_PORT: '18899',
    TURNWIRE_HARNESS_DEEPSEEK_API_KEY: 'real-secret', TURNWIRE_RELAY_TOKEN: 'relay-secret',
    DSH_HOME: '/production/dsh', DSH_TOKEN: 'token', OPENAI_API_KEY: 'secret', SSH_AUTH_SOCK: '/private/agent',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/production/bus', NODE_OPTIONS: '--import=/production/hook.mjs', NODE_PATH: '/production/modules',
    LD_PRELOAD: '/production/inject.so', HTTPS_PROXY: 'https://production-proxy', npm_config_userconfig: '/production/npmrc',
  };
  const env = hermeticEnv(directory, {}, poisoned);
  expect(env.PATH).toBe(poisoned.PATH); expect(env.LANG).toBe('C');
  for (const key of Object.keys(poisoned)) {
    if (['PATH', 'LANG', 'HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'TURNWIRE_RUNTIME', 'TURNWIRE_PORT'].includes(key)) continue;
    expect(env[key], key).toBeUndefined();
  }
  expect(env.TURNWIRE_RUNTIME).toBe('demo'); expect(env.TURNWIRE_PORT).toBe('0');
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR']) {
    expect(env[key]).toMatch(new RegExp(`^${directory}/`)); expect((await stat(env[key]!)).isDirectory()).toBe(true);
  }
  const observed = JSON.parse(execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { env, encoding: 'utf8', timeout: 5000 }));
  expect(observed.HOME).toBe(env.HOME); expect(JSON.stringify(observed)).not.toContain('production'); expect(JSON.stringify(observed)).not.toContain('secret');
  expect(poisoned.HOME).toBe('/real/home');
});

it('supports explicit fake-runtime and path fallback fixture inputs without inheriting others', async () => {
  const directory = await root();
  const env = hermeticEnv(directory, { TURNWIRE_RUNTIME: 'dsh', TURNWIRE_DSH_URL: 'http://127.0.0.1:1234', XDG_CONFIG_HOME: undefined }, {});
  expect(env.TURNWIRE_RUNTIME).toBe('dsh'); expect(env.TURNWIRE_DSH_URL).toBe('http://127.0.0.1:1234');
  expect(env.XDG_CONFIG_HOME).toBeUndefined(); expect(env.HOME).toBe(join(directory, 'home'));
  expect(() => hermeticEnv('relative')).toThrow('absolute temporary root');
});
