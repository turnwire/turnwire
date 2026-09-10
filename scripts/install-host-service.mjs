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
const node = join(root, 'runtime/node/bin/node');
for (const file of [node, join(root, 'apps/daemon/dist/host-service.mjs'), join(root, 'runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'), join(root, 'config/dsh.env.json')]) await access(file);
const bin = join(root, 'bin'); await mkdir(bin, { recursive: true });
for (const directory of ['state', 'dsh-state', 'config']) { await mkdir(join(root, directory), { recursive: true, mode: 0o700 }); await chmod(join(root, directory), 0o700); }
await chmod(join(root, 'config/dsh.env.json'), 0o600);
await writeFile(join(bin, 'turnwire'), `#!/bin/sh\nTURNWIRE_SCRIPT=$(readlink -f -- "$0")\nTURNWIRE_ROOT=$(CDPATH= cd -- "$(dirname -- "$TURNWIRE_SCRIPT")/.." && pwd)\nexport TURNWIRE_HOME="\${TURNWIRE_HOME:-$TURNWIRE_ROOT/state}"\nexec "$TURNWIRE_ROOT/runtime/node/bin/node" "$TURNWIRE_ROOT/apps/cli/dist/main.js" "$@"\n`, { mode: 0o755 });
await chmod(join(bin, 'turnwire'), 0o755);
const userBin = join(homedir(), '.local/bin'); await mkdir(userBin, { recursive: true });
try { await lstat(join(userBin, 'turnwire')); } catch (error) { if (error.code !== 'ENOENT') throw error; await symlink(join(bin, 'turnwire'), join(userBin, 'turnwire')); }
const units = join(homedir(), '.config/systemd/user'); await mkdir(units, { recursive: true });
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
Environment=TURNWIRE_HOME=${root}/state
Environment=PATH=${root}/runtime/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${node} ${root}/apps/daemon/dist/host-service.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=mixed
UMask=0077

[Install]
WantedBy=default.target
`, { mode: 0o600 });
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', '--now', 'turnwire-host.service'], { stdio: 'inherit' });
console.log(`Installed ${bin}/turnwire. Start TUI with: ${bin}/turnwire tui`);
console.log('Enable user lingering for startup without SSH: sudo loginctl enable-linger "$USER"');
