import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
it('keeps README entry points platform-neutral without claiming universal compatibility', () => {
  for (const path of ['README.md', 'README.zh.md', 'docs/NPM-README.md', 'docs/NPM-README.zh.md']) {
    const text = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
    expect(text, path).not.toMatch(/\b(?:macOS|Mac|Linux|systemd)\b/);
    expect(text, path).toMatch(/package constraints|安装包约束/);
  }
});
