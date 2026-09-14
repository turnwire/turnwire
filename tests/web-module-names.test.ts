import { readdirSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('keeps remote-web TypeScript module stems unique on case-insensitive filesystems', () => {
  const root = fileURLToPath(new URL('../apps/remote-web/src/', import.meta.url));
  const names = new Map<string, string[]>();
  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        // Extensionless resolution cannot distinguish Foo.tsx from foo.ts on macOS.
        const stem = relative(root, path).slice(0, -extname(path).length).toLowerCase();
        names.set(stem, [...(names.get(stem) ?? []), relative(root, path)]);
      }
    }
  }
  scan(root);
  expect([...names.values()].filter(paths => paths.length > 1)).toEqual([]);
});
