import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * Build child-process environments from an allowlist, never from process.env.
 * Callers own a fresh mkdtemp root and remove it after their children exit.
 * Overrides are explicit fixture inputs; undefined removes a default (e.g. XDG
 * fallback tests). Never pass unfiltered ambient variables as overrides.
 */
export function hermeticEnv(root, overrides = {}, source = process.env) {
  if (!isAbsolute(root)) throw new Error('Hermetic environment requires an absolute temporary root');
  const env = {};
  // Node is invoked via process.execPath. PATH remains available for harmless
  // utilities; installer tests must override it with their mocked command path.
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  const home = join(root, 'home');
  Object.assign(env, {
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_RUNTIME_DIR: join(root, 'run'),
    TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    TURNWIRE_RUNTIME: 'demo', TURNWIRE_PORT: '0', DO_NOT_TRACK: '1',
  });
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR']) {
    mkdirSync(env[key], { recursive: true, mode: 0o700 });
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
