// Run after building the PWA: node --import tsx scripts/markdown-ui-check.mjs
import { chromium, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Store, TurnwireCore } from '../packages/core/src/index.ts';
import { DemoRuntime } from '../packages/runtime/src/index.ts';
import { LocalClient, encodePairing, randomSecret } from '../packages/sdk/src/index.ts';
import { startDaemonServer } from '../apps/daemon/src/server.ts';
import { startRelay } from '../apps/relay/src/server.ts';
import { RemoteBridge } from '../apps/daemon/src/remote.ts';

class MarkdownFixtureRuntime extends DemoRuntime {
  listenersForFixture = new Map();
  subscribe(id, listener) { this.listenersForFixture.set(id, listener); const stop = super.subscribe(id, listener); return () => { this.listenersForFixture.delete(id); stop(); }; }
  sendFixture(id, event) { this.listenersForFixture.get(id)?.(event); }
}
const output = process.env.TURNWIRE_SCREENSHOTS ?? '/tmp/turnwire-markdown-check'; await mkdir(output, { recursive: true });
const markdown = await readFile(new URL('../tests/fixtures/remote-markdown.md', import.meta.url), 'utf8');
const runtime = new MarkdownFixtureRuntime();
const core = new TurnwireCore(new Store(':memory:'), [runtime], { id: crypto.randomUUID(), name: 'Markdown 验证 · 隔离 Demo' }); await core.start();
const token = randomSecret(), relayToken = randomSecret();
const server = await startDaemonServer({ core, token, port: 0 });
const local = new LocalClient(`http://127.0.0.1:${server.port}`, token);
const session = await local.request('session.create', { runtimeId: 'demo', title: '手机 Markdown 渲染', cwd: process.cwd() });
runtime.sendFixture(session.id, { type: 'message.user', messageId: crypto.randomUUID(), text: '请验证这段输出在手机上的排版。' });
runtime.sendFixture(session.id, { type: 'message.completed', messageId: crypto.randomUUID(), text: markdown });
const relay = await startRelay({ token: relayToken, port: 0, webRoot: resolve('apps/remote-web/dist') });
const origin = `http://127.0.0.1:${relay.port}`;
const pairing = { v: 1, hostId: core.device.id, clientId: crypto.randomUUID(), name: 'Test browser', relayUrl: origin.replace('http:', 'ws:') + '/relay', token: randomSecret(), key: randomSecret() };
core.store.addDevice(pairing);
const bridge = new RemoteBridge(core, pairing.relayUrl, relayToken); bridge.start();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await expect.poll(() => bridge.connected).toBe(true);
  await page.goto(origin + '/#pair=' + encodePairing(pairing));
  const md = page.locator('.message.assistant .markdown-body').first();
  await expect(md.getByRole('heading', { name: '远程控制检查', exact: true })).toBeVisible();
  await expect(page.locator('.connection-health')).toHaveAttribute('data-phase', 'connected');
  await expect(md.locator('strong')).toHaveText('Mac 的回应');
  await expect(md.locator('blockquote')).toContainText('Mac 需要保持唤醒并联网。');
  await expect(md.getByRole('checkbox')).toHaveCount(3);
  await expect(md.getByRole('checkbox').first()).toBeChecked();
  await expect(md.getByRole('checkbox').last()).not.toBeChecked();
  const code = md.locator('.markdown-code'); const table = md.locator('.markdown-table');
  await expect(code.locator('pre code')).toContainText('  provider: "localhost-run"');
  await expect(md.locator('td').last()).toHaveCSS('text-align', 'right');
  for (const width of [390, 375, 320, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.conversation').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await code.locator('pre').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    if (width < 700) expect(await table.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await md.getByRole('heading', { name: '远程控制检查', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'phone-markdown.png') });
  await code.scrollIntoViewIfNeeded();
  await code.getByRole('button', { name: '复制代码', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await code.locator('pre code').textContent());
  await expect(code.getByRole('button')).toHaveText('已复制');
  await page.screenshot({ path: join(output, 'phone-code.png') });
  await table.scrollIntoViewIfNeeded();
  await table.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  expect(await table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await page.screenshot({ path: join(output, 'phone-table.png') });
  const streamingId = crypto.randomUUID();
  const partial = '## 流式代码\n\n```ts\nconst value = {\n  enabled: true,';
  runtime.sendFixture(session.id, { type: 'status', status: 'running' });
  runtime.sendFixture(session.id, { type: 'message.delta', messageId: streamingId, text: partial });
  const streaming = page.locator('.message.assistant').last();
  await expect(streaming.locator('pre code')).toHaveText('const value = {\n  enabled: true,\n');
  await expect(streaming.locator('.cursor')).toBeVisible();
  const final = partial + '\n};\n```\n\n**完整输出**';
  runtime.sendFixture(session.id, { type: 'message.completed', messageId: streamingId, text: final });
  runtime.sendFixture(session.id, { type: 'status', status: 'idle' });
  await expect(streaming.locator('strong')).toHaveText('完整输出');
  await expect(streaming.locator('.cursor')).toHaveCount(0);
  await expect(streaming.locator('pre')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.message.assistant').last().locator('strong')).toHaveText('完整输出');
  const events = await local.request('events.list', { sessionId: session.id });
  expect(events.events.find(event => event.data.type === 'message.completed' && event.data.messageId === streamingId)?.data.text).toBe(final);
  expect(errors).toEqual([]);
  console.log('Markdown browser checks passed: encrypted replay, headings/lists/GFM, code copy, 320/375/390/1440 layout, independent scroll, streaming and refresh.');
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') }); throw error;
} finally { await browser.close(); local.close(); await bridge.close(); await relay.close(); await server.close(); await core.dispose(); }
