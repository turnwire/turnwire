import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error JavaScript packaging helper
import { packageManifest } from '../scripts/package-npm.mjs';
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
it('uses the same Node baseline for docs source and npm package', () => {
  expect(packageManifest().engines.node).toBe(JSON.parse(read('package.json')).engines.node);
});
it('keeps shared install channel claims attached to actual publishing gates', () => {
  const snippets = JSON.parse(read('docs/install-snippets.json'));
  for (const language of ['en', 'zh']) {
    const content = snippets[language].join('\n');
    for (const expected of ['{{nodeMinimum}}', 'npx turnwire@next', '`main`', '`next`', '`latest`', 'GitHub Release']) expect(content).toContain(expected);
    expect(content).not.toMatch(/turnwire@\d+\.\d+\.\d+/);
  }
  const workflow = read('.github/workflows/npm-release.yml');
  expect(workflow).toContain("echo 'channel=next'");
  expect(workflow).toContain("echo 'channel=latest'");
  expect(workflow).toContain('test "$RELEASE_PRERELEASE" = false');
  expect(workflow).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
  expect(read('apps/launcher/main.mjs')).toContain("args[i] === '--open'");
});
