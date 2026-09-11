import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentStrip } from '../../apps/remote-web/src/AgentStrip';
import '../../apps/remote-web/src/style.css';
const fixture = { calls: [] as any[], fail: false, version: 1, empty: false, delay: 0 };
Object.assign(window, { fixture });
const child = { id: 'child', parentId: 'root', depth: 1, label: 'Fixture child', mode: 'continuable' as const, activity: 'running' as const, todos: [{ content: 'Secondary plan', status: 'pending' as const }] };
const client = {
  async request(method: string, args: any) {
    fixture.calls.push({ method, ...args });
    await new Promise(resolve => setTimeout(resolve, fixture.delay));
    if (fixture.fail) throw new Error('Fixture history failure');
    return { subagent: child, cursor: args.cursor ?? 60, hasMore: args.before === undefined, nextBefore: args.before === undefined ? 11 : null,
      records: fixture.empty ? [] : args.before !== undefined ? [{ id: 'old', role: 'user', text: 'Older execution request', time: '2026-01-01', complete: true }] : [
        { id: 'answer', role: 'assistant', text: `Execution snapshot ${fixture.version}\n${'Long body\n'.repeat(40)}`, time: '2026-01-01', complete: false },
        { id: 'tool', role: 'tool', text: 'Read files', tool: 'read', input: '/workspace/example.ts', output: 'actual tool output', time: '2026-01-01', complete: true },
      ] };
  }, subscribe() { return () => {}; }, close() {},
};
function Fixture() {
  const [running, setRunning] = useState(true); const [connected, setConnected] = useState(true);
  return <main style={{ width: 390, padding: 12 }}><button onClick={() => setRunning(false)}>Settle child</button><button onClick={() => setRunning(true)}>Run child</button><button onClick={() => setConnected(value => !value)}>Toggle connection</button><AgentStrip sessionId="root" client={client as any} connected={connected} agents={[{ ...child, activity: running ? 'running' : 'inactive' }]} /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
