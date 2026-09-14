import { expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createProgram } from '../apps/cli/src/program.js';
import { DSH_SOURCE_REVISION } from '../packages/runtime-dsh/src/index.js';

/**
 * Documentation drift is invisible until someone follows the wrong command, so the mechanical
 * claims in the docs are asserted here: a renamed script, a moved file, a command that no longer
 * exists, a command that exists but is undocumented, a stale DSH pin, or a credential name that
 * changed in one place only. Anything a test cannot decide (prose, ordering) stays unasserted on
 * purpose — this file guards facts, not wording.
 */
const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const manifest = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
const documents = [
  ...readdirSync(root).filter(name => name.endsWith('.md') && name !== 'AGENTS.md'),
  ...readdirSync(resolve(root, 'docs')).filter(name => name.endsWith('.md')).map(name => `docs/${name}`),
];
/**
 * Documented paths that are deliberately absent from the repository: the operator creates these
 * with mode 0600 (see docs/DEPLOYMENT.md), so a fresh clone never has them. Everything else a
 * document points at must exist, which is what catches a renamed or moved file.
 */
const privatePaths = new Set(['config/dsh.env.json']);

it('only documents npm scripts that exist', () => {
  const missing = new Set<string>();
  for (const document of documents) {
    for (const [, script] of read(document).matchAll(/npm run ([a-z:][\w:-]*)/g)) if (!manifest.scripts[script!]) missing.add(`${document}: npm run ${script}`);
  }
  expect([...missing]).toEqual([]);
});

it('only references repository files that exist', () => {
  const missing = new Set<string>();
  for (const document of documents) {
    for (const [, path] of read(document).matchAll(/`((?:apps|packages|docs|config|scripts|deploy)\/[\w./-]+)`/g)) {
      // Build output is absent from a fresh clone, and `npm run check` builds after the tests.
      if (path!.includes('dist/') || privatePaths.has(path!)) continue;
      if (!existsSync(resolve(root, path!))) missing.add(`${document}: ${path}`);
    }
  }
  expect([...missing]).toEqual([]);
});

it('only documents CLI commands the program defines', () => {
  const groups = new Map(createProgram().commands.map(command => [command.name(), new Set(command.commands.map(sub => sub.name()))]));
  const unknown = new Set<string>();
  for (const document of documents) {
    for (const [, group, sub] of read(document).matchAll(/`turnwire ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
      const subs = groups.get(group!);
      if (!subs) unknown.add(`${document}: turnwire ${group}`);
      else if (sub && subs.size > 0 && !subs.has(sub)) unknown.add(`${document}: turnwire ${group} ${sub}`);
    }
  }
  expect([...unknown]).toEqual([]);
});

it('documents every top-level CLI command', () => {
  const documented = documents.map(document => read(document)).join('\n');
  const undocumented = createProgram().commands.map(command => command.name()).filter(name => !documented.includes(`\`turnwire ${name}`));
  expect(undocumented).toEqual([]);
});

it('pins the DSH build the adapter was written against', () => {
  const contract = read('docs/DSH.md');
  expect(contract).toContain(DSH_SOURCE_REVISION);
  const version = /@deepseek-ai\/dsh@([0-9][^\s"']*)/.exec(manifest.scripts['dev:dsh'] ?? '')?.[1];
  expect(version).toBeTruthy();
  expect(contract).toContain(version!);
  expect(read('docs/DEVELOPING.md')).toContain(version!);
});

it('names the DSH credential variable the same way everywhere', () => {
  const name = /apiKeyEnv:\s*([A-Z][A-Z0-9_]*)/.exec(read('config/dsh-deepseek.patch.yml'))?.[1];
  expect(name).toBeTruthy();
  for (const file of ['docs/DEVELOPING.md', 'AGENTS.md', '.env.example', 'docs/DEPLOYMENT.md', 'docs/DSH.md', 'apps/daemon/src/host-service.ts']) {
    expect(read(file), file).toContain(name!);
  }
});

it('announces its other language', () => {
  const missing: string[] = [];
  for (const document of documents) {
    const counterpart = document.endsWith('.zh.md') ? document.replace(/\.zh\.md$/, '.md') : document.replace(/\.md$/, '.zh.md');
    const name = counterpart.split('/').pop()!;
    if (!(read(document).split('\n')[0] ?? '').includes(`](${name})`)) missing.push(`${document} -> ${name}`);
  }
  expect(missing).toEqual([]);
});

it('links to files that exist', () => {
  const broken = new Set<string>();
  for (const document of documents) {
    for (const [, target] of read(document).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (target!.includes('://') || target!.startsWith('mailto:')) continue;  // external links are not repository files
      if (!existsSync(resolve(root, document, '..', target!))) broken.add(`${document} -> ${target}`);
    }
  }
  expect([...broken]).toEqual([]);
});

it('links to headings that exist', () => {
  const broken = new Set<string>();
  for (const document of documents) {
    for (const [, file, anchor] of read(document).matchAll(/\((docs\/[\w.-]+\.md)#([^)]+)\)/g)) {
      if (!existsSync(resolve(root, file!))) { broken.add(`${document}: missing ${file}`); continue; }
      const wanted = decodeURIComponent(anchor!).trim().toLowerCase().replace(/\s+/g, '-');
      const headings = [...read(file!).matchAll(/^#+\s+(.+)$/gm)].map(match => match[1]!.trim().toLowerCase().replace(/\s+/g, '-'));
      if (!headings.includes(wanted)) broken.add(`${document}: ${file}#${anchor}`);
    }
  }
  expect([...broken]).toEqual([]);
});

it('does not advertise removed configuration, pairing commands or SDK paths', () => {
  const obsolete = [
    /\bTURNWIRE_HOME\s*=|`TURNWIRE_HOME\//,
    /\b(?:turnwire\s+)?devices\s+upgrade\b/,
    /packages\/sdk\/src\/(?:crypto|session-crypto|session)\.ts/,
    /\bcallTyped\s*(?:<[^>]*>)?\s*\(/,
    /\b(?:client|sdk|local|remote)\.rpc\s*(?:<[^>]*>)?\s*\(/,
  ];
  for (const document of [...documents, '.env.example']) {
    for (const pattern of obsolete) expect(read(document), document).not.toMatch(pattern);
  }
});

it('documents independent directory overrides in both languages and the environment example', () => {
  for (const document of ['docs/XDG.md', 'docs/XDG.zh.md', '.env.example']) {
    for (const kind of ['CONFIG', 'STATE', 'DATA', 'CACHE']) {
      expect(read(document), document).toContain(`TURNWIRE_${kind}_HOME`);
    }
  }
});

it('keeps final maintenance guidance bilingual and linked from directory rules', () => {
  for (const suffix of ['', '.zh']) {
    const document = `docs/FIRST-UPGRADE${suffix}.md`;
    const text = read(document);
    expect(read(`docs/XDG${suffix}.md`)).toContain(`(FIRST-UPGRADE${suffix}.md)`);
    for (const boundary of ['Store', 'schema', 'v2', 'OUTCOME_UNKNOWN', 'TURNWIRE_STATE_HOME', 'packages/wire']) {
      expect(text, document).toContain(boundary);
    }
    expect(text, document).not.toMatch(/117a4ef|b44bd28|753707|22881ff2-d3a0-4f67-a843-9abb051bc8ec/);
  }
});
