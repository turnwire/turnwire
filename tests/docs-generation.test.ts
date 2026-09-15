import { afterEach, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const targets = ['README.md', 'README.zh.md', 'docs/QUICKSTART.md', 'docs/QUICKSTART.zh.md', 'docs/NPM-README.md', 'docs/NPM-README.zh.md'];
const temporary: string[] = [];
const begin = '<!-- BEGIN GENERATED INSTALL: scripts/sync-docs.mjs -->';
const end = '<!-- END GENERATED INSTALL -->';
const read = (base: string, path: string) => readFileSync(join(base, path), 'utf8');
const run = (base: string, ...args: string[]) => spawnSync(process.execPath, [join(base, 'scripts/sync-docs.mjs'), ...args], { cwd: tmpdir(), encoding: 'utf8' });
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'turnwire-docs-'));
  temporary.push(base);
  for (const path of ['scripts/sync-docs.mjs', 'docs/install-snippets.json', 'package.json', ...targets]) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    copyFileSync(resolve(root, path), join(base, path));
  }
  return base;
}
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

it('checks all six generated documents without depending on the working directory', () => {
  const result = run(root, '--check');
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  for (const language of ['', '.zh']) {
    const blocks = ['README', 'docs/QUICKSTART', 'docs/NPM-README'].map(path => read(root, `${path}${language}.md`).split(begin)[1]!.split(end)[0]);
    expect(new Set(blocks).size).toBe(1);
    expect(blocks[0]).toContain('npx turnwire@next');
    expect(blocks[0]).toContain('npm install -g turnwire@next');
    expect(blocks[0]).toContain('`main`');
    expect(blocks[0]).toContain('`latest`');
    expect(blocks[0]).toContain('GitHub Release');
    expect(blocks[0]).not.toMatch(/turnwire@\d/);
  }
});

it('defaults to read-only check, diagnoses stale content, and repairs only the managed block', () => {
  const base = fixture();
  const original = read(base, 'README.md');
  const blockStart = original.indexOf(begin);
  const modified = original.slice(0, blockStart) + original.slice(blockStart).replace('npx turnwire@next', 'npx turnwire@stale');
  const stale = `Unmanaged prefix\n${modified}Unmanaged suffix\n`;
  writeFileSync(join(base, 'README.md'), stale);
  for (const args of [[], ['--check']]) {
    const result = run(base, ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('README.md');
    expect(result.stderr).toContain('--write');
    expect(read(base, 'README.md')).toBe(stale);
  }
  expect(run(base, '--write').status).toBe(0);
  expect(read(base, 'README.md')).toBe(`Unmanaged prefix\n${original}Unmanaged suffix\n`);
  expect(run(base, '--write').stdout).not.toContain('Updated');
  expect(run(base, '--check').status).toBe(0);
});

it('propagates the canonical engine baseline and bilingual source changes', () => {
  const base = fixture();
  const manifest = JSON.parse(read(base, 'package.json'));
  manifest.engines.node = '>=24.2.1';
  writeFileSync(join(base, 'package.json'), JSON.stringify(manifest));
  const snippets = JSON.parse(read(base, 'docs/install-snippets.json'));
  snippets.en.push('English fixture line.');
  snippets.zh.push('中文测试行。');
  writeFileSync(join(base, 'docs/install-snippets.json'), JSON.stringify(snippets));
  expect(run(base).status).toBe(1);
  expect(run(base, '--write').status).toBe(0);
  for (const target of targets) {
    expect(read(base, target)).toContain('Node.js 24.2.1+');
    expect(read(base, target)).toContain(target.endsWith('.zh.md') ? '中文测试行。' : 'English fixture line.');
  }
  expect(run(base).status).toBe(0);
});

it.each(['missing', 'duplicate', 'reversed'])('rejects %s markers before writing any document', kind => {
  const base = fixture();
  const stale = read(base, 'README.md').replace('npx turnwire@next', 'npx turnwire@stale');
  writeFileSync(join(base, 'README.md'), stale);
  const target = targets.at(-1)!;
  const text = read(base, target);
  const malformed = kind === 'missing' ? text.replace(end, '') : kind === 'duplicate' ? text + begin + end : text.replace(begin, 'PLACEHOLDER').replace(end, begin).replace('PLACEHOLDER', end);
  writeFileSync(join(base, target), malformed);
  const result = run(base, '--write');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('marker pair');
  expect(read(base, 'README.md')).toBe(stale);
  expect(read(base, target)).toBe(malformed);
});

it('rejects unknown or conflicting flags without writing', () => {
  const base = fixture();
  const before = read(base, 'README.md');
  for (const args of [['--wat'], ['--write', '--check']]) {
    const result = run(base, ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage:');
  }
  expect(read(base, 'README.md')).toBe(before);
});
