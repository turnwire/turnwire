export * from '../../packages/sdk/src/index';
const sessions = [
  { id: 'one', title: 'Selected conversation', status: 'idle', context: { contextWindow: 128000, pressureTokens: 41000, projectedTokens: 42000 } },
  { id: 'two', title: 'Other conversation', status: 'idle' },
  { id: 'running', title: 'Running conversation', status: 'running' },
  { id: 'approval', title: 'Approval conversation', status: 'waiting_approval' },
  { id: 'archived', title: 'Archived conversation', status: 'idle', archived: true },
].map(session => ({ runtimeId: 'fixture', cwd: '/workspace/project', createdAt: 1, updatedAt: 1, ...session }));
let connectionState: ((state: string) => void) | undefined;
const queues: Record<string, Array<{ messageId: string; target: 'next-turn' | 'next-step'; text: string }>> = {
  one: [{ messageId: 'idle-q', target: 'next-turn', text: 'Idle pending message' }],
  running: [{ messageId: 'later', target: 'next-turn', text: 'Ordinary queued message' }, { messageId: 'adjust', target: 'next-turn', text: 'Adjust current work' }],
};
export const fixture = { sessions, calls: [] as any[], completed: 0, delay: 0, fail: false, queueFail: false, queueFailures: 0, offline(value: boolean) { connectionState?.(value ? 'offline' : 'connected'); } };
Object.assign(window, { fixture });
export class LocalClient {
  async call(method: string, args: any) {
    fixture.calls.push({ method, ...args });
    if (method === 'system.snapshot') return { sessions: structuredClone(sessions), runtimes: [{ id: 'fixture', name: 'Fixture runtime', capabilities: {} }], device: { id: 'fixture', name: 'Fixture host' }, approvals: [], questions: [], cursor: 0 };
    if (method === 'session.rename' || method === 'session.archive') {
      const fail = fixture.fail;
      await new Promise(resolve => setTimeout(resolve, fixture.delay));
      fixture.completed++;
      if (fail) throw new Error('Fixture management failure');
      const session = sessions.find(item => item.id === args.sessionId)!;
      if (method === 'session.rename') session.title = args.title; else session.archived = args.archived;
      return { ...session };
    }
    if (method === 'session.queue') {
      if (fixture.queueFail) { fixture.queueFailures++; throw new Error('Queue read unavailable'); }
      return { items: structuredClone(queues[args.sessionId] ?? []) };
    }
    if (method === 'session.queueAction') {
      const queue = queues[args.sessionId] ?? [];
      const item = queue.find(item => item.messageId === args.messageId);
      if (!item) throw new Error('QUEUE_ITEM_GONE');
      if (args.action.kind === 'steer') {
        if (sessions.find(session => session.id === args.sessionId)?.status !== 'running' || item.target !== 'next-turn') throw new Error('session/steer-unavailable');
        item.target = 'next-step';
        queue.sort((a, b) => Number(b.target === 'next-step') - Number(a.target === 'next-step'));
      }
      if (args.action.kind === 'remove') queues[args.sessionId] = queue.filter(entry => entry !== item);
      if (args.action.kind === 'edit') item.text = args.action.text;
      return {};
    }
    if (method === 'subagent.list') return { subagents: [] };
    return {};
  }
  subscribe(_event: unknown, state: (state: string) => void) { connectionState = state; state('connected'); return () => {}; }
  close() {}
}
export async function loadHistoryPage() { return { events: [], nextBefore: null }; }
