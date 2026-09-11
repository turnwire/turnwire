// Isolated browser regression: the question card and the background-agent strip on a phone.
//
// Both surfaces were reported twice for the same class of defect — a box that grows wider than the
// screen it lives in. The card is measured for sideways overflow with the worst content a host can
// hand it (an unbreakable path as an option, an unbreakable URL as a typed answer), the option rows
// are measured for a shared left edge, and opening a child is measured for a plan that lines up.
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
  answerGate;
  listFailures = 0;
  listCalls = 0;
  extraAgents = false;
  emptySession;
  listGate;
  async answerQuestion() { await this.answerGate; /* the core records the answer itself */ }
  historyVersion = 1;
  historyFailure = false;
  async subagentHistory(_sessionId, subagent, options) {
    if (this.historyFailure) throw new Error('Fixture child execution unavailable');
    return { subagent, cursor: options.cursor ?? 60, hasMore: options.before === undefined, nextBefore: options.before === undefined ? 10 : null, records: options.before === undefined ? [
      { id: 'child-message', role: 'assistant', text: `Real child execution snapshot ${this.historyVersion}`, time: new Date().toISOString(), complete: true },
      { id: 'child-tool', role: 'tool', tool: 'read', text: 'Read source', input: 'apps/remote-web/src/style.css', output: 'Child tool result body', time: new Date().toISOString(), complete: true },
    ] : [{ id: 'child-old', role: 'user', text: 'Older child request', time: new Date().toISOString(), complete: true }] };
  }
  async listSubagents(sessionId) {
    this.listCalls += 1;
    if (sessionId === this.emptySession) { await this.listGate; return []; }
    if (this.listFailures > 0) { this.listFailures -= 1; throw new Error('Transient fixture list failure'); }
    return [
      { id: 'agent-1', parentId: 'root', depth: 1, label: 'Review the queue strip for sideways panning', mode: 'continuable', activity: 'running', elapsedMs: 83000,
        todos: [
          { content: 'Read apps/remote-web/src/style.css and measure the strip', status: 'completed' },
          { content: 'Measure every box that can grow past the viewport on a 390 px phone', status: 'in_progress' },
          { content: 'Report /Users/someone/Library/Application Support/turnwire/a/very/long/path/that/never/breaks/config.yaml', status: 'pending' },
        ] },
      { id: 'agent-2', parentId: 'agent-1', depth: 2, label: 'Nested child', mode: 'one-shot', activity: 'running', elapsedMs: 4000, todos: [] },
      ...(this.extraAgents ? Array.from({ length: 30 }, (_, index) => ({ id: `extra-${index}`, parentId: 'root', depth: 1, label: `Extra child ${index}`, mode: 'continuable', activity: 'running', todos: [] })) : []),
    ];
  }
}

const LONG_PATH = '/Users/someone/Library/Application Support/turnwire/very/deep/nested/directory/that/never/breaks/anywhere/config.yaml';
const runtime = new Fixture();
const core = new TurnwireCore(new Store(':memory:'), [runtime], { id: crypto.randomUUID(), name: 'Question check host' }); await core.start();
const reply = await core.handle({ v: 1, id: crypto.randomUUID(), method: 'session.create', params: { runtimeId: 'demo', title: 'Question check', cwd: process.cwd() } });
if (!reply.ok) throw new Error('Fixture session failed');
const session = reply.result;
core.publish({ type: 'message.user', sessionId: session.id, messageId: 'fixture-turn', text: 'Review this turn' });
for (const id of ['agent-1', ...Array.from({ length: 30 }, (_, index) => `extra-${index}`)]) {
  runtime.emitFixture(session.id, { type: 'tool.started', callId: `launch-${id}`, tool: 'subagent', detail: '{}' });
  runtime.emitFixture(session.id, { type: 'tool.finished', callId: `launch-${id}`, tool: 'subagent', detail: `started subagent ${id}` });
}
runtime.emitFixture(session.id, { type: 'status', status: 'waiting_approval' });
runtime.emitFixture(session.id, {
  type: 'question.requested', requestId: 'r-1',
  questions: [
    { id: 'q-1a', header: 'Deployment', question: 'Which environment should this release go to first?', detail: 'The staging host has been idle since yesterday.',
      options: [
        { label: 'Staging', description: 'Safe, and the smoke tests already run there' },
        { label: 'Production, but only after the smoke tests pass on staging and somebody has watched the dashboards for ten minutes', description: 'Faster, and it is what the release checklist asks for when staging is green' },
        { label: LONG_PATH },
      ] },
    { id: 'q-1b', header: 'Notes', question: 'Anything the release notes should say about this change?' },
    { id: 'q-1c', header: 'Channels', question: 'Which channels should receive the announcement?', multiSelect: true,
      options: [{ label: 'Email' }, { label: 'In-app banner, plus the status page and the changelog entry' }, { label: 'Nothing' }] },
  ],
});
// A question that was already settled, answered with free text: the record has to show what was
// typed, however long and however unbreakable it is.
runtime.emitFixture(session.id, {
  type: 'question.requested', requestId: 'r-2',
  questions: [{ id: 'q-2a', header: 'Notes', question: 'Anything the release notes should say about this change?' }],
});
const answered = await core.handle({ v: 1, id: crypto.randomUUID(), method: 'question.answer', params: {
  questionId: `${session.id}:r-2`,
  // A token with no break opportunity anywhere in it: a URL breaks at its slashes, a key or a hash
  // does not, and that is the shape that ran off the card on a 320 px phone.
  answers: [{ id: 'q-2a', selected: [], custom: 'Shipped using sk-live-9f3c41d7b28e45a6901c7fbe2d5a83471ce9b0f6a2d43e8791cb5f0e6a3d7281 and nothing else broke.' }],
} });
if (!answered.ok) throw new Error('Answering the fixture question failed: ' + JSON.stringify(answered));

const token = randomSecret(); const relay = await startRelay({ token, port: 0, webRoot: resolve('apps/remote-web/dist') });
const origin = `http://127.0.0.1:${relay.port}`;
const pairing = { v: 1, hostId: core.device.id, clientId: crypto.randomUUID(), name: 'Browser', relayUrl: origin.replace('http:', 'ws:') + '/relay', token: randomSecret(), key: randomSecret() };
core.store.addDevice(pairing); let bridge = new RemoteBridge(core, pairing.relayUrl, token); bridge.start();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addInitScript(() => { try { localStorage.setItem('turnwire.locale', 'en'); } catch { /* the app still defaults to English */ } });
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(origin + '/#pair=' + encodePairing(pairing));
  await expect(page.locator('.question-card')).toHaveCount(2);
  await expect(page.locator('.agent-strip')).toBeVisible();

  const measureCard = () => page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }; };
    const cards = [...document.querySelectorAll('.question-card')];
    const options = [...document.querySelectorAll('.question-options button')].map(button => {
      const range = document.createRange(); range.selectNodeContents(button);
      return { edge: Math.round(button.getBoundingClientRect().left), content: Math.round(range.getBoundingClientRect().left), width: Math.round(button.getBoundingClientRect().width), right: Math.round(button.getBoundingClientRect().right) };
    });
    const given = [...document.querySelectorAll('.question-given')].map(el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    const overflow = cards.flatMap((each, index) => {
      const bounds = each.getBoundingClientRect();
      return [...each.querySelectorAll('*')]
        .filter(el => el.getBoundingClientRect().right > bounds.right + 0.5 || el.getBoundingClientRect().left < bounds.left - 0.5)
        .map(el => `card${index} ${el.tagName}.${el.className} ${JSON.stringify(box(el))}`);
    });
    return { cards: cards.map(each => ({ width: Math.round(each.getBoundingClientRect().width), scrollWidth: each.scrollWidth })), options, given, overflow, document: document.documentElement.scrollWidth, viewport: window.innerWidth };
  });
  /**
   * The narrow widths are the point: a long unbreakable answer fitted at 390 px and ran off the card
   * at 320 px, which is why both are measured rather than the comfortable one.
   */
  const assertCard = (card) => {
    // An option that cannot wrap must not widen the card: this is what made the whole card pannable.
    expect(card.overflow, `a question card overflows its own box at ${card.viewport}px`).toEqual([]);
    for (const each of card.cards) expect(each.scrollWidth, `a question card can be panned sideways at ${card.viewport}px`).toBeLessThanOrEqual(each.width + 2);
    expect(card.document, `the page itself scrolls sideways at ${card.viewport}px`).toBeLessThanOrEqual(card.viewport);
    // Every option starts at the same left edge and spans the same width, so the rows read as a column
    // rather than as centred labels of different lengths.
    expect(new Set(card.options.map(option => option.content)).size, 'option labels do not share a left edge').toBe(1);
    expect(new Set(card.options.map(option => option.width)).size, 'option rows differ in width').toBe(1);
    for (const option of card.options) expect(option.content).toBeGreaterThan(option.edge);
    // The answer someone typed is shown in full, wrapped, instead of running off the card.
    for (const record of card.given) expect(record.scrollWidth, `a recorded answer overflows its line at ${card.viewport}px`).toBeLessThanOrEqual(record.clientWidth + 1);
  };

  const wide = await measureCard();
  assertCard(wide);
  await page.setViewportSize({ width: 320, height: 844 });
  const narrow = await measureCard();
  assertCard(narrow);
  await page.setViewportSize({ width: 390, height: 844 });

  // Someone who types an answer rather than tapping an option needs something to press: a phone
  // keyboard offers no Enter, and a single-choice question that has options used to hide the button.
  const pendingCard = page.locator('.question-card[data-status="pending"]');
  const items = pendingCard.locator('.question-item');
  await expect(items).toHaveCount(3);
  const submit = pendingCard.locator('.question-actions button');
  await expect(submit).toHaveCount(1);
  await expect(pendingCard.locator('.question-other-row button')).toHaveCount(0);
  await expect(submit).toBeDisabled();
  const typed = items.first().locator('input.question-other');
  await typed.fill('Staging tonight, then production tomorrow');
  await expect(submit).toBeDisabled();
  await typed.press('Enter');
  await expect(pendingCard).toHaveCount(1); // unanswered siblings must never be finalized
  const staging = items.first().getByRole('button', { name: /^Staging/ });
  await staging.click();
  await expect(staging).toHaveAttribute('aria-pressed', 'true');
  await expect(submit).toBeDisabled();
  await items.nth(1).locator('input').fill('   ');
  const email = items.nth(2).getByRole('button', { name: 'Email', exact: true });
  await email.click();
  await expect(email).toHaveAttribute('aria-pressed', 'true');
  await expect(submit).toBeDisabled();
  await items.nth(1).locator('input').fill('Explain the release');
  await expect(submit).toBeEnabled();
  await bridge.close();
  await expect(typed).toBeDisabled();
  await expect(items.locator('input')).toHaveCount(3);
  await expect(staging).toHaveAttribute('aria-pressed', 'true');
  await expect(typed).toHaveValue('Staging tonight, then production tomorrow');
  bridge = new RemoteBridge(core, pairing.relayUrl, token); bridge.start();
  await expect(submit).toBeEnabled({ timeout: 20000 });
  await typed.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await typed.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
  await expect(pendingCard).toHaveCount(1);
  let finishAnswer;
  runtime.answerGate = new Promise(resolve => { finishAnswer = resolve; });
  await typed.press('Enter');
  await expect(submit).toBeDisabled();
  await expect(items.locator('input')).toHaveCount(3);
  await expect(typed).toBeDisabled();
  await expect(typed).toHaveValue('Staging tonight, then production tomorrow');
  await expect(staging).toBeDisabled();
  await expect(staging).toHaveAttribute('aria-pressed', 'true');
  finishAnswer();
  await expect(pendingCard).toHaveCount(0);
  await expect(page.locator('.question-given').filter({ hasText: 'Staging tonight' })).toHaveCount(1);
  await expect(page.locator('.question-given').filter({ hasText: 'No answer' })).toHaveCount(0);

  // Single-choice and multi-choice cards use the same explicit submit, with no duplicate action.
  for (const multiSelect of [false, true]) {
    runtime.emitFixture(session.id, { type: 'question.requested', requestId: `single-${multiSelect}`, questions: [{ id: 'single', question: 'Choose a channel', multiSelect, options: [{ label: 'One' }, { label: 'Two' }] }] });
    await expect(pendingCard).toHaveCount(1);
    await expect(pendingCard.locator('.question-actions button')).toHaveCount(1);
    await pendingCard.getByRole('button', { name: 'One', exact: true }).click();
    await expect(pendingCard).toHaveCount(1);
    await pendingCard.getByRole('button', { name: 'Two', exact: true }).click();
    await expect(pendingCard.getByRole('button', { name: 'One', exact: true })).toHaveAttribute('aria-pressed', String(multiSelect));
    await pendingCard.locator('.question-actions button').click();
    await expect(pendingCard).toHaveCount(0);
  }

  // Opening a child shows its own plan, with the status column aligned down the list.
  const row = page.locator('.agent-item').first();
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(row).toHaveAccessibleName(/Review the queue strip/);
  await expect(page.locator('.agent-detail')).toHaveCount(0);
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-record-id="child-message"]')).toContainText('Real child execution snapshot 1');
  await page.locator('[data-record-id="child-tool"] summary').click();
  await expect(page.getByText('Child tool result body', { exact: true })).toBeVisible();
  runtime.historyVersion = 2;
  await expect(page.locator('[data-record-id="child-message"]')).toContainText('Real child execution snapshot 2');
  await page.getByRole('button', { name: 'Older page', exact: true }).click();
  await expect(page.getByText('Older child request', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Return to latest (reset)', exact: true }).click();
  await expect(page.locator('[data-record-id="child-message"]')).toContainText('Real child execution snapshot 2');
  runtime.historyFailure = true;
  await page.getByRole('button', { name: 'Refresh latest', exact: true }).click();
  await expect(page.locator('.child-execution [role="alert"]')).toContainText('Stale execution');
  runtime.historyFailure = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.child-execution [role="alert"]')).toHaveCount(0);
  await page.locator('.agent-secondary-plan>summary').click();
  const plan = page.locator('.agent-plan>li');
  await expect(plan).toHaveCount(3);
  await expect(plan.nth(0)).toHaveAttribute('data-status', 'completed');
  await expect(plan.nth(1)).toHaveAttribute('data-status', 'in_progress');
  await expect(page.locator('.agent-meta')).toContainText('Can continue');
  const columns = await page.evaluate(() => {
    const strip = document.querySelector('.agent-strip'); const bounds = strip.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.agent-plan>li')].map(li => [...li.children].map(child => child.getBoundingClientRect().left));
    const overflow = [...strip.querySelectorAll('*')]
      .filter(el => el.getBoundingClientRect().right > bounds.right + 0.5 || el.getBoundingClientRect().left < bounds.left - 0.5)
      .map(el => `${el.tagName}.${el.className}`);
    return { rows, overflow, stripScrollWidth: strip.scrollWidth, stripWidth: Math.round(bounds.width), expandedRows: document.querySelectorAll('.agent-detail').length };
  });
  expect(columns.overflow, 'agent details overflow the strip').toEqual([]);
  expect(columns.stripScrollWidth).toBeLessThanOrEqual(columns.stripWidth + 2);
  // Three columns, one left edge each, identical on every row of the plan.
  const first = columns.rows[0];
  expect(first).toHaveLength(3);
  for (const line of columns.rows) expect(line.map(Math.round)).toEqual(first.map(Math.round));
  // The second child has no plan of its own; opening it says so instead of showing an empty table.
  await row.click();
  await expect(page.locator('.agent-detail')).toHaveCount(0);
  const nested = page.locator('.agent-item').nth(1);
  await nested.click();
  await page.locator('.agent-secondary-plan>summary').click();
  await expect(page.locator('.agent-noplan')).toBeVisible();
  await expect(page.locator('.agent-detail')).toHaveCount(1);
  // A list failure while the parent is idle must retain children and continue retrying.
  runtime.emitFixture(session.id, { type: 'status', status: 'idle' });
  runtime.listFailures = 2;
  const calls = runtime.listCalls;
  await expect.poll(() => runtime.listCalls, { timeout: 15000 }).toBeGreaterThanOrEqual(calls + 2);
  await expect(page.locator('.agent-item')).toHaveCount(2);
  runtime.extraAgents = true;
  await expect(page.locator('.agent-more')).toBeVisible({ timeout: 15000 });
  await page.locator('.agent-more').click();
  await expect(page.locator('.agent-item')).toHaveCount(32);
  for (let index = 0; index < 12; index += 1) runtime.emitFixture(session.id, { type: 'approval.requested', requestId: `approval-${index}`, tool: 'shell', reason: `Approval ${index}` });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 640 });
    await expect(page.locator('.approval-panel')).toHaveCount(12);
    const bounds = await page.locator('.composer').boundingBox();
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(640);
    expect(await page.locator('.agent-list').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const toolbar = page.locator('.composer-bottom');
    const before = await toolbar.locator(':scope > div').boundingBox();
    await toolbar.locator('.composer-path bdi').evaluate(el => { el.textContent = '/workspace/' + 'very-long-directory-'.repeat(50) + '/leaf'; });
    await expect(toolbar.locator('.composer-path > span')).toHaveCSS('direction', 'rtl');
    await expect(toolbar.locator('.composer-path bdi')).toHaveCSS('direction', 'ltr');
    const leafVisible = await toolbar.locator('.composer-path > span').evaluate(el => {
      const text = el.querySelector('bdi').firstChild;
      const range = document.createRange(); range.setStart(text, text.textContent.length - 4); range.setEnd(text, text.textContent.length);
      const leaf = range.getBoundingClientRect(); const box = el.getBoundingClientRect();
      return leaf.left >= box.left && leaf.right <= box.right + 1;
    });
    expect(leafVisible).toBe(true);
    const after = await toolbar.locator(':scope > div').boundingBox();
    expect(after.width).toBeCloseTo(before.width, 1);
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(await toolbar.locator('.composer-path > span').evaluate(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis')).toBe(true);
    expect(await toolbar.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  for (const [width, height] of [[320, 320], [360, 400], [390, 400], [430, 320], [640, 320], [844, 390]]) {
    await page.setViewportSize({ width, height });
    const footer = page.locator('.composer-area');
    const bounds = await footer.boundingBox();
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height + 1);
    expect((await page.locator('.conversation').boundingBox()).height).toBeGreaterThanOrEqual(48);
    await page.locator('.send-button').scrollIntoViewIfNeeded();
    const send = await page.locator('.send-button').boundingBox();
    expect(send.y + send.height).toBeLessThanOrEqual(height);
    await page.locator('.approval-panel').first().scrollIntoViewIfNeeded();
    await expect(page.locator('.approval-panel').first()).toBeInViewport();
  }
  await page.setViewportSize({ width: 390, height: 640 });
  // Delay the new session's list: old children must disappear before that request resolves.
  const second = await core.handle({ v: 1, id: crypto.randomUUID(), method: 'session.create', params: { runtimeId: 'demo', title: 'Empty session', cwd: process.cwd() } });
  if (!second.ok) throw new Error('Second fixture session failed');
  runtime.emptySession = second.result.id;
  let finishList;
  runtime.listGate = new Promise(resolve => { finishList = resolve; });
  await page.locator('.topbar button[aria-controls="session-sidebar"]').click();
  await page.locator('.session-row').filter({ hasText: 'Empty session' }).click();
  await expect(page.locator('.agent-strip')).toHaveCount(0);
  finishList();
  await page.locator('.topbar button[aria-controls="session-sidebar"]').click();
  await page.locator('.session-row').filter({ hasText: 'Question check' }).click();
  // Latest bounded history can omit the turn boundary; do not guess from catalog timestamps.
  await expect(page.locator('.agent-strip')).toHaveCount(0);
  await page.getByRole('button', { name: 'Load earlier records' }).click();
  await expect(page.locator('.agent-item')).toHaveCount(3);
  await expect(page.locator('.agent-detail')).toHaveCount(0);
  await expect(page.locator('.agent-more')).toHaveAttribute('aria-expanded', 'false');
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ widths: [390, 320], aligned: true, cardsOverflow: 0, planRows: 3, nestedPlan: false, given: [wide.given, narrow.given] }));
} catch (error) {
  console.error('Browser diagnostics:', JSON.stringify({ errors, body: await page.locator('body').innerText() }));
  throw error;
} finally { await browser.close(); await bridge.close(); await relay.close(); await core.dispose(); }
