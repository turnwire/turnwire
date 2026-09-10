import { expect, it } from 'vitest';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startCloudflareTunnel } from '../apps/daemon/src/providers/cloudflare.js';

async function fixture(source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'turnwire-tunnel-'));
  const binary = join(directory, 'cloudflared');
  await writeFile(binary, '#!' + process.execPath + '\n' + source);
  await chmod(binary, 0o700);
  return { directory, binary };
}
it('owns the tunnel process and keeps daemon credentials out of its environment', async () => {
  // The test closes the process as soon as it is ready, so report the environment first.
  const { directory, binary } = await fixture("process.stdout.write('host-secret=' + Boolean(process.env.TURNWIRE_RELAY_TOKEN) + '\\nhttps://fixture.trycloudflare.com\\nRegistered tunnel connection\\n'); setInterval(() => {}, 1000);");
  const previousPath = process.env.TURNWIRE_CLOUDFLARED_PATH, previousSecret = process.env.TURNWIRE_RELAY_TOKEN;
  process.env.TURNWIRE_CLOUDFLARED_PATH = binary; process.env.TURNWIRE_RELAY_TOKEN = 'secret-for-daemon-only';
  try {
    const tunnel = await startCloudflareTunnel({ directory, port: 12345, signal: new AbortController().signal, progress: () => {}, exited: () => {} });
    expect(tunnel.url).toBe('https://fixture.trycloudflare.com');
    await tunnel.close();
    await expect.poll(() => readFile(join(directory, 'tunnel/cloudflared.log'), 'utf8'), { timeout: 5000 }).toContain('host-secret=false');
    const log = await readFile(join(directory, 'tunnel/cloudflared.log'), 'utf8');
    expect(log).not.toContain('secret-for-daemon-only');
  } finally {
    if (previousPath === undefined) delete process.env.TURNWIRE_CLOUDFLARED_PATH; else process.env.TURNWIRE_CLOUDFLARED_PATH = previousPath;
    if (previousSecret === undefined) delete process.env.TURNWIRE_RELAY_TOKEN; else process.env.TURNWIRE_RELAY_TOKEN = previousSecret;
    await rm(directory, { recursive: true, force: true });
  }
});
it('aborts a tunnel that has not announced an address', async () => {
  const { directory, binary } = await fixture('setInterval(() => {}, 1000);');
  const previous = process.env.TURNWIRE_CLOUDFLARED_PATH; process.env.TURNWIRE_CLOUDFLARED_PATH = binary;
  const aborter = new AbortController();
  try {
    const task = startCloudflareTunnel({ directory, port: 12345, signal: aborter.signal, progress: () => { aborter.abort(); }, exited: () => {} });
    await expect(task).rejects.toThrow('cancelled');
  } finally {
    if (previous === undefined) delete process.env.TURNWIRE_CLOUDFLARED_PATH; else process.env.TURNWIRE_CLOUDFLARED_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
it('does not declare a tunnel ready when its URL appears before the edge connection fails', async () => {
  const { directory, binary } = await fixture("process.stdout.write('https://unregistered.trycloudflare.com\\n');");
  const previous = process.env.TURNWIRE_CLOUDFLARED_PATH; process.env.TURNWIRE_CLOUDFLARED_PATH = binary;
  try {
    await expect(startCloudflareTunnel({ directory, port: 12345, signal: new AbortController().signal, progress: () => {}, exited: () => {} })).rejects.toThrow('startup failed');
  } finally {
    if (previous === undefined) delete process.env.TURNWIRE_CLOUDFLARED_PATH; else process.env.TURNWIRE_CLOUDFLARED_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
