import { describe, expect, it } from 'vitest';
import type { ConversationMessage } from '@turnwire/sdk';
import type { SubagentView } from '@turnwire/protocol';
import { conversationRows, currentTurnChildren, isChildLaunch, launchChild } from '../apps/remote-web/src/inlineChildProjection';

const children: SubagentView[] = ['a', 'b'].map(id => ({ id, parentId: 'runtime-root', depth: 1, label: 'Same label', activity: 'running', mode: 'continuable', todos: [] }));
const launch = (patch: Partial<ConversationMessage> = {}): ConversationMessage => ({ id: 'launch', role: 'tool', tool: 'subagent', text: '', input: '{"description":"Same label"}', output: 'started subagent a', complete: true, time: '2026-01-01', ...patch });
describe('inline child correlation', () => {
  it('matches exact runtime identity in either launch tool, not catalog order or label', () => {
    expect(launchChild(launch(), [...children].reverse())?.id).toBe('a');
    expect(launchChild(launch({ tool: 'subagent_fork', output: 'started subagent b' }), children)?.id).toBe('b');
    expect(launchChild(launch(), [{ ...children[0]!, activity: 'inactive' }])?.id).toBe('a');
  });
  it.each([
    { output: 'started subagent missing' }, { output: 'prefix started subagent a' },
    { output: 'started subagent a\nchild says hello' }, { output: 'started background subagent job a' },
    { output: 'started subagent a\n' }, { output: undefined }, { complete: false }, { isError: true },
    { input: '{"run_in_background":false}' }, { input: '{"run_in_background":"true"}' },
    { input: undefined }, { input: 'null' }, { input: '[]' }, { input: 'invalid' },
    { tool: 'read' }, { role: 'assistant' as const },
  ])('leaves unsupported or untrusted receipts unmatched: %j', patch => {
    expect(launchChild(launch(patch), children)).toBeUndefined();
  });
  it('requires membership in the current direct-child catalog', () => {
    expect(launchChild(launch(), [])).toBeUndefined();
    expect(launchChild(launch(), [{ ...children[0]!, depth: 2 }])).toBeUndefined();
  });
  it('accepts explicit background true', () => {
    expect(launchChild(launch({ input: '{"run_in_background":true}' }), children)?.id).toBe('a');
  });
});

describe('current turn child scope', () => {
  const user = (id: string, patch: Partial<ConversationMessage> = {}) => launch({ id, role: 'user', ...patch });
  it('excludes historical children even while running, and includes current nested work', () => {
    const nested = { ...children[0]!, id: 'nested', parentId: 'b', depth: 2 };
    const messages = [user('old'), launch(), user('new'), launch({ id: 'new-launch', output: 'started subagent b' })];
    expect(currentTurnChildren(messages, [nested, ...children]).map(child => child.id)).toEqual(['nested', 'b']);
  });
  it('keeps current children through steering/queued messages but clears on a new turn', () => {
    const messages = [user('turn'), launch(), user('steer', { steer: true }), user('queued', { queued: true })];
    expect(currentTurnChildren(messages, children).map(child => child.id)).toEqual(['a']);
    expect(currentTurnChildren([...messages, user('next')], children)).toEqual([]);
  });
  it('fails closed when the turn boundary is not loaded or identity cannot be proven', () => {
    expect(currentTurnChildren([launch()], children)).toEqual([]);
    expect(currentTurnChildren([user('turn'), launch({ complete: false })], children)).toEqual([]);
  });
});

describe('conversation launch rows', () => {
  it('interrupts consecutive tool grouping for matched, pending, failed and unmatched launches', () => {
    const message = (id: string, role: ConversationMessage['role']) => launch({ id, role, tool: role === 'tool' ? 'read' : undefined });
    const messages = [message('before', 'assistant'), message('read-1', 'tool'), message('read-2', 'tool'), launch({ id: 'a' }), launch({ id: 'b', tool: 'subagent_fork', complete: false }), launch({ id: 'failed', isError: true }), message('read-3', 'tool'), message('read-4', 'tool'), message('after', 'assistant')];
    const rows = conversationRows(messages);
    expect(rows.map(row => row.key)).toEqual(['before', 'read-1', 'a', 'b', 'failed', 'read-3', 'after']);
    expect(rows.filter(row => row.launch).map(row => row.launch!.id)).toEqual(['a', 'b', 'failed']);
    expect(rows.filter(row => row.tools).map(row => row.tools!.length)).toEqual([2, 2]);
    expect(rows[0]!.lead).toBe(true);
    expect(rows.slice(1).every(row => !row.lead)).toBe(true);
    expect(messages.filter(isChildLaunch)).toHaveLength(3);
  });
});
