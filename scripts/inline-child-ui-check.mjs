// Production PWA + actual core/SDK/relay; run after the product build with node --import tsx.
import { chromium, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { Store, TurnwireCore } from '../packages/core/src/index.ts';
import { DemoRuntime } from '../packages/runtime/src/index.ts';
import { encodePairing, randomSecret } from '../packages/sdk/src/index.ts';
import { startRelay } from '../apps/relay/src/server.ts';
import { RemoteBridge } from '../apps/daemon/src/remote.ts';

class Fixture extends DemoRuntime {
  targets = new Map();
  active = true;
  calls = [];
  subscribe(id, listener) { this.targets.set(id, listener); return super.subscribe(id, listener); }
  emit(id, event) { this.targets.get(id)(event); }
  async listSubagents() { return ['b', 'a'].map(id => ({ id, parentId: 'runtime-root', depth: 1, label: `Child ${id.toUpperCase()}`, mode: 'continuable', activity: this.active ? 'running' : 'inactive', todos: [] })); }
  async subagentHistory(sessionId, subagent) {
    this.calls.push({ sessionId, subagentId: subagent.id });
    return { subagent, cursor: 1, hasMore: false, nextBefore: null, records: [{ id: `answer-${subagent.id}`, role: 'assistant', text: `Execution belonging only to ${subagent.id}`, time: '2026-01-01', complete: true }] };
  }
}
const runtime = new Fixture();
const core = new TurnwireCore(new Store(':memory:'), [runtime], { id: crypto.randomUUID(), name: 'Inline child check' });
await core.start();
const reply = await core.handle({ v: 1, id: crypto.randomUUID(), method: 'session.create', params: { runtimeId: 'demo', title: 'Inline launches', cwd: process.cwd() } });
if (!reply.ok) throw new Error('Fixture session failed');
const session = reply.result;
const emit = event => runtime.emit(session.id, event);
const tool = (id, name, detail, output) => { emit({ type: 'tool.started', callId: id, tool: name, detail }); if (output !== undefined) emit({ type: 'tool.finished', callId: id, tool: name, detail: output }); };
emit({ type: 'message.completed', messageId: 'before', text: 'Before the launches' });
tool('read-before', 'read', 'before.txt', 'read before');
tool('launch-a', 'subagent', '{"description":"Child A"}', 'started subagent a');
tool('launch-b', 'subagent_fork', '{"description":"Child B","run_in_background":true}', 'started subagent b');
tool('read-after', 'read', 'after.txt', 'read after');
emit({ type: 'message.completed', messageId: 'after', text: 'After the launches' });
tool('pending', 'subagent', '{"description":"Pending child"}');
tool('unmatched', 'subagent', '{"description":"Unmatched child","run_in_background":false}', 'started subagent a');
emit({ type: 'status', status: 'running' });
const token = randomSecret();
const relay = await startRelay({ token, port: 0, webRoot: resolve('apps/remote-web/dist') });
const origin = `http://127.0.0.1:${relay.port}`;
const pairing = { v: 1, hostId: core.device.id, clientId: crypto.randomUUID(), name: 'Browser', relayUrl: origin.replace('http:', 'ws:') + '/relay', token: randomSecret(), key: randomSecret() };
core.store.addDevice(pairing);
const bridge = new RemoteBridge(core, pairing.relayUrl, token); bridge.start();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.addInitScript(() => localStorage.setItem('turnwire.locale', 'en'));
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(origin + '/#pair=' + encodePairing(pairing));
  const a = page.locator('.inline-child[data-subagent-id="a"]');
  const b = page.locator('.inline-child[data-subagent-id="b"]');
  await expect(page.locator('.inline-child')).toHaveCount(4);
  await expect(a).toContainText('Child A');
  await expect(b).toContainText('Child B');
  await expect(a).toContainText('Child running');
  await expect(page.locator('.agent-strip')).toBeVisible();
  // Assert DOM order, not merely presence in a separate footer or appended after all messages.
  expect(await page.locator('.conversation-inner').evaluate(root => [...root.children].filter(el => el.matches('.message,.tool-message,.inline-child')).map(el => el.classList.contains('inline-child') ? `child:${el.dataset.subagentId ?? 'unmatched'}` : el.classList.contains('message') ? el.textContent.includes('Before the launches') ? 'before' : 'after' : el.textContent.includes('before.txt') ? 'read-before' : 'read-after'))).toEqual(['before', 'read-before', 'child:a', 'child:b', 'read-after', 'after', 'child:unmatched', 'child:unmatched']);
  await expect(page.locator('.tool-group .inline-child')).toHaveCount(0);
  await expect(page.locator('.inline-child:not([data-subagent-id]) .tool-message')).toHaveCount(2);
  const unmatched = page.locator('.inline-child:not([data-subagent-id])').last();
  await unmatched.locator('summary').click();
  await expect(unmatched.locator('pre').last()).toHaveText('started subagent a');
  await a.getByRole('button', { name: /Details for Child A/ }).click();
  await b.getByRole('button', { name: /Details for Child B/ }).click();
  await expect(a).toContainText('Execution belonging only to a');
  await expect(b).toContainText('Execution belonging only to b');
  expect(runtime.calls).toEqual(expect.arrayContaining([{ sessionId: session.id, subagentId: 'a' }, { sessionId: session.id, subagentId: 'b' }]));
  runtime.active = false; emit({ type: 'status', status: 'idle' });
  await expect(page.locator('.agent-strip')).toHaveCount(0);
  await expect(a).toContainText('Child inactive');
  await expect(a.locator('.child-execution')).toBeVisible();
  await page.reload();
  await expect(page.locator('.agent-strip')).toHaveCount(0);
  await expect(a).toContainText('Child inactive');
  await expect(b).toContainText('Child B');
  await a.getByRole('button', { name: /Details for Child A/ }).click();
  await expect(a).toContainText('Execution belonging only to a');
  await b.getByRole('button', { name: /Details for Child B/ }).click();
  await expect(b).toContainText('Execution belonging only to b');
  expect(errors).toEqual([]);
  console.log('Production inline child scenario passed: actual launch positions, two identities, pending/unmatched raw tools, running footer, settled inline retention, reload expansion.');
} finally { await browser.close(); await bridge.close(); await relay.close(); await core.dispose(); }
