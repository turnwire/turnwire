import { afterEach, expect, it, vi } from 'vitest';
import { LocalClient } from '@turnwire/sdk';
import type { SubagentHistoryPage, SubagentView } from '@turnwire/protocol';
import { createProgram } from '../apps/cli/src/program.js';
import { runTui } from '../apps/cli/src/terminal.js';

const child: SubagentView = { id: 'child-123', parentId: 'parent-123', depth: 1, label: 'Investigate', mode: 'continuable', activity: 'inactive', todos: [] };
const page: SubagentHistoryPage = {
  subagent: child, cursor: 8, hasMore: true, nextBefore: 4,
  records: [
    { id: '1', role: 'user', text: 'Find the issue', time: '2026-01-01', complete: true },
    { id: '2', role: 'assistant', text: 'Checking the test', time: '2026-01-01', complete: false },
    { id: '3', role: 'tool', tool: 'bash', text: 'Executed command', input: 'npm test', output: '1 failed', isError: true, time: '2026-01-01', complete: true },
    { id: '4', role: 'tool', tool: 'read', text: '', output: 'output without input', time: '2026-01-01', complete: true },
  ],
};
function setup(json = false) {
  const request = vi.spyOn(LocalClient.prototype, 'call').mockResolvedValue(page);
  const close = vi.spyOn(LocalClient.prototype, 'close').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const program = createProgram({ url: 'http://localhost:1', token: 'test', json, lang: 'en' });
  program.configureOutput({ writeErr: () => {} });
  return { request, close, log, program, run: (...args: string[]) => program.parseAsync(['agents', 'parent-123', ...args], { from: 'user' }) };
}
afterEach(() => vi.restoreAllMocks());

it('keeps JSON lists unchanged and includes addressable child IDs in text lists', async () => {
  const json = setup(true); json.request.mockResolvedValue({ subagents: [child] });
  await json.run();
  expect(JSON.parse(String(json.log.mock.calls[0]?.[0]))).toEqual([child]);
  vi.restoreAllMocks();
  const text = setup(); text.request.mockResolvedValue({ subagents: [child] });
  await text.run();
  expect(text.log.mock.calls.flat().join('\n')).toContain('Investigate [child-123]');
});

it('loads a JSON detail page through the SDK with all paging flags', async () => {
  const { run, request, log, close } = setup(true);
  await run('--detail', child.id, '--before', '9', '--cursor', '-1', '--limit', '5');
  expect(request).toHaveBeenCalledWith('subagent.history', { sessionId: 'parent-123', subagentId: child.id, before: 9, cursor: -1, limit: 5 });
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(page);
  expect(close).toHaveBeenCalledOnce();
});

it('renders real messages, tool inputs/results, errors and page cursors', async () => {
  const { run, log } = setup();
  await run('--detail', child.id);
  const output = log.mock.calls.flat().join('\n');
  for (const text of ['Find the issue', 'Checking the test', 'bash', 'npm test', '1 failed', 'output without input', 'cursor=8', 'nextBefore=4', '--before 4']) expect(output).toContain(text);
});

it('supports empty child histories with cursor -1', async () => {
  const { run, request, log } = setup();
  request.mockResolvedValue({ ...page, records: [], cursor: -1, hasMore: false, nextBefore: null });
  await run('--detail', child.id);
  expect(log.mock.calls.flat().join('\n')).toContain('cursor=-1 · nextBefore=null · hasMore=false');
});

it.each([
  ['--before', '-1'], ['--before', '1.5'], ['--before', 'abc'],
  ['--cursor', '-2'], ['--cursor', 'Infinity'], ['--cursor', '9007199254740992'],
  ['--limit', '0'], ['--limit', '101'], ['--limit', 'NaN'], ['--limit', ''],
])('rejects invalid numeric option %s %s before requesting', async (flag, value) => {
  const { run, request } = setup();
  await expect(run('--detail', child.id, flag, value)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});

it('rejects pagination without a child rather than ignoring it', async () => {
  const { run, request } = setup();
  await expect(run('--limit', '10')).rejects.toThrow('require --detail');
  expect(request).not.toHaveBeenCalled();
});

it('uses the same detail dispatcher from the TUI', async () => {
  const { log, request } = setup(true);
  const lines = ['agents parent-123 --detail child-123 --cursor -1 --limit 2', 'quit'];
  await runTui(args => createProgram({ url: 'http://localhost:1', token: 'test', json: true, lang: 'en' }).parseAsync(args, { from: 'user' }), '', { ask: async () => lines.shift(), write: () => {} });
  expect(request).toHaveBeenCalledWith('subagent.history', expect.objectContaining({ subagentId: child.id, cursor: -1, limit: 2 }));
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(page);
});
