import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Verifies the phone PWA's model picker against a DSH-backed daemon. Requires a running
// daemon whose TURNWIRE_HOME holds client.json and whose runtime advertises modelSelection.
const config = JSON.parse(await readFile(join(process.env.TURNWIRE_HOME, 'client.json'), 'utf8'));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const page = await context.newPage(); const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(config.url);
  await page.getByRole('button', { name: '本机连接', exact: true }).click();
  await page.getByLabel('主机服务地址', { exact: true }).fill(config.url);
  await page.getByLabel('连接令牌', { exact: true }).fill(config.token);
  await page.getByRole('button', { name: '连接主机', exact: true }).click();
  await expect(page.getByText('已连接', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /新建会话/ }).first().click();
  await page.getByLabel('会话名称').fill('模型选择验证');
  await page.getByLabel('工作目录').fill(process.cwd());
  await page.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect(page.getByRole('heading', { name: '模型选择验证' })).toBeVisible();

  // The catalog needs no credential, so every registered model is listed before a selection exists.
  const picker = page.getByLabel('模型', { exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.locator('option')).toHaveCount(4);
  await expect(page.getByLabel('思考强度', { exact: true })).toHaveCount(0);

  await picker.selectOption('deepseek-official/deepseek-v4-pro');
  await expect(picker).toHaveValue('deepseek-official/deepseek-v4-pro');

  // The Host resolves defaults, so the effort picker appears with the model default rather
  // than the value that was sent.
  const effort = page.getByLabel('思考强度', { exact: true });
  await expect(effort).toBeVisible();
  await expect(effort).toHaveValue('high');
  await effort.selectOption('low');
  await expect(effort).toHaveValue('low');

  // The selection lives on the host, so a reload must not lose it.
  await page.reload();
  await expect(page.getByRole('heading', { name: '模型选择验证' })).toBeVisible();
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('deepseek-official/deepseek-v4-pro');
  await expect(page.getByLabel('思考强度', { exact: true })).toHaveValue('low');

  expect(errors).toEqual([]);
  console.log('UI model checks passed: catalog listed, selection applied, effort resolved by the Host, selection survives reload.');
} catch (error) {
  console.error(await page.locator('main').innerText());
  throw error;
} finally { await browser.close(); }
