import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink, stat, chmod, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'turnwire-bootstrap-')); roots.push(root);
  for (const dir of ['scripts', 'config', 'mock', 'runtime/node/bin', 'home']) await mkdir(join(root, dir), { recursive: true });
  await copyFile(resolve('scripts/start-host.sh'), join(root, 'scripts/start-host.sh'));
  await copyFile(resolve('scripts/host-paths.sh'), join(root, 'scripts/host-paths.sh'));
  await writeFile(join(root, 'package-lock.json'), '{}');
  const command = async (name: string, body: string) => writeFile(join(root, name), `#!/bin/bash\nset -eu\n[[ -z \${TURNWIRE_HARNESS_DEEPSEEK_API_KEY-} ]] || { echo SECRET_LEAK; exit 99; }\n${body}\n`, { mode: 0o755 });
  await command('mock/id', 'echo 1000');
  await command('mock/uname', 'if [[ $1 == -s ]]; then echo "${OS:-Linux}"; else echo x86_64; fi');
  await command('mock/systemctl', `printf '%s\\n' "$*" >> "$FIXTURE/calls"
case "$2" in
 show-environment) exit 0 ;;
 show) if [[ \${UNIT:-missing} == missing ]]; then echo LoadState=not-found; else
 echo LoadState=loaded
 echo "WorkingDirectory=\${WORK:-$FIXTURE}"
 echo "ExecStart={ path=\${SERVICE_NODE:-$FIXTURE/runtime/node/bin/node} ; argv[]=\${SERVICE_NODE:-$FIXTURE/runtime/node/bin/node} $FIXTURE/\${ENTRY:-apps/daemon/dist/host-service.mjs} ; }"
 fi ;;
 is-active) [[ \${UNIT:-missing} == active ]] ;;
 start) exit "\${START_FAIL:-0}" ;;
 *) exit 91 ;;
esac`);
  await command('runtime/node/bin/node', `exec '${process.execPath}' "$@"`);
  await command('runtime/node/bin/npm', 'echo "npm $*" >> "$FIXTURE/calls"; exit "${NPM_FAIL:-0}"');
  await command('scripts/install-linux-host.sh', 'echo install >> "$FIXTURE/calls"');
  for (const name of ['curl', 'tar', 'xz', 'sha256sum']) await command(`mock/${name}`, `echo '${name}' >> "$FIXTURE/calls"; exit 90`);
  const run = (args: string[] = [], env: Record<string, string> = {}) => {
    const result = spawnSync('/bin/bash', [join(root, 'scripts/start-host.sh'), ...args], {
      env: { PATH: `${root}/mock:/usr/bin:/bin`, HOME: join(root, 'home'), FIXTURE: root, ...env }, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ...result, output: result.stdout + result.stderr };
  };
  const calls = async () => readFile(join(root, 'calls'), 'utf8').catch(() => '');
  return { root, run, calls, command };
}
it('help and check are side effect free and do not need credentials', async () => {
  const f = await fixture(); expect(f.run(['--help']).status).toBe(0); expect(await f.calls()).toBe('');
  expect(f.run(['--check']).status).toBe(0);
  expect(await f.calls()).not.toMatch(/npm|install|curl|start /);
  await expect(stat(join(f.root, 'config/dsh.env.json'))).rejects.toThrow();
});
it.each(['active', 'stopped'])('reuses matching %s service without build or credentials', async unit => {
  const f = await fixture(); const result = f.run([], { UNIT: unit }); expect(result.status).toBe(0);
  const calls = await f.calls(); expect(calls).not.toMatch(/npm|install|curl/);
  expect(calls.includes('--user start turnwire-host.service')).toBe(unit === 'stopped');
});
it('restarts an installed XDG service using its recorded Node path without reinstalling', async () => {
  const f = await fixture(); const result = f.run([], { UNIT: 'stopped', SERVICE_NODE: `${f.root}/old-data/runtime/node/bin/node`, XDG_DATA_HOME: `${f.root}/new-data` });
  expect(result.status, result.output).toBe(0); expect(await f.calls()).toContain('--user start turnwire-host.service'); expect(await f.calls()).not.toMatch(/npm|install|curl/);
});
it('fresh bootstrap writes XDG credentials without creating repository runtime or state', async () => {
  const f = await fixture(); const data = `${f.root}/home/data`;
  await mkdir(`${data}/turnwire`, { recursive: true }); await rename(`${f.root}/runtime`, `${data}/turnwire/runtime`);
  const result = f.run([], { XDG_DATA_HOME: data, XDG_CONFIG_HOME: `${f.root}/home/config`, TURNWIRE_HARNESS_DEEPSEEK_API_KEY: 'private' });
  expect(result.status, result.output).toBe(0);
  expect(JSON.parse(await readFile(`${f.root}/home/config/turnwire/dsh.env.json`, 'utf8'))).toEqual({ TURNWIRE_HARNESS_DEEPSEEK_API_KEY: 'private' });
  for (const path of ['runtime', 'state', 'dsh-state', 'config/dsh.env.json']) await expect(stat(join(f.root, path))).rejects.toThrow();
});
it('rejects another checkout or development unit without touching service', async () => {
  const f = await fixture();
  for (const env of [{ WORK: '/another/checkout' }, { ENTRY: 'apps/daemon/src/main.ts' }] as Record<string, string>[]) {
    expect(f.run([], { UNIT: 'active', ...env }).status).toBe(1);
  }
  expect(await f.calls()).not.toMatch(/--user start |npm|install|stop/);
});
it('encodes quoted credentials privately and never exports them to commands', async () => {
  const f = await fixture(); const key = 'secret-"\\\n$`quoted';
  const result = f.run([], { TURNWIRE_HARNESS_DEEPSEEK_API_KEY: key });
  expect(result.output).not.toContain(key); expect(result.output).not.toContain('SECRET_LEAK'); expect(result.status).toBe(0);
  const file = join(f.root, 'config/dsh.env.json'); expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ TURNWIRE_HARNESS_DEEPSEEK_API_KEY: key });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await f.calls()).toContain('npm ci --no-audit --no-fund\nnpm run build\ninstall');
  const original = await readFile(file, 'utf8'); expect(f.run([], { TURNWIRE_HARNESS_DEEPSEEK_API_KEY: 'replacement' }).status).toBe(0);
  expect(await readFile(file, 'utf8')).toBe(original);
});
it.each(['[]', '{"TURNWIRE_HARNESS_DEEPSEEK_API_KEY":123}', '{bad', '{"TURNWIRE_HARNESS_DEEPSEEK_API_KEY":"secret","OTHER":{}}'])('rejects invalid existing config without printing or replacing it: %s', async config => {
  const f = await fixture(); const file = join(f.root, 'config/dsh.env.json'); await writeFile(file, config, { mode: 0o600 });
  const result = f.run(); expect(result.status).not.toBe(0); expect(result.output).not.toContain('secret');
  expect(await readFile(file, 'utf8')).toBe(config); expect(await f.calls()).not.toMatch(/npm|install/);
});
it('rejects symlinks and nonprivate credential files', async () => {
  const f = await fixture(); const target = join(f.root, 'target'); const file = join(f.root, 'config/dsh.env.json');
  await writeFile(target, '{}'); await symlink(target, file); expect(f.run().status).toBe(1);
  await rm(file); await writeFile(file, '{"TURNWIRE_HARNESS_DEEPSEEK_API_KEY":"secret"}', { mode: 0o644 }); await chmod(file, 0o644);
  expect(f.run().status).toBe(1); expect(await f.calls()).not.toMatch(/npm|install/);
});
it('fails noninteractively with instructions and propagates build/start failures', async () => {
  const f = await fixture(); const missing = f.run(); expect(missing.status).toBe(1); expect(missing.output).toContain('TURNWIRE_HARNESS_DEEPSEEK_API_KEY');
  expect(f.run([], { TURNWIRE_HARNESS_DEEPSEEK_API_KEY: 'secret', NPM_FAIL: '7' }).status).toBe(7);
  expect(await f.calls()).not.toContain('install');
  expect(f.run([], { UNIT: 'stopped', START_FAIL: '1' }).status).toBe(1);
});
it('bootstraps pinned Node with checksum verification before extraction and build', async () => {
  const f = await fixture();
  await mkdir(join(f.root, 'saved'));
  await copyFile(join(f.root, 'runtime/node/bin/node'), join(f.root, 'saved/node'));
  await copyFile(join(f.root, 'runtime/node/bin/npm'), join(f.root, 'saved/npm'));
  await rm(join(f.root, 'runtime/node'), { recursive: true });
  await f.command('mock/curl', `echo "curl $*" >> "$FIXTURE/calls"; dest=; while [[ $# -gt 0 ]]; do if [[ $1 == -o ]]; then dest=$2; shift; fi; shift; done; printf 'checksum  node-v22.23.2-linux-x64.tar.xz\\n' > "$dest"`);
  await f.command('mock/sha256sum', 'echo checksum >> "$FIXTURE/calls"; while IFS= read -r line; do :; done');
  await f.command('mock/tar', 'echo extract >> "$FIXTURE/calls"; mkdir -p "$4/node-v22.23.2-linux-x64/bin"; cp "$FIXTURE/saved/"* "$4/node-v22.23.2-linux-x64/bin/"');
  const result = f.run([], { TURNWIRE_HARNESS_DEEPSEEK_API_KEY: 'secret-bootstrap' }); expect(result.status, result.output).toBe(0);
  const calls = await f.calls(); expect(calls).toContain('https://nodejs.org/dist/v22.23.2/SHASUMS256.txt'); expect(calls).toContain('checksum\nextract\nnpm ci');
  expect(calls).not.toContain('secret-bootstrap');
});
it('rejects root and refuses checksum failure before extraction', async () => {
  const f = await fixture(); await f.command('mock/id', 'echo 0'); expect(f.run(['--check']).status).toBe(1);
  await f.command('mock/id', 'echo 1000'); await rm(join(f.root, 'runtime/node'), { recursive: true });
  await f.command('mock/curl', 'while [[ $# -gt 0 ]]; do if [[ $1 == -o ]]; then printf "bad  node-v22.23.2-linux-x64.tar.xz\\n" > "$2"; shift; fi; shift; done');
  const result = f.run([], { TURNWIRE_HARNESS_DEEPSEEK_API_KEY: 'secret' }); expect(result.status).toBe(1); expect(result.output).toContain('checksum verification failed');
  expect(await f.calls()).not.toMatch(/^tar$|npm|install/m);
});
it('rejects unsupported platforms and fails closed on download failure', async () => {
  const f = await fixture(); expect(f.run([], { OS: 'Darwin' }).status).toBe(1);
  await rm(join(f.root, 'runtime/node'), { recursive: true });
  const result = f.run([], { TURNWIRE_HARNESS_DEEPSEEK_API_KEY: 'private' });
  expect(result.status).toBe(90); expect(result.output).not.toContain('private'); expect(await f.calls()).not.toMatch(/npm|install/);
  await expect(stat(join(f.root, 'config/dsh.env.json'))).rejects.toThrow();
});
