#!/usr/bin/env node
// Edit docs/install-snippets.json for shared prose and package.json engines.node
// for the Node baseline, then run node scripts/sync-docs.mjs --write.
// Only marked blocks are generated; surrounding document prose stays untouched.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const begin = '<!-- BEGIN GENERATED INSTALL: scripts/sync-docs.mjs -->';
const end = '<!-- END GENERATED INSTALL -->';
const targets = ['README.md', 'README.zh.md', 'docs/QUICKSTART.md', 'docs/QUICKSTART.zh.md', 'docs/NPM-README.md', 'docs/NPM-README.zh.md'];

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--check', '--write'].includes(args[0]))) {
    throw new Error('Usage: node scripts/sync-docs.mjs [--check|--write] (default: --check)');
  }
  const write = args[0] === '--write';
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const minimum = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.engines?.node ?? '')?.[1];
  if (!minimum) throw new Error('package.json engines.node must be a single >=major.minor.patch baseline');
  const nodeMinimum = minimum.replace(/\.0$/, '');
  const snippets = JSON.parse(await readFile(resolve(root, 'docs/install-snippets.json'), 'utf8'));
  for (const language of ['en', 'zh']) {
    if (!Array.isArray(snippets[language]) || !snippets[language].every(line => typeof line === 'string')) {
      throw new Error(`docs/install-snippets.json: ${language} must be an array of lines`);
    }
  }
  // Validate every document before writing any of them, so broken markers cannot
  // silently erase prose or leave a partially synchronized set.
  const changes = [];
  for (const target of targets) {
    const path = resolve(root, target);
    const text = await readFile(path, 'utf8');
    if (text.split(begin).length !== 2 || text.split(end).length !== 2 || text.indexOf(end) < text.indexOf(begin)) {
      throw new Error(`${target}: expected exactly one ordered generated install marker pair`);
    }
    const language = target.endsWith('.zh.md') ? 'zh' : 'en';
    const content = snippets[language].join('\n').replaceAll('{{nodeMinimum}}', nodeMinimum);
    if (/\{\{[^}]*\}\}/.test(content)) throw new Error(`Unknown placeholder in ${language} install snippet`);
    const updated = text.slice(0, text.indexOf(begin)) + `${begin}\n${content}\n${end}` + text.slice(text.indexOf(end) + end.length);
    if (updated !== text) changes.push({ target, path, updated });
  }
  if (write) {
    for (const { target, path, updated } of changes) {
      await writeFile(path, updated);
      console.log(`Updated ${target}`);
    }
  } else if (changes.length) {
    console.error(`Stale generated documentation:\n${changes.map(({ target }) => `  ${target}`).join('\n')}\nRun node scripts/sync-docs.mjs --write and include the updated documents.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Generated installation docs are current (${targets.length} documents).`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
