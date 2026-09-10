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
// The catalog is the runtime's and changes with it, so opening the picker has to ask for it again.
const catalogCalls = [];
// LocalClient uses POST /rpc (events use a separate WebSocket). Restrict interception to that
// transport; never parse unrelated requests or synthesize a successful model/catalog response.
const rpcUrl = new URL('/rpc', config.url).href;
const rpcBody = request => request.url() === rpcUrl && request.method() === 'POST' ? request.postDataJSON() : undefined;
page.on('request', request => { if (rpcBody(request)?.method === 'model.catalog') catalogCalls.push(Date.now()); });
const picker = page.getByRole('dialog', { name: 'Model', exact: true });
const modelButtons = picker.locator('.model-list').getByRole('button');
const modelButton = (provider, model) => modelButtons.and(picker.locator(`[data-provider=${JSON.stringify(provider)}][data-model=${JSON.stringify(model)}]`));
async function openPicker() {
  const responsePromise = page.waitForResponse(response => rpcBody(response.request())?.method === 'model.catalog');
  await page.getByLabel('Choose model', { exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const envelope = await response.json();
  expect(envelope.ok).toBe(true);
  await expect(picker).toBeVisible();
  return envelope.result;
}
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
  const composerBefore = await page.locator('.composer').boundingBox();
  // The list on screen was fetched when the session was selected; a route can gain or lose a model in
  // between, so the tap refreshes it rather than offering an id the host has already dropped.
  const catalogCallsBefore = catalogCalls.length;
  const catalog = await openPicker();
  await expect.poll(() => catalogCalls.length).toBeGreaterThan(catalogCallsBefore);
  await expect(picker).toBeVisible();
  await expect(picker).toBeInViewport();
  // The options belong to the chip, not to the composer: opening them must not move the input the
  // reader is about to type into, and the panel has to line up with the control that opened it.
  const composerAfter = await page.locator('.composer').boundingBox();
  expect(composerAfter.y).toBe(composerBefore.y);
  expect(composerAfter.height).toBe(composerBefore.height);
  // Geometry is not enough: a panel can sit exactly where it should and still be clipped by its own
  // composer, which is what happened while the composer card carried `overflow: hidden`. Each probe asks
  // what the reader would actually touch, inset from the rounded corners so the border radius is not
  // mistaken for occlusion. The drawer is waited out first: it slides away, and while it is on screen it
  // covers anything near the left edge.
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  const covered = await page.evaluate(() => {
    const panel = document.querySelector('.model-picker'); const list = panel?.querySelector('.model-list');
    if (!panel || !list) return ['the panel/list is not rendered'];
    const rect = panel.getBoundingClientRect(); const listRect = list.getBoundingClientRect();
    const points = [[rect.left + 14, rect.top + 14], [rect.right - 14, rect.top + 14], [rect.left + 14, rect.bottom - 14], [rect.right - 14, rect.bottom - 14], [listRect.left + listRect.width / 2, listRect.top + listRect.height / 2]];
    const name = (x, y) => { const at = document.elementFromPoint(x, y); return at ? `${at.tagName.toLowerCase()}.${String(at.className).split(' ')[0]}` : 'nothing'; };
    return points.filter(([x, y]) => { const at = document.elementFromPoint(x, y); return !at || !panel.contains(at); }).map(([x, y]) => `${name(x, y)} at ${Math.round(x)},${Math.round(y)}`);
  });
  expect(covered, `the model options are covered by ${covered.join(', ')}`).toEqual([]);
  const chipBox = await chip.boundingBox(); const panelBox = await page.locator('.model-picker').boundingBox();
  const gap = chipBox.y - (panelBox.y + panelBox.height);
  expect(gap, `the model panel is not next to its chip (gap ${Math.round(gap)}px)`).toBeGreaterThanOrEqual(-1);
  expect(gap).toBeLessThan(40);
  expect(Math.abs((panelBox.x + panelBox.width) - (chipBox.x + chipBox.width)), 'the model panel is not aligned with its chip').toBeLessThan(24);
  expect(Math.abs((panelBox.x + panelBox.width) - (chipBox.x + chipBox.width))).toBeLessThan(24);
  await page.setViewportSize({ width: 320, height: 480 });
  await expect.poll(() => picker.evaluate(panel => {
    const rect = panel.getBoundingClientRect();
    return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
  })).toBe(true);
  expect(await picker.locator('.model-list').evaluate(list => getComputedStyle(list).overflowY)).toBe('auto');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(picker).toBeInViewport();
  // Compare every provider/model tuple with the runtime response, including listed but unroutable
  // providers. No route, model or effort ID belongs in this scenario's source.
  const entries = catalog.groups.flatMap(group => group.models.map(model => ({ provider: group.id, group, model })));
  await expect(modelButtons).toHaveCount(entries.length);
  const values = await modelButtons.evaluateAll(buttons => buttons.map(button => JSON.stringify([button.dataset.provider, button.dataset.model])));
  expect(new Set(values).size).toBe(values.length);
  expect(values.sort()).toEqual(entries.map(entry => JSON.stringify([entry.provider, entry.model.id])).sort());
  for (const group of catalog.groups.filter(group => group.models.length)) {
    await expect(picker.locator('.model-list').getByRole('heading', { name: group.name, exact: true })).toBeVisible();
    for (const model of group.models) {
      if (!catalog.routableProviders.includes(group.id)) await expect(modelButton(group.id, model.id)).toBeDisabled();
    }
  }
  const current = modelButtons.and(picker.locator('[aria-pressed="true"]'));
  await expect(current).toHaveCount(1);
  const initialSelection = await current.evaluate(button => ({ provider: button.dataset.provider, model: button.dataset.model }));
  const routable = entries.filter(entry => catalog.routableProviders.includes(entry.provider));
  expect(routable.length, 'the runtime must advertise at least one routable model').toBeGreaterThan(0);
  const candidates = routable.filter(entry => entry.provider !== initialSelection.provider || entry.model.id !== initialSelection.model);
  const available = candidates.length ? candidates : routable;
  const target = available.find(entry => entry.model.reasoning?.efforts.length) ?? available[0];
  const targetButton = modelButton(target.provider, target.model.id);
  const search = picker.getByRole('searchbox', { name: 'Search models', exact: true });
  await expect(search).toBeFocused();
  await search.fill(target.model.id);
  await expect(targetButton).toBeVisible();
  const query = target.model.id.toLowerCase();
  const matches = entries.filter(entry => [entry.provider, entry.group.name, entry.model.id, entry.model.name].some(value => value.toLowerCase().includes(query)));
  await expect(modelButtons).toHaveCount(matches.length);
  // Generate a query absent from this catalog, rather than assuming a particular name is absent.
  let absent = 'no-matching-runtime-model';
  while (entries.some(entry => [entry.provider, entry.group.name, entry.model.id, entry.model.name].some(value => value.toLowerCase().includes(absent)))) absent += '-x';
  await search.fill(absent);
  await expect(modelButtons).toHaveCount(0);
  await expect(picker.getByRole('status')).toHaveText('No matching models');
  await search.fill('');
  await expect(modelButtons).toHaveCount(entries.length);
  await search.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(chip).toBeFocused();
  await openPicker();

  // Hold a real local-RPC attempt at the transport boundary. A second DOM click while disabled
  // must not emit another request. Reject without forwarding, so the host selection cannot change.
  let setModelCalls = 0;
  let releaseFailure;
  const failureGate = new Promise(resolve => { releaseFailure = resolve; });
  const failureRoute = async route => {
    const body = rpcBody(route.request());
    if (body?.method !== 'session.setModel') return route.continue();
    setModelCalls++;
    await failureGate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ v: 1, id: body.id, ok: false, error: { code: 'MODEL_UNAVAILABLE', message: 'Model selection rejected by UI scenario' } }) });
  };
  await page.route(rpcUrl, failureRoute);
  try {
    await search.fill(target.model.id);
    await search.press('Enter');
    await expect(search).toBeFocused();
    await expect(picker).toBeVisible();
    expect(setModelCalls).toBe(0);
    await search.fill('');
    await targetButton.click();
    await expect.poll(() => setModelCalls).toBe(1);
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('status')).toHaveText('Switching model…');
    for (const button of await modelButtons.all()) await expect(button).toBeDisabled();
    const pendingEffort = picker.getByLabel('Reasoning effort', { exact: true });
    if (await pendingEffort.count()) await expect(pendingEffort).toBeDisabled();
    await targetButton.evaluate(button => { button.click(); button.click(); });
    expect(setModelCalls).toBe(1);
    const beforeFailureRefresh = catalogCalls.length;
    releaseFailure();
    await expect(picker.getByRole('alert')).toBeVisible();
    await expect(picker).toBeVisible();
    await expect.poll(() => catalogCalls.length).toBeGreaterThan(beforeFailureRefresh);
    await expect(targetButton).toBeEnabled();
    await expect(modelButton(initialSelection.provider, initialSelection.model)).toHaveAttribute('aria-pressed', 'true');
    expect(setModelCalls).toBe(1);
  } finally {
    releaseFailure();
    await page.unroute(rpcUrl, failureRoute);
  }

  await search.fill(target.model.id);
  await search.press('ArrowDown');
  await expect(modelButtons.and(page.locator(':focus'))).toHaveCount(1);
  // A runtime may reuse model IDs across providers: walk the enabled matches to the chosen tuple.
  for (let index = 0; index < await modelButtons.count(); index++) {
    if (await targetButton.evaluate(button => button === document.activeElement)) break;
    await page.keyboard.press('ArrowDown');
  }
  await expect(targetButton).toBeFocused();
  const selectionResponse = page.waitForResponse(response => rpcBody(response.request())?.method === 'session.setModel');
  await page.keyboard.press('Enter');
  const selected = await (await selectionResponse).json();
  expect(selected.ok).toBe(true);
  expect(selected.result.model.provider).toBe(target.provider);
  expect(selected.result.model.model).toBe(target.model.id);
  await expect(picker).toHaveCount(0);
  await openPicker();
  await expect(targetButton).toHaveAttribute('aria-pressed', 'true');
  await expect(current).toHaveCount(1);

  // The host resolves the value; the runtime alone defines the effort options and default.
  const effort = picker.getByLabel('Reasoning effort', { exact: true });
  const efforts = target.model.reasoning?.efforts ?? [];
  let storedEffort = selected.result.model.reasoningEffort ?? '';
  if (efforts.length) {
    await expect(effort).toBeVisible();
    await expect(effort).toHaveValue(storedEffort);
    expect(await effort.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean))).toEqual(efforts.map(option => option.id));
    const alternative = efforts.find(option => option.id !== storedEffort);
    if (alternative) {
      const effortResponse = page.waitForResponse(response => rpcBody(response.request())?.method === 'session.setModel');
      await effort.selectOption(alternative.id);
      const updated = await (await effortResponse).json();
      expect(updated.ok).toBe(true);
      storedEffort = updated.result.model.reasoningEffort;
      expect(storedEffort).toBe(alternative.id);
      await expect(picker).toHaveCount(0);
      await openPicker();
      await expect(effort).toHaveValue(storedEffort);
    }
  } else {
    await expect(effort).toHaveCount(0);
    console.log('Runtime catalog has no reasoning efforts for the selected routable model; effort change not exercised.');
  }

  // The selection lives on the host, so a reload must not lose it.
  await page.reload();
  await expect(page.getByRole('heading', { name: '模型选择验证' })).toBeVisible();
  await expect(picker).toHaveCount(0);
  await openPicker();
  await expect(targetButton).toHaveAttribute('aria-pressed', 'true');
  if (efforts.length) await expect(effort).toHaveValue(storedEffort);
  else await expect(effort).toHaveCount(0);

  expect(errors).toEqual([]);
  console.log('UI model checks passed: phone geometry, runtime-grouped searchable list, checked current model, Escape focus restoration, pending duplicate lock, inline failure/retry, success closes, runtime effort options where available, selection survives reload.');
} catch (error) {
  console.error(await page.locator('main').innerText());
  throw error;
} finally { await browser.close(); }
