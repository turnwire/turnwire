// Node-only local discovery; deliberately not exported by the browser-safe SDK index.
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

function pathExists(path: string) { try { lstatSync(path); return true; } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; } }
function environment(options: PathOptions): NodeJS.ProcessEnv { return Object.fromEntries(Object.entries(options.env ?? process.env).filter(([, value]) => value !== '')); }

export interface PathOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
  /** A detected installed host's old state directory. Never created or migrated here. */
  legacyHome?: string;
}

/** Resolve only. Explicit TURNWIRE_HOME and existing legacy homes keep the entire single layout. */
export function resolveTurnwirePaths(options: PathOptions = {}) {
  const env = environment(options);
  const home = options.home ?? env.HOME ?? homedir();
  const exists = options.exists ?? pathExists;
  const oldHome = join(home, '.turnwire');
  const legacy = env.TURNWIRE_HOME ?? options.legacyHome ?? (exists(oldHome) ? oldHome : undefined);
  const xdg = (variable: string, fallback: string) => join(env[variable] && isAbsolute(env[variable]) ? env[variable] : join(home, fallback), 'turnwire');
  const state = legacy !== undefined ? resolve(legacy) : xdg('XDG_STATE_HOME', '.local/state');
  const config = env.TURNWIRE_CONFIG_HOME !== undefined ? resolve(env.TURNWIRE_CONFIG_HOME) : legacy !== undefined ? state : xdg('XDG_CONFIG_HOME', '.config');
  const data = env.TURNWIRE_DATA_HOME !== undefined ? resolve(env.TURNWIRE_DATA_HOME) : legacy !== undefined ? state : xdg('XDG_DATA_HOME', '.local/share');
  const cache = env.TURNWIRE_CACHE_HOME !== undefined ? resolve(env.TURNWIRE_CACHE_HOME) : legacy !== undefined ? state : xdg('XDG_CACHE_HOME', '.cache');
  return { layout: legacy !== undefined ? 'legacy' as const : 'xdg' as const, state, config, data, cache, clientConfig: join(config, 'client.json') };
}

/** Old installed hosts also stored runtime/config beside the application. Preserve those in place. */
export function resolveManagedHostPaths(root: string, options: PathOptions = {}) {
  const env = environment(options);
  const exists = options.exists ?? pathExists;
  const installed = ['state', 'dsh-state', 'runtime', 'config/dsh.env.json'].some(path => exists(join(root, path)));
  const paths = resolveTurnwirePaths({ ...options, legacyHome: installed ? join(root, 'state') : options.legacyHome });
  const data = installed && env.TURNWIRE_DATA_HOME === undefined ? root : paths.data;
  return {
    ...paths, data,
    dshHome: resolve(env.TURNWIRE_DSH_HOME ?? env.DSH_HOME ?? (installed ? join(root, 'dsh-state') : join(paths.state, 'dsh'))),
    dshEnvFile: env.TURNWIRE_DSH_ENV_FILE ?? (installed ? join(root, 'config/dsh.env.json') : join(paths.config, 'dsh.env.json')),
    dshEntry: resolve(env.TURNWIRE_DSH_ENTRY ?? join(data, 'runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')),
  };
}
