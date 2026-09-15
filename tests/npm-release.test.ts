import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/npm-release.yml', import.meta.url), 'utf8');
const validation = workflow.split('          set -euo pipefail\n')[1]!.split('  test-package:')[0]!.split('\n').map(line => line.replace(/^          /, '')).join('\n');
// Stub only Git metadata. Execute the actual workflow's tag/channel validation.
const git = `git() { case "$1" in rev-parse) echo abc123 ;; merge-base) return 0 ;; *) return 1 ;; esac; }\n`;
describe('npm Release publication policy', () => {
  it('accepts only matching preview/stable release flags and safe version tags', () => {
    const home = mkdtempSync(join(tmpdir(), 'turnwire-release-policy-'));
    try {
      for (const [tag, prerelease, ok] of [
        ['v0.1.0-next.1', 'true', true], ['v1.2.3', 'false', true],
        ['v1.2.3', 'true', false], ['v0.1.0-next.1', 'false', false],
        ['v1.2.3-beta.1', 'true', false], ['v01.2.3', 'false', false],
        ['v1.2.3;echo bad', 'false', false],
      ] as const) {
        const result = spawnSync('bash', ['-c', 'set -euo pipefail\n' + git + validation], { env: { PATH: process.env.PATH, RELEASE_TAG: tag, RELEASE_EVENT: 'release', RELEASE_PRERELEASE: prerelease, GITHUB_OUTPUT: join(home, 'output') }, encoding: 'utf8' });
        expect(result.status === 0, `${tag}/${prerelease}: ${result.stderr}`).toBe(ok);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('gates publication on package and real DSH tests and confines write permissions', () => {
    expect(workflow).toContain('types: [published]');
    expect(workflow).toContain('npm publish ./release/*.tgz');
    expect(workflow).not.toContain('npm publish release/*.tgz');
    expect(workflow).toContain('needs: [authorize, test-package, test-dsh]');
    expect(workflow).toContain("inputs.confirm == 'publish-turnwire'");
    expect(workflow).toContain('git merge-base --is-ancestor');
    expect(workflow).toContain('metadata.dist?.integrity !== integrity');
    expect(workflow).toContain('needs: [authorize, publish]');
    expect(workflow).toContain('cmp "$file" "existing/$name"');
    expect(workflow).not.toContain('gh release upload "$RELEASE_TAG" "$file" --clobber');
    expect(workflow.split('  publish:')[1]!.split('  release-assets:')[0]).not.toContain('contents: write');
  });
});
