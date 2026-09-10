import { chromium, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const config = JSON.parse(await readFile(join(process.env.TURNWIRE_HOME ?? '/tmp/turnwire-preview-state', 'client.json'), 'utf8'));
const output = process.env.TURNWIRE_SCREENSHOTS ?? '/tmp/turnwire-screenshots';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await context.addInitScript(() => { try { localStorage.setItem('turnwire.locale', 'en'); } catch { /* the app still defaults to English */ } });
const page = await context.newPage(); const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(config.url);
  await expect(page.getByRole('heading', { name: 'Connect and keep working.' })).toBeVisible();
  await page.screenshot({ path: join(output, 'desktop-connection.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Local connection', exact: true }).click();
  await page.getByLabel('Host service URL', { exact: true }).fill(config.url);
  await page.getByLabel('Connection token', { exact: true }).fill(config.token);
  await page.getByRole('button', { name: 'Connect to host', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /New session/ }).first().click();
  await page.getByLabel('Session name').fill('验证 Turnwire 的多端接续');
  await page.getByLabel('Working directory').fill(process.cwd());
  await page.getByRole('button', { name: 'Create session', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '验证 Turnwire 的多端接续' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('验证消息与审批能否在 Mac 和手机之间同步。');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve once', exact: true })).toBeVisible();
  await expect(page.getByText("This is Turnwire's offline demo session.", { exact: false })).toBeVisible();
  // While the turn runs with nothing queued and nothing typed, the queue area is absent: there is
  // no message to jump the queue with, so a button sitting there disabled would be furniture.
  await expect(page.locator('.queue-area')).toHaveCount(0);
  await expect(page.locator('.queue-hint')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Jump the queue', exact: true })).toHaveCount(0);
  // Typing is what makes it appear, and it names the draft it would send rather than explaining itself.
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('把日志一起看下');
  await expect(page.locator('.queue-draft')).toHaveText('把日志一起看下');
  await expect(page.getByRole('button', { name: 'Jump the queue', exact: true })).toBeEnabled();
  await page.screenshot({ path: join(output, 'desktop-session.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: join(output, 'mobile-approval.png'), fullPage: true, animations: 'disabled' });
  const overflowing = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflowing).toBe(false);
  await page.getByRole('button', { name: 'Approve once', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve once', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open session list' }).click();
  await expect(page.getByRole('navigation', { name: 'Session list' })).toBeVisible();
  await page.getByRole('button', { name: 'Close list', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(output, 'mobile-session-small.png'), fullPage: true, animations: 'disabled' });
  await page.reload();
  await expect(page.getByRole('heading', { name: '验证 Turnwire 的多端接续' })).toBeVisible();
  await expect(page.getByText("This is Turnwire's offline demo session.", { exact: false })).toBeVisible();
  await page.locator('.session-actions summary').click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByLabel('New session name').fill('跨端会话管理验证');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('heading', { name: '跨端会话管理验证' })).toBeVisible();
  await page.getByRole('button', { name: 'Archive session', exact: true }).click();
  await expect(page.getByText('This session is archived; its history is still viewable.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeDisabled();
  await page.locator('.session-actions summary').click();
  await page.locator('.composer-area').getByRole('button', { name: 'Unarchive', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
  console.log('UI checks passed: connection, create, prompt, approval, responsive layout, persisted history.');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true, animations: 'disabled' });
  console.error(await page.locator('main').innerText());
  throw error;
} finally { await browser.close(); }
