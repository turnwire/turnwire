// Isolated browser regression: complete records, scroll anchoring, live status and reload.
import { chromium, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { Store, TurnwireCore } from '../packages/core/src/index.ts';
import { DemoRuntime } from '../packages/runtime/src/index.ts';
import { encodePairing, randomSecret } from '../packages/sdk/src/index.ts';
import { startRelay } from '../apps/relay/src/server.ts';
import { RemoteBridge } from '../apps/daemon/src/remote.ts';
class Fixture extends DemoRuntime {
  targets = new Map();
  subscribe(id, listener) { this.targets.set(id, listener); return super.subscribe(id, listener); }
  emitFixture(id, event) { this.targets.get(id)(event); }
}
const runtime = new Fixture();
const core = new TurnwireCore(new Store(':memory:'), [runtime], { id: crypto.randomUUID(), name: 'History test Mac' }); await core.start();
const reply = await core.handle({ v: 1, id: crypto.randomUUID(), method: 'session.create', params: { runtimeId: 'demo', title: '按需加载验证', cwd: process.cwd() } });
if (!reply.ok) throw new Error('Fixture session failed'); const session = reply.result;
for (let i = 0; i < 90; i++) runtime.emitFixture(session.id, { type: 'message.user', messageId: `m-${i}`, text: `历史记录 ${i}` });
for (let i = 0; i < 4000; i++) runtime.emitFixture(session.id, { type: 'message.delta', messageId: 'answer', text: 'a' });
runtime.emitFixture(session.id, { type: 'message.completed', messageId: 'answer', text: '## 已完成的结果\n\n任务已经结束。' });
runtime.emitFixture(session.id, { type: 'tool.started', callId: 'question', tool: 'ask_user_question', detail: 'fixture input' });
runtime.emitFixture(session.id, { type: 'tool.finished', callId: 'question', tool: 'result', detail: 'fixture error', isError: true });
const token = randomSecret(); const relay = await startRelay({ token, port: 0, webRoot: resolve('apps/remote-web/dist') });
const origin = `http://127.0.0.1:${relay.port}`;
const pairing = { v: 1, hostId: core.device.id, clientId: crypto.randomUUID(), name: 'Browser', relayUrl: origin.replace('http:', 'ws:') + '/relay', token: randomSecret(), key: randomSecret() };
core.store.addDevice(pairing); const bridge = new RemoteBridge(core, pairing.relayUrl, token); bridge.start();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addInitScript(() => { try { localStorage.setItem('turnwire.locale', 'en'); } catch { /* the app still defaults to English */ } });
const page = await context.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
try {
  await expect.poll(() => bridge.connected).toBe(true);
  const start = Date.now(); await page.goto(origin + '/#pair=' + encodePairing(pairing));
  await expect(page.getByRole('heading', { name: '已完成的结果' })).toBeVisible();
  await expect(page.locator('.status')).toHaveText('Ready');
  await expect(page.locator('.message, .tool-message')).toHaveCount(40);
  await expect(page.locator('.tool-message summary')).toContainText('Failed');
  const initialMs = Date.now() - start;
  // Holding the conversation at its oldest record pulls the next page in without a click.
  await page.locator('.conversation').evaluate(el => { el.scrollTop = 0; });
  await expect(page.locator('.message, .tool-message')).toHaveCount(80);
  // The manual control stays available as the fallback while more records remain.
  await expect(page.getByRole('button', { name: 'Load earlier records', exact: true })).toHaveCount(1);
  // Adding older history preserves the reading position, rather than jumping to the newest message.
  const scroll = await page.locator('.conversation').evaluate(el => ({ top: el.scrollTop, remaining: el.scrollHeight - el.scrollTop - el.clientHeight }));
  expect(scroll.top).toBeGreaterThan(500); expect(scroll.remaining).toBeGreaterThan(500);
  runtime.emitFixture(session.id, { type: 'status', status: 'running' });
  runtime.emitFixture(session.id, { type: 'message.delta', messageId: 'live', text: 'Live after older page' });
  runtime.emitFixture(session.id, { type: 'message.completed', messageId: 'live', text: 'New task finished' });
  runtime.emitFixture(session.id, { type: 'status', status: 'idle' });
  await expect(page.locator('.message.assistant').last()).toContainText('New task finished');
  await expect(page.locator('.status')).toHaveText('Ready');
  await expect(page.locator('.cursor')).toHaveCount(0);
  await page.locator('.conversation').evaluate(el => { el.scrollTop = 0; });
  await expect(page.locator('.message, .tool-message')).toHaveCount(93);
  await expect(page.getByRole('button', { name: 'Load earlier records', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.message.assistant').last()).toContainText('New task finished');
  await expect(page.locator('.message, .tool-message')).toHaveCount(40);
  await expect(page.locator('.status')).toHaveText('Ready');
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ initialMs, recordsFirstPage: 40, totalRecords: 93, autoLoadOnTop: true, scrollAnchor: true, liveCompletion: true, refreshedLatest: true }));
} finally { await browser.close(); await bridge.close(); await relay.close(); await core.dispose(); }
