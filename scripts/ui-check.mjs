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
  // The page's own mark, and the assistant's avatar, come from the brand asset; a missing file
  // would leave a broken image rather than fail anything else.
  await expect.poll(() => page.locator('.brand img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Connect and keep working.' })).toBeVisible();
  await page.screenshot({ path: join(output, 'desktop-connection.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Local connection', exact: true }).click();
  await page.getByLabel('Host service URL', { exact: true }).fill(config.url);
  await page.getByLabel('Connection token', { exact: true }).fill(config.token);
  await page.getByRole('button', { name: 'Connect to host', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /New session/ }).first().click();
  await page.getByLabel('Session name').fill('验证 Turnwire 的多端接续');
  // The working directory is chosen from the host rather than typed: the picker opens at the host's
  // home (or the folder the dialog already offered), walks up and back, and hands the folder it
  // landed on to the field. The path depends on the machine running this daemon, so the check
  // follows what the host reports instead of predicting it, and the field is what proves it arrived.
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
  const picker = page.locator('.folder-picker'); const shown = picker.locator('code');
  await expect(shown).toHaveText(/^\//);
  const opening = (await shown.textContent()) ?? '';
  await picker.getByRole('button', { name: 'Up', exact: true }).click();
  await expect(shown).not.toHaveText(opening);
  const parentPath = (await shown.textContent()) ?? '';
  await picker.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(shown).not.toHaveText(parentPath);
  const chosenFolder = (await shown.textContent()) ?? '';
  await picker.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByLabel('Working directory')).toHaveValue(chosenFolder);
  // Typing a path stays available for a folder the picker would take many taps to reach.
  await page.getByLabel('Working directory').fill(process.cwd());
  await page.getByRole('button', { name: 'Create session', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '验证 Turnwire 的多端接续' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('验证消息与审批能否在 Mac 和手机之间同步。');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve once', exact: true })).toBeVisible();
  await expect(page.getByText("This is Turnwire's offline demo session.", { exact: false }).first()).toBeVisible();
  // A queued prompt owns its own controls: edit, cancel and jump the queue live on that row and
  // nowhere else, so an empty queue has no queue controls at all. The message is deliberately long,
  // because a queued prompt may not grow the screen: the row truncates and the box caps itself.
  const queuedText = '需要批准这条日志：这是一条很长的排队消息，用来验证超出屏幕时后面的内容会被省略。'.repeat(4);
  await expect(page.locator('.queued-strip')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Jump the queue', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(queuedText);
  // Watch every insertion while it is sent: a queued prompt must never appear in the flow at all,
  // not even for the round trip it takes to learn where it belongs.
  await page.evaluate(text => {
    window.__leaked = false;
    const observer = new MutationObserver(() => { for (const node of document.querySelectorAll('.message.user')) if (node.textContent.includes(text)) window.__leaked = true; });
    observer.observe(document.body, { childList: true, subtree: true });
  }, queuedText);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const queuedRow = page.locator('.queued-item');
  await expect(queuedRow).toHaveCount(1);
  expect(await page.evaluate(() => window.__leaked), 'the queued prompt appeared in the transcript').toBe(false);
  await expect(queuedRow).toHaveCount(1);
  await expect(queuedRow.getByRole('button')).toHaveText(['Edit', 'Cancel', 'Jump the queue']);
  // A queued prompt waits above the composer; the flow behind it must not also show it, or the
  // reader sees it twice and reads it as already sent.
  await expect(page.locator('.message.user').filter({ hasText: '需要批准这条日志' })).toHaveCount(0);
  await expect(page.locator('.queued-text')).toHaveCount(1);
  // Too long means one ellipsised line, with the whole prompt still available to the pointer.
  const text = queuedRow.locator('.queued-text');
  await expect(text).toHaveCSS('text-overflow', 'ellipsis');
  await expect(text).toHaveAttribute('title', queuedText);
  expect(await text.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  // Typing does not grow a second set of controls: the row is the only place they exist.
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('另一条草稿');
  await expect(page.getByRole('button', { name: 'Jump the queue', exact: true })).toHaveCount(1);
  // Edit opens the row in place, and the same three slots stay in the same order.
  await queuedRow.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(queuedRow.getByRole('textbox', { name: 'Edit the queued message', exact: true })).toHaveValue(queuedText);
  await expect(queuedRow.getByRole('button')).toHaveText(['Save', 'Cancel', 'Jump the queue']);
  await queuedRow.getByRole('textbox', { name: 'Edit the queued message', exact: true }).press('Escape');
  await expect(queuedRow.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('');
  // A queue of many messages scrolls inside its own box instead of taking the screen: the bound is
  // measured on the live row duplicated in place, so it holds for a queue longer than this run can
  // produce without the demo answering every send.
  const bounded = await page.evaluate(() => {
    const strip = document.querySelector('.queued-strip');
    const row = strip.firstElementChild;
    for (let index = 0; index < 12; index++) strip.append(row.cloneNode(true));
    const measured = { rows: strip.children.length, height: strip.getBoundingClientRect().height, limit: innerHeight * 0.32, scrolls: strip.scrollHeight > strip.clientHeight + 1 };
    for (let index = 0; index < 12; index++) strip.lastElementChild.remove();
    return measured;
  });
  expect(bounded.rows).toBe(13);
  expect(bounded.height).toBeLessThanOrEqual(bounded.limit + 1);
  expect(bounded.scrolls).toBe(true);
  // A page that has just loaded has seen no events at all, so the queue has to come from the host.
  // This is the regression: the list used to be this tab's memory of what it watched arrive, so
  // re-entering the page silently dropped everything that was waiting.
  await page.reload();
  await expect(page.locator('.queued-item')).toHaveCount(1);
  await expect(page.locator('.queued-item .queued-text')).toHaveAttribute('title', queuedText);
  await expect(page.locator('.queued-item').getByRole('button')).toHaveText(['Edit', 'Cancel', 'Jump the queue']);
  await page.screenshot({ path: join(output, 'desktop-session.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: join(output, 'mobile-approval.png'), fullPage: true, animations: 'disabled' });
  const overflowing = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflowing).toBe(false);
  // Settling the turn drains the queue: the prompt that was waiting runs, and since its own text
  // asks for approval it raises one, which is then settled too. The row goes with the turn it
  // belonged to, and nothing about it survives as a stale control.
  await expect(page.locator('.approval-panel')).toHaveCount(1);
  await page.locator('.approval-panel').first().getByRole('button', { name: 'Approve once', exact: true }).click();
  await expect(page.locator('.queued-item')).toHaveCount(0);
  await expect(page.locator('.approval-panel')).toHaveCount(1);
  await page.locator('.approval-panel').first().getByRole('button', { name: 'Approve once', exact: true }).click();
  await expect(page.locator('.approval-panel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Jump the queue', exact: true })).toHaveCount(0);
  // Delegated approvals: the host grants them as they arrive, the session says so, and a prompt that
  // would otherwise wait for a person raises no panel. Taking it back makes the next one wait.
  await page.locator('.session-actions summary').click();
  // One stable control whose attribute says which way it will switch; clicking it by hit test is
  // unreliable exactly because its label swaps under the pointer, so the test dispatches the click.
  const delegate = page.locator('.session-actions [data-auto-approve]');
  await expect(delegate).toHaveAttribute('data-auto-approve', 'off');
  await expect(delegate).toHaveText('Approve for me');
  await expect(delegate).toBeEnabled();
  await delegate.dispatchEvent('click');
  await page.locator('.session-actions summary').click();
  await expect(page.locator('.auto-approve-chip')).toHaveText('Approving for you');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('第三条也需要审批');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText("This is Turnwire's offline demo session.", { exact: false }).last()).toBeVisible();
  await expect(page.locator('.approval-panel')).toHaveCount(0);
  await page.locator('.session-actions summary').click();
  await expect(delegate).toHaveAttribute('data-auto-approve', 'on');
  await expect(delegate).toHaveText('Ask me again');
  // The switch is a command to the host, so the next prompt may only be sent once the host has
  // confirmed the new state; the attribute is that confirmation, the chip is only what it looks like.
  await expect(delegate).toBeEnabled();
  await delegate.dispatchEvent('click');
  await expect(delegate).toHaveAttribute('data-auto-approve', 'off');
  await page.locator('.session-actions summary').click();
  await expect(page.locator('.auto-approve-chip')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('第四条需要审批');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.approval-panel')).toHaveCount(1);
  await page.locator('.approval-panel').first().getByRole('button', { name: 'Approve once', exact: true }).click();
  await expect(page.locator('.approval-panel')).toHaveCount(0);
  // A question the agent is blocked on: the panel carries the choices, the answer goes back as one
  // batch, and the panel goes away once the runtime has it.
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('askme: which database?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const question = page.locator('.question-panel');
  await expect(question).toHaveCount(1);
  await expect(question.locator('.question-text')).toHaveText('Which database should the demo use?');
  await expect(question.getByRole('button')).toHaveText(['SQLiteA single file', 'PostgresA server', 'Send answer']);
  await question.getByRole('button', { name: /SQLite/ }).click();
  await expect(question.getByRole('button', { name: /SQLite/ })).toHaveClass(/chosen/);
  await question.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(page.locator('.question-panel')).toHaveCount(0);
  // A turn of several steps reads as one speaker: the tool call is the assistant acting, so the
  // reply after it continues that run and carries no name, avatar or time of its own.
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('toolme: run something');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.tool-message').last()).toBeVisible();
  const followUp = page.locator('.message.assistant').last();
  await expect(followUp).toHaveClass(/follow/);
  await expect(followUp.locator('.message-author')).toHaveCount(0);
  // The next prompt opens a run of its own, so it carries its author again.
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('普通一条');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const nextUser = page.locator('.message.user').last();
  expect(await nextUser.getAttribute('class')).not.toContain('follow');
  await expect(nextUser.locator('.message-author')).toHaveCount(1);
  await page.getByRole('button', { name: 'Open session list' }).click();
  await expect(page.getByRole('navigation', { name: 'Session list' })).toBeVisible();
  await page.getByRole('button', { name: 'Close list', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(output, 'mobile-session-small.png'), fullPage: true, animations: 'disabled' });
  await page.reload();
  await expect(page.getByRole('heading', { name: '验证 Turnwire 的多端接续' })).toBeVisible();
  await expect(page.getByText("This is Turnwire's offline demo session.", { exact: false }).first()).toBeVisible();
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
  // The shell survives going offline, and it is the shell this run was using: every successful
  // navigation replaces the cached page, so the fallback cannot resurrect an older interface.
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker?.controller !== null)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  expect(await page.title()).toBe('Turnwire Remote');
  await expect(page.locator('#root')).not.toBeEmpty();
  await context.setOffline(false);
  expect(errors).toEqual([]);
  console.log('UI checks passed: connection, create, prompt, approval, responsive layout, persisted history.');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true, animations: 'disabled' });
  console.error(await page.locator('main').innerText());
  throw error;
} finally { await browser.close(); }
