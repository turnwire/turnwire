import { expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('shares a new XDG client config between isolated daemon and CLI without a legacy directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnwire-xdg-'));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), TURNWIRE_RUNTIME: 'demo', TURNWIRE_PORT: '0' };
  for (const key of ['TURNWIRE_HOME', 'TURNWIRE_CONFIG_HOME', 'TURNWIRE_DATA_HOME', 'TURNWIRE_CACHE_HOME', 'TURNWIRE_RELAY_URL', 'TURNWIRE_RELAY_TOKEN']) delete env[key];
  const daemon = spawn(process.execPath, ['--import', 'tsx', resolve('apps/daemon/src/main.ts')], { env, stdio: 'pipe' });
  let diagnostics = ''; daemon.stderr.on('data', chunk => { diagnostics += String(chunk); });
  const stopped = new Promise(resolveExit => daemon.once('exit', resolveExit));
  try {
    const clientFile = join(root, 'config/turnwire/client.json');
    await expect.poll(async () => JSON.parse(await readFile(clientFile, 'utf8')).url, { timeout: 10000, message: diagnostics }).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await stat(clientFile)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(root, 'state/turnwire'))).toContain('state.db');
    const cli = spawn(process.execPath, ['--import', 'tsx', resolve('apps/cli/src/main.ts'), 'status', '--json'], { env, stdio: 'pipe' });
    let output = ''; let error = ''; cli.stdout.on('data', chunk => { output += String(chunk); }); cli.stderr.on('data', chunk => { error += String(chunk); });
    expect(await new Promise(resolveExit => cli.once('exit', resolveExit)), error).toBe(0);
    expect(JSON.parse(output).runtimes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'demo' })]));
    expect(await readdir(root)).not.toContain('.turnwire');
    expect(await readdir(join(root, 'state/turnwire'))).not.toContain('client.json');
  } finally { daemon.kill('SIGTERM'); await stopped; await rm(root, { recursive: true, force: true }); }
}, 20000);
