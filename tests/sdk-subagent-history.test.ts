import { expect, it, vi } from 'vitest';
import { loadSubagentHistoryPage, type TurnwireClient } from '../packages/sdk/src/index.js';
const subagent = { id: 'child', parentId: 'root', depth: 1, label: 'Child', mode: 'continuable', activity: 'inactive', todos: [] };
const page = { subagent, records: [{ id: 'r', role: 'assistant', text: 'snapshot', time: 'now', complete: false }], cursor: 4, nextBefore: 1, hasMore: true };
function client(result: unknown) { return { call: vi.fn().mockResolvedValue(result), subscribe: vi.fn(), close: vi.fn() } as unknown as TurnwireClient; }
it('passes cursor cuts intact and returns validated snapshot pages', async () => {
  const c = client(page); const args = { sessionId: 'root', subagentId: 'child', cursor: -1, before: 0, limit: 1 };
  expect(await loadSubagentHistoryPage(c, args)).toEqual(page);
  expect(c.call).toHaveBeenCalledWith('subagent.history', args);
});
it('rejects malformed pages, mismatched children and duplicate snapshot IDs', async () => {
  for (const invalid of [{ ...page, cursor: -2 }, { ...page, subagent: { ...subagent, id: 'other' } }, { ...page, records: [page.records[0], page.records[0]] }, { ...page, records: [{ ...page.records[0], complete: 'yes' }] }]) {
    await expect(loadSubagentHistoryPage(client(invalid), { sessionId: 'root', subagentId: 'child' })).rejects.toThrow();
  }
});
it('accepts the empty -1 cursor without fabricating a record', async () => {
  expect(await loadSubagentHistoryPage(client({ ...page, records: [], cursor: -1, nextBefore: null, hasMore: false }), { sessionId: 'root', subagentId: 'child' })).toMatchObject({ records: [], cursor: -1 });
});
