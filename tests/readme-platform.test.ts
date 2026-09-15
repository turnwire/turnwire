import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
it('keeps README entry points platform-neutral without claiming universal compatibility', () => {
  for (const path of ['README.md', 'README.zh.md', 'docs/NPM-README.md', 'docs/NPM-README.zh.md']) {
    const text = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
    expect(text, path).not.toMatch(/\b(?:macOS|Mac|Linux|systemd)\b/);
    expect(text, path).not.toMatch(/\bv[12]\b/);
    expect(text, path).toMatch(/package constraints|安装包约束/);
  }
});
it('presents exactly four connectivity deployment methods in each root README', () => {
  for (const [path, heading, names] of [
    ['README.md', '## Choose a deployment method', ['Local', 'Temporary tunnel', 'Named tunnel', 'Self-deployed Relay']],
    ['README.zh.md', '## 选择部署方式', ['本地', '临时隧道', '命名隧道', '自部署 Relay']],
  ] as const) {
    const text = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
    const section = text.split(heading)[1]!.split('\n## ')[0]!;
    const rows = section.split('\n').filter(line => line.startsWith('| ')).slice(2);
    expect(rows).toHaveLength(4);
    for (let i = 0; i < names.length; i++) expect(rows[i]!.startsWith('| ' + names[i] + ' |')).toBe(true);
  }
});
