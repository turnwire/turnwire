import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Verifies the phone PWA's model picker against a DSH-backed daemon. Requires a running
// daemon whose TURNWIRE_HOME holds client.json and whose runtime advertises modelSelection.
const config = JSON.parse(await readFile(join(process.env.TURNWIRE_HOME, 'client.json'), 'utf8'));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
// Connect and create at a desktop width: the phone layout hides the session list, so the
// new-session button is off-screen until the list is opened.
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await context.addInitScript(() => { try { localStorage.setItem('turnwire.locale', 'en'); } catch { /* the app still defaults to English */ } });
const page = await context.newPage(); const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(config.url);
  await page.getByRole('button', { name: 'Local connection', exact: true }).click();
  await page.getByLabel('Host service URL', { exact: true }).fill(config.url);
  await page.getByLabel('Connection token', { exact: true }).fill(config.token);
  await page.getByRole('button', { name: 'Connect to host', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /New session/ }).first().click();
  await page.getByLabel('Session name').fill('模型选择验证');
  await page.getByLabel('Working directory').fill(process.cwd());
  await page.getByRole('button', { name: 'Create session', exact: true }).click();
  await expect(page.getByRole('heading', { name: '模型选择验证' })).toBeVisible();

  // The picker has to survive the phone layout, which is where it is actually used.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The page itself must not move: the document fits the viewport and the conversation is the only
  // scroller, so a thumb swipe cannot drag the topbar or the composer out from under the finger.
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.conversation')).overflowY)).toBe('auto');

  // The picker stays collapsed behind a chip so the composer keeps its height on a phone. The chip
  // itself has to be reachable without scrolling, and it must not live inside the conversation
  // scroller: toBeVisible only requires a non-empty box, while the conversation opens pinned to the
  // newest message, so a control inside that scroller would pass while sitting off-screen.
  const chip = page.getByLabel('Choose model', { exact: true });
  await expect(chip).toBeVisible();
  await expect(chip).toBeInViewport();
  expect(await chip.evaluate(element => element.closest('[aria-label="Conversation"]') === null)).toBe(true);
  await expect(page.getByLabel('Model', { exact: true })).toHaveCount(0);

  // The catalog needs no credential, so every registered model is listed before a selection exists.
  await chip.click();
  const picker = page.getByLabel('Model', { exact: true });
  await expect(picker).toBeVisible();
  await expect(picker).toBeInViewport();
  await expect(picker.locator('option')).toHaveCount(4);
  await expect(page.getByLabel('Reasoning effort', { exact: true })).toHaveCount(0);

  await picker.selectOption('deepseek-official/deepseek-v4-pro');
  await expect(picker).toHaveValue('deepseek-official/deepseek-v4-pro');

  // The Host resolves defaults, so the effort picker appears with the model default rather
  // than the value that was sent.
  const effort = page.getByLabel('Reasoning effort', { exact: true });
  await expect(effort).toBeVisible();
  await expect(effort).toHaveValue('high');
  await effort.selectOption('low');
  await expect(effort).toHaveValue('low');

  // The selection lives on the host, so a reload must not lose it.
  await page.reload();
  await expect(page.getByRole('heading', { name: '模型选择验证' })).toBeVisible();
  // Collapsed again after a reload, so reopen the picker before reading back the stored values.
  await expect(page.getByLabel('Model', { exact: true })).toHaveCount(0);
  await page.getByLabel('Choose model', { exact: true }).click();
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('deepseek-official/deepseek-v4-pro');
  await expect(page.getByLabel('Reasoning effort', { exact: true })).toHaveValue('low');

  expect(errors).toEqual([]);
  console.log('UI model checks passed: chip reachable on a phone, catalog listed, selection applied, effort resolved by the Host, selection survives reload.');
} catch (error) {
  console.error(await page.locator('main').innerText());
  throw error;
} finally { await browser.close(); }
