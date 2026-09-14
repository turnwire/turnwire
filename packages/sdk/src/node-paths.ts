// Node-only local discovery; deliberately not exported by the browser-safe SDK index.
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface PathOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Resolve XDG paths only; never inspect, create or migrate existing directories. */
export function resolveTurnwirePaths(options: PathOptions = {}) {
  const source = options.env ?? process.env;
  if (source.TURNWIRE_HOME !== undefined) throw new Error('TURNWIRE_HOME has been removed; use TURNWIRE_STATE_HOME, TURNWIRE_CONFIG_HOME, TURNWIRE_DATA_HOME and TURNWIRE_CACHE_HOME.');
  const env = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const home = options.home ?? env.HOME ?? homedir();
  const path = (kind: string, fallback: string) => env[`TURNWIRE_${kind}_HOME`] ? resolve(env[`TURNWIRE_${kind}_HOME`]!) : join(env[`XDG_${kind}_HOME`] && isAbsolute(env[`XDG_${kind}_HOME`]!) ? env[`XDG_${kind}_HOME`]! : join(home, fallback), 'turnwire');
  const state = path('STATE', '.local/state');
  const config = path('CONFIG', '.config');
  const data = path('DATA', '.local/share');
  const cache = path('CACHE', '.cache');
  return { state, config, data, cache, clientConfig: join(config, 'client.json') };
}

/** Runtime locations are independent of the application checkout. */
export function resolveManagedHostPaths(options: PathOptions = {}) {
  const env = options.env ?? process.env;
  const paths = resolveTurnwirePaths(options);
  return {
    ...paths,
    dshHome: resolve(env.TURNWIRE_DSH_HOME || join(paths.state, 'dsh')),
    dshEnvFile: resolve(env.TURNWIRE_DSH_ENV_FILE || join(paths.config, 'dsh.env.json')),
    dshEntry: resolve(env.TURNWIRE_DSH_ENTRY || join(paths.data, 'runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')),
  };
}
