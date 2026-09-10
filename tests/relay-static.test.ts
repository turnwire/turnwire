import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startRelay } from '../apps/relay/src/server.js';

it('serves the public PWA without exposing private files or daemon endpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'turnwire-relay-web-'));
  const root = join(directory, 'public');
  await mkdir(root);
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Turnwire Remote</title>');
  await writeFile(join(directory, 'private.html'), 'private content');
  await writeFile(join(root, '.env'), 'private configuration');
  await symlink(join(directory, 'private.html'), join(root, 'escape.html'));
  const relay = await startRelay({ token: 'r'.repeat(32), port: 0, webRoot: root });
  const url = `http://127.0.0.1:${relay.port}`;
  try {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Turnwire Remote');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await (await fetch(url, { method: 'HEAD' })).text()).toBe('');
    for (const path of ['/escape.html', '/.env', '/%2e%2e%2fprivate.html', '/rpc', '/devices', '/events']) {
      expect((await fetch(url + path)).status, path).toBe(404);
    }
    expect((await fetch(url, { method: 'POST' })).status).toBe(405);
  } finally {
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
});
