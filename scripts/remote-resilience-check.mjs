import { chromium, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { TurnwireCore, Store } from '../packages/core/src/index.ts';
import { DemoRuntime } from '../packages/runtime/src/index.ts';
import { LocalClient, randomSecret } from '../packages/sdk/src/index.ts';
import { startRelay } from '../apps/relay/src/server.ts';
import { startDaemonServer } from '../apps/daemon/src/server.ts';
import { RemoteController } from '../apps/daemon/src/remote-control.ts';
const directory = await mkdtemp(join(tmpdir(), 'turnwire-resilience-'));
const core = new TurnwireCore(new Store(join(directory, 'state.db')), [new DemoRuntime()], { id: 'resilience-host', name: '验证主机' });
const token = randomSecret();
const relay = await startRelay({ token, port: 0, webRoot: resolve('apps/remote-web/dist'), push: { path: join(directory, 'push.db'), subject: 'https://relay.example', deliver: async () => ({ statusCode: 201, headers: {}, body: '' }) } });
const origin = `http://127.0.0.1:${relay.port}`;
const remote = new RemoteController(core, { directory, webRoot: resolve('apps/remote-web/dist'), initialRelay: { relayUrl: origin.replace('http:', 'ws:') + '/relay', remoteUrl: origin, token } }); remote.start();
const server = await startDaemonServer({ core, token, port: 0, remoteAccess: remote });
const local = new LocalClient(`http://127.0.0.1:${server.port}`, token);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addInitScript(() => { try { localStorage.setItem('turnwire.locale', 'en'); } catch { /* the app still defaults to English */ } });
const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
const sockets = []; page.on('websocket', socket => sockets.push(socket));
const output = process.env.TURNWIRE_SCREENSHOTS ?? '/tmp/turnwire-resilience-screenshots'; await mkdir(output, { recursive: true });
try {
  const session = await local.request('session.create', { title: '远程连接验证', cwd: directory, runtimeId: 'demo' });
  await expect.poll(() => remote.status().state).toBe('online');
  const invitation = await local.pairDevice('测试手机'); await expect.poll(() => remote.status().state).toBe('online');
  await page.goto(invitation.url);
  await expect(page.locator('.connection-health')).toHaveAttribute('data-phase', 'connected');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  await expect.poll(() => local.devices().then(devices => devices[0]?.enrollment)).toBe('enrolled');
  expect(new URL(page.url()).hash).toBe('');
  await page.reload(); await expect(page.locator('.connection-health')).toHaveAttribute('data-phase', 'connected');
  await context.setOffline(true); await expect(page.locator('.connection-health')).toHaveAttribute('data-phase', 'offline');
  await local.request('session.message', { sessionId: session.id, text: 'approval' });
  await context.setOffline(false); await expect(page.locator('.connection-health')).toHaveAttribute('data-phase', 'connected');
  await page.getByRole('button', { name: 'Open session list' }).click(); await page.getByRole('button', { name: /Inbox/ }).click();
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve once', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable notifications and remember device', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: join(output, 'mobile-inbox.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Approve once', exact: true }).click();
  await expect.poll(() => core.store.approvals().filter(a => a.status === 'pending').length).toBe(0);
  await page.getByLabel('Include handled').check(); await expect(page.getByText('Approved', { exact: true })).toBeVisible();
  // Hiding the page pauses retries and keeps the verified socket: a tab switch must not flicker
  // the bar back to offline, and it must not open a second WebSocket to rebuild what it still holds.
  const socketsBeforeTabSwitch = sockets.length;
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(300);
  await expect(page.locator('.connection-health')).toHaveAttribute('data-phase', 'connected');
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(500);
  await expect(page.locator('.connection-health')).toHaveAttribute('data-phase', 'connected');
  expect(sockets.length).toBe(socketsBeforeTabSwitch);
  await page.getByRole('button', { name: 'Reconnect now', exact: true }).click(); await expect(page.locator('.connection-health')).toHaveAttribute('data-phase', 'connected');
  await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
  await page.getByLabel('Remember this trusted device').check(); await page.getByRole('button', { name: 'Connect to host', exact: true }).click();
  await expect(page.locator('.connection-health')).toHaveAttribute('data-phase', 'connected');
  // The Relay gives one device identity to its newest socket, so two tabs of the same pairing take
  // turns kicking each other off unless the one in the background stays put. A real browser reports
  // a background tab as hidden; Playwright reports every page as visible, so the first page is
  // hidden explicitly here rather than letting the check depend on which tab wins the race.
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(200);
  const second = await context.newPage(); await second.goto(origin); await expect(second.locator('.connection-health')).toHaveAttribute('data-phase', 'connected'); await second.close();
  expect(errors).toEqual([]);
  console.log('Remote browser checks passed: one-time pairing, reload, offline recovery, tab-switch socket reuse, inbox approval, persistent credentials, responsive layout.');
  console.log(`Screenshots: ${output}`);
} catch (error) { await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }); console.error(await page.locator('main').innerText()); throw error; }
finally { await browser.close(); local.close(); await remote.close(); await server.close(); await relay.close(); await core.dispose(); await rm(directory, { recursive: true, force: true }); }
