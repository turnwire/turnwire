import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repository = fileURLToPath(new URL('..', import.meta.url));
// The contract is that user-visible text is English while clients localize stable codes.
// Relay authentication/push errors reach a paired phone; deployer status and failure text
// reaches whichever client requested the deployment. Cover Han ideographs (as packages/core
// and apps/daemon do) plus CJK punctuation and fullwidth forms so a stray `；` separator
// cannot slip through as non-English prose.
const cjk = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

/** Text passed through `error.message` or a status field is the host's English fallback, not UI copy. */
function stringLiteralTexts(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const texts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) texts.push(node.text);
    else if (ts.isTemplateExpression(node)) { texts.push(node.head.text); for (const span of node.templateSpans) texts.push(span.literal.text); }
    ts.forEachChild(node, visit);
  };
  visit(file); return texts;
}

/**
 * Intentional non-English string literals for these trees. Each entry must name a file
 * relative to its root, the exact literal text and why it cannot be translated. Empty today:
 * every message in both trees is prose that clients render, and the only external-output
 * patterns (SSH stderr matching in apps/deployer/src/ssh.ts) are ASCII.
 */
const exceptions: ReadonlyArray<{ root: string; file: string; text: string; reason: string }> = [];

describe('relay and deployer internationalisation', () => {
  const roots = ['apps/relay/src', 'apps/deployer/src'];

  it('collects string literals from both trees without a silent pass', async () => {
    for (const root of roots) {
      const entries = await readdir(join(repository, root), { recursive: true });
      expect(entries.some(entry => entry.endsWith('.ts')), `${root} contains TypeScript sources`).toBe(true);
    }
  });

  it('keeps relay and deployer user-visible text English', async () => {
    const offenders: string[] = [];
    for (const root of roots) {
      const directory = join(repository, root);
      for (const entry of await readdir(directory, { recursive: true })) {
        if (!entry.endsWith('.ts')) continue;
        const source = await readFile(join(directory, entry), 'utf8');
        for (const text of stringLiteralTexts(entry, source)) {
          if (!cjk.test(text)) continue;
          const declared = exceptions.some(exception => exception.root === root && exception.file === entry && exception.text === text);
          if (!declared) offenders.push(`${root}/${entry}: ${JSON.stringify(text)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only declares exceptions that still exist and still carry CJK text', async () => {
    for (const exception of exceptions) {
      const source = await readFile(join(repository, exception.root, exception.file), 'utf8');
      const texts = stringLiteralTexts(exception.file, source);
      expect(texts, `${exception.root}/${exception.file} still contains ${JSON.stringify(exception.text)}`).toContain(exception.text);
      expect(cjk.test(exception.text), `${exception.root}/${exception.file} exception is no longer CJK`).toBe(true);
      expect(exception.reason.trim(), `${exception.root}/${exception.file} exception needs a reason`).not.toBe('');
    }
  });
});
