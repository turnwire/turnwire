import { readFile, writeFile, chmod, mkdir, lstat, unlink, symlink, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Backs up only owned/changed files; restoring never replaces an unrelated directory. */
export class FileTransaction {
  private originals = new Map<string, { content: Buffer; mode: number } | undefined>();
  constructor(private backupRoot: string) {}
  async write(path: string, content: string | Buffer, mode = 0o644) {
    if (!this.originals.has(path)) {
      const stat = await lstat(path).catch(() => undefined);
      if (stat && !stat.isFile()) throw new Error(`Refusing to replace non-file: ${path}`);
      const previous = stat ? { content: await readFile(path), mode: stat.mode & 0o777 } : undefined;
      this.originals.set(path, previous);
      if (previous) { const backup = this.backupRoot + path; await mkdir(dirname(backup), { recursive: true, mode: 0o700 }); await writeFile(backup, previous.content, { mode: 0o600 }); }
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o755 });
    const next = path + '.turnwire-next'; await writeFile(next, content, { mode }); await chmod(next, mode); await rename(next, path);
  }
  async rollback() {
    for (const [path, previous] of [...this.originals].reverse()) {
      if (previous) { await writeFile(path, previous.content, { mode: previous.mode }); await chmod(path, previous.mode); }
      else await unlink(path).catch(() => {});
    }
  }
}
export async function pointRelease(link: string, target: string) {
  const next = link + '.next'; await unlink(next).catch(() => {}); await symlink(target, next); await rename(next, link);
}
