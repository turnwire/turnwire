import { expect, it, vi } from 'vitest';
import { DshRuntime } from '@turnwire/runtime-dsh';
import type { RuntimeEvent } from '@turnwire/runtime';
function fixture() {
  const runtime = new DshRuntime({ url: 'http://127.0.0.1' });
  const control = runtime as unknown as { clientId: string; rpc: (endpoint: string, args: unknown) => Promise<unknown>; remoteEvent: (event: Record<string, unknown>) => Promise<void>; cancelPending: () => void };
  // Seed the Remote generation without opening a real socket. RPC completions are deterministic.
  const events: RuntimeEvent[] = []; runtime.subscribe('s', event => events.push(event)); control.clientId = 'generation';
  let resolve!: () => void; let reject!: (reason: Error) => void;
  const rpc = vi.fn(() => new Promise<void>((yes, no) => { resolve = yes; reject = no; })); control.rpc = rpc;
  return { runtime, control, events, rpc, resolve: () => resolve(), reject: () => reject(new Error('RPC timeout')), ask: () => control.remoteEvent({ type: 'waterfall', agentId: 's', eventId: 'q', event: 'user-questions/request', request: { questions: [{ id: 'item', question: 'Choose?' }] } }), cancel: () => control.remoteEvent({ type: 'cancel', eventId: 'q' }) };
}
const answers = [{ id: 'item', selected: ['yes'] }];
it('one answer claim owns RPC and cleanup cancellation does not publish a second terminal', async () => {
  const f = fixture(); await f.ask(); const answer = f.runtime.answerQuestion('s', 'q', answers);
  await expect(f.runtime.answerQuestion('s', 'q', answers)).rejects.toMatchObject({ code: 'QUESTION_EXPIRED' });
  await f.cancel(); f.resolve(); await answer;
  expect(f.rpc).toHaveBeenCalledTimes(1); expect(f.events.filter(event => event.type === 'question.resolved')).toEqual([]);
  await f.runtime.dispose();
});
it('rejected result plus cancellation produces exactly one cancelled terminal', async () => {
  const f = fixture(); await f.ask(); const answer = f.runtime.answerQuestion('s', 'q', answers); await f.cancel(); f.reject();
  await expect(answer).rejects.toThrow('RPC timeout');
  expect(f.events.filter(event => event.type === 'question.resolved')).toEqual([{ type: 'question.resolved', requestId: 'q', decision: 'cancelled' }]); await f.runtime.dispose();
});
it('disconnect cancellation wins over a late successful answer response', async () => {
  const f = fixture(); await f.ask(); const answer = f.runtime.answerQuestion('s', 'q', answers); f.control.cancelPending(); f.resolve();
  await expect(answer).rejects.toMatchObject({ code: 'QUESTION_EXPIRED' });
  expect(f.events.filter(event => event.type === 'question.resolved')).toHaveLength(1); await f.runtime.dispose();
});
it('a plain rejection leaves the live question available for one retry', async () => {
  const f = fixture(); await f.ask(); const answer = f.runtime.answerQuestion('s', 'q', answers); f.reject(); await expect(answer).rejects.toThrow('RPC timeout');
  const retry = f.runtime.answerQuestion('s', 'q', answers); f.resolve(); await retry; expect(f.rpc).toHaveBeenCalledTimes(2); await f.runtime.dispose();
});
