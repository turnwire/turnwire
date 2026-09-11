#!/usr/bin/env node
// Run on the destination after installing Node, dependencies and the built release.
import { mkdir, writeFile, chmod, access, lstat, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)));
if (process.platform !== 'linux') throw new Error('This installer requires Linux with a systemd user manager');
if (!/^[A-Za-z0-9_./-]+$/.test(root)) throw new Error('Choose an installation path with letters, digits, underscores, dashes and slashes');
const keys = ['TURNWIRE_HOME', 'TURNWIRE_CONFIG_HOME', 'TURNWIRE_DATA_HOME', 'TURNWIRE_CACHE_HOME', 'DSH_HOME', 'DSH_ENV_FILE', 'DSH_ENTRY', 'TURNWIRE_DSH_HOME', 'TURNWIRE_DSH_ENV_FILE', 'TURNWIRE_DSH_ENTRY', 'TURNWIRE_NODE', 'TURNWIRE_UNITS_DIR'];
const cleanEnv = { ...process.env };
for (const key of ['TURNWIRE_HARNESS_DEEPSEEK_API_KEY', 'TURNWIRE_RELAY_TOKEN', 'TURNWIRE_DSH_TOKEN', 'TURNWIRE_DSH_URL']) delete cleanEnv[key];
const values = execFileSync('bash', ['-c', 'source "$1/scripts/host-paths.sh"; turnwire_resolve_paths "$1"; shift; for key; do printf "%s\\0" "${!key}"; done', 'host-paths', root, ...keys], { env: cleanEnv }).toString().split('\0');
const paths = Object.fromEntries(keys.map((key, i) => [key, values[i]]));
const node = paths.TURNWIRE_NODE;
// Do not silently misquote paths into shell or systemd directives.
for (const value of Object.values(paths)) if (!value.startsWith('/') || /[\r\n\0]/.test(value)) throw new Error('Host paths must be absolute and contain no line breaks');
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const unitQuote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
const units = paths.TURNWIRE_UNITS_DIR;
for (const directory of new Set([units, join(homedir(), '.config/systemd/user')])) {
  try { await lstat(join(directory, 'turnwire-host.service')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  throw new Error('An existing user unit must be inspected manually; refusing to overwrite it');
}
for (const file of [node, join(root, 'apps/daemon/dist/host-service.mjs'), paths.DSH_ENTRY, paths.DSH_ENV_FILE]) await access(file);
const bin = join(root, 'bin'); await mkdir(bin, { recursive: true });
for (const directory of new Set([paths.TURNWIRE_HOME, paths.DSH_HOME, paths.TURNWIRE_CONFIG_HOME, paths.TURNWIRE_CACHE_HOME])) { await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); }
await chmod(paths.DSH_ENV_FILE, 0o600);
const exports = keys.slice(0, 10).map(key => {
  const alias = key.startsWith('TURNWIRE_DSH_') ? key.slice('TURNWIRE_'.length) : key.startsWith('DSH_') ? `TURNWIRE_${key}` : undefined;
  return `if [ -z "\${${key}:-}" ]; then ${alias ? `if [ -n "\${${alias}:-}" ]; then export ${key}="$${alias}"; else export ${key}=${shellQuote(paths[key])}; fi` : `export ${key}=${shellQuote(paths[key])}`}; fi`;
}).join('\n');
await writeFile(join(bin, 'turnwire'), `#!/bin/sh\n${exports}\nexec ${shellQuote(node)} ${shellQuote(join(root, 'apps/cli/dist/main.js'))} "$@"\n`, { mode: 0o755 });
await chmod(join(bin, 'turnwire'), 0o755);
const userBin = join(homedir(), '.local/bin'); await mkdir(userBin, { recursive: true });
try { await lstat(join(userBin, 'turnwire')); } catch (error) { if (error.code !== 'ENOENT') throw error; await symlink(join(bin, 'turnwire'), join(userBin, 'turnwire')); }
await mkdir(units, { recursive: true });
await writeFile(join(units, 'turnwire-host.service'), `[Unit]
Description=Turnwire headless host (DSH, daemon and remote control)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${root}
Environment=TURNWIRE_INSTALL_DIR=${root}
${keys.slice(0, 10).map(key => `Environment=${unitQuote(`${key}=${paths[key]}`)}`).join('\n')}
Environment=${unitQuote(`PATH=${join(node, '..')}:/usr/local/bin:/usr/bin:/bin`)}
ExecStart=${unitQuote(node)} ${unitQuote(`${root}/apps/daemon/dist/host-service.mjs`)}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=mixed
UMask=0077

[Install]
WantedBy=default.target
`, { mode: 0o600 });
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit', env: cleanEnv });
execFileSync('systemctl', ['--user', 'enable', '--now', 'turnwire-host.service'], { stdio: 'inherit', env: cleanEnv });
console.log(`Installed ${bin}/turnwire. Start TUI with: ${bin}/turnwire tui`);
console.log('Enable user lingering for startup without SSH: sudo loginctl enable-linger "$USER"');
