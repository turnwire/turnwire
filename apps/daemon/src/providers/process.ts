import { spawn } from 'node:child_process';
import type { TunnelHandle, TunnelOptions } from '../tunnel.js';

export function providerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
export function publicOrigin(value: string): string | undefined {
  try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) return url.origin; } catch {}
  return undefined;
}
/** Every provider is a foreground child. Credentials stay in private config files, never argv. */
export function processTunnel(options: TunnelOptions, executable: string, args: string[], parse: (line: string) => string | undefined, failure: string, cleanup: () => Promise<void> = async () => {}): Promise<TunnelHandle> {
  options.signal.throwIfAborted();
  const child = spawn(executable, args, { cwd: options.directory, env: providerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stopping = false, settled = false; let handle: TunnelHandle | undefined;
  let failureReason: Error | undefined, closing: Promise<void> | undefined, cleaning: Promise<void> | undefined;
  const clean = () => cleaning ??= cleanup();
  let resolveClosed!: () => void; const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const close = () => closing ??= (async () => {
    stopping = true; child.kill('SIGTERM');
    const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 4000); force.unref();
    await closed; clearTimeout(force); await clean();
  })();
  return new Promise((resolve, reject) => {
    const abort = () => { void close().catch(() => {}); };
    const fail = (error: Error) => { if (stopping) return; failureReason = error; if (settled) options.exited(); abort(); };
    const timeout = setTimeout(() => fail(new Error(failure + '（启动超时）')), 60_000);
    const consume = () => {
      let pending = '';
      return (chunk: Buffer) => {
        pending = (pending + chunk.toString()).slice(-65_536);
        const lines = pending.split(/[\r\n]+/); pending = lines.pop() ?? '';
        for (const line of lines) {
          let value: string | undefined;
          try { value = parse(line); } catch (error) { fail(error instanceof Error ? error : new Error(failure)); return; }
          if (!value || stopping || options.signal.aborted) continue;
          if (!handle) { settled = true; clearTimeout(timeout); handle = { url: value, close }; resolve(handle); }
          else if (handle.url !== value) { handle.url = value; options.changed?.(value); }
        }
      };
    };
    child.stdout.on('data', consume()); child.stderr.on('data', consume());
    child.on('error', () => fail(new Error(failure + '（无法启动组件）')));
    child.on('close', () => {
      clearTimeout(timeout); options.signal.removeEventListener('abort', abort); resolveClosed();
      void clean().then(() => { if (!settled) reject(failureReason ?? new Error(options.signal.aborted ? '临时访问启动已取消' : failure)); else if (!stopping && !options.signal.aborted) options.exited(); }, () => { if (!settled) reject(new Error(failure + '（临时配置清理失败）')); });
    });
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
  });
}
