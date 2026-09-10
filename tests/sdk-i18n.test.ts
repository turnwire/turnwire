import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { transcriptMarkdown } from '@turnwire/sdk';
import type { ConversationMessage } from '@turnwire/sdk';
import type { Session } from '@turnwire/protocol';

/** Text carried by `error.message`, a health `message` or a transcript label is a fallback, not UI copy:
 * the shared contract is the error code and the label set, and each client renders its own localized sentence. */
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

describe('shared client internationalisation', () => {
  it('keeps packages/sdk user-visible text English so clients localize by code', async () => {
    const repository = fileURLToPath(new URL('..', import.meta.url));
    const root = 'packages/sdk/src';
    const directory = join(repository, root);
    const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
    const offenders: string[] = [];
    for (const entry of await readdir(directory, { recursive: true })) {
      if (!entry.endsWith('.ts')) continue;
      const source = await readFile(join(directory, entry), 'utf8');
      for (const text of stringLiteralTexts(entry, source)) if (cjk.test(text)) offenders.push(`${root}/${entry}: ${JSON.stringify(text)}`);
    }
    // Intentionally no exemptions: unlike the daemon's cpolar provider, the SDK never has to match a
    // server-produced Chinese log line, so every string literal it carries must stay English.
    expect(offenders).toEqual([]);
  });

  it('renders English transcript labels by default and accepts a localized label set', () => {
    const session: Session = { id: 's', title: 'Test', cwd: '/tmp', runtimeId: 'demo', runtimeSessionId: 's', status: 'idle', createdAt: '', updatedAt: '' };
    const messages: ConversationMessage[] = [
      { id: 'm', role: 'user', text: 'hello', time: '', complete: true },
      { id: 'c', role: 'tool', text: 'ok', tool: 'shell', time: '', complete: true, input: 'run' },
    ];
    const fallback = transcriptMarkdown(session, messages);
    expect(fallback).toContain('Working directory: /tmp');
    expect(fallback).toContain('Session: s');
    expect(fallback).toContain('## Tool · shell');
    expect(fallback).toContain('### Input');
    expect(fallback).toContain('### Output');
    expect(fallback).toContain('Not returned yet');
    expect(fallback).toContain('## You');
    const localized = transcriptMarkdown(session, messages, { workingDirectory: '工作目录：', session: '会话：', tool: '工具', input: '输入', output: '输出', pendingOutput: '尚未返回', you: '你' });
    expect(localized).toContain('工作目录：/tmp');
    expect(localized).toContain('会话：s');
    expect(localized).toContain('## 工具 · shell');
    expect(localized).toContain('### 输入');
    expect(localized).toContain('### 输出');
  });
});
