// Source-stylesheet geometry regression, not a runtime or React integration test.
// Fixtures mirror the header/content DOM; no model catalog or model IDs are fabricated.
// Run: node scripts/mobile-content-ui-check.mjs (installed Chrome by default).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const css = await readFile(new URL('../apps/remote-web/src/style.css', import.meta.url), 'utf8');
const icon = size => `<svg width="${size}" height="${size}" aria-hidden="true" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>`;
const long = 'UnbrokenSessionTitleAndDirectory'.repeat(12);
const summary = '<summary><span class="tool-name">read</span><span class="tool-action">Inspect source files</span><span class="tool-status">Complete</span></summary>';
const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"><div class="app"><main>
<header class="topbar"><button class="icon-button mobile-only" aria-label="Open session list">${icon(22)}</button><div class="breadcrumb">${icon(17)}<span>Host</span>${icon(12)}<strong>${long}</strong></div><div class="topbar-right"><span class="status waiting_approval"><span></span>Waiting for approval</span><details class="session-actions"><summary>Session actions</summary><div><button>Rename</button></div></details><button class="icon-button" aria-label="Connection settings">${icon(19)}</button></div></header>
<section class="conversation"><div class="conversation-inner"><div class="session-heading"><span>${icon(16)}/${long}</span><h1>${long}</h1><p>Runtime display name</p></div>
<details class="tool-message">${summary}<pre>Tool result</pre></details><details class="tool-group">${summary}<div class="tool-group-items">Calls</div></details><details class="turn-process">${summary}<div>Steps</div></details>
<div class="inline-child"><section class="child-execution"><div class="child-execution-heading"><strong>Child execution</strong><span>${long}</span></div><div class="child-records"><article class="child-record"><details><summary>read · Complete</summary><pre>${long}</pre></details></article></div><div class="child-execution-actions"><button>Load older records</button><button>Return to latest records</button></div><small>${long}</small></section></div>
<div class="question-card"><div class="question-other-row"><input class="question-other" aria-label="Other answer"><button>Add</button></div></div>
<div class="agent-strip"><div class="agent-row"><button class="agent-item" aria-expanded="false"><span class="agent-dot"></span><span class="agent-label">Review mobile content</span><span class="agent-time">1m</span></button></div><button class="agent-more">Show inactive agents</button><details class="agent-secondary-plan"><summary>Plan</summary></details></div>
<div class="queued-strip"><div class="queued-item"><input class="queued-edit" aria-label="Edit queued prompt"><span class="queued-buttons"><button>Save</button><button>Remove</button><button>Steer</button></span></div></div>
</div></section></main></div></div></body></html>`;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.addStyleTag({ content: css });
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const result = await page.evaluate(() => {
      const bounds = selector => [...document.querySelectorAll(selector)].map(el => ({ selector, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, scroll: el.scrollWidth, client: el.clientWidth }));
      return {
        title: bounds('.breadcrumb strong')[0],
        controls: bounds('.agent-item, .agent-more, .topbar > button, .topbar-right > button, .session-actions > summary, .child-execution-actions button'),
        summaries: bounds('.tool-message > summary, .tool-group > summary, .turn-process > summary, .child-record summary, .agent-secondary-plan summary'),
        content: bounds('.topbar, .session-heading, .session-heading > *, .child-execution, .child-execution > *, .child-execution-actions button, .question-card, .agent-strip, .queued-strip'),
        fonts: [...document.querySelectorAll('.question-other, .queued-edit')].map(el => parseFloat(getComputedStyle(el).fontSize)),
        statusText: document.querySelector('.topbar .status').textContent,
        statusWidth: document.querySelector('.topbar .status').getBoundingClientRect().width,
        actionRows: [...document.querySelectorAll('.child-execution-actions button')].map(el => el.getBoundingClientRect().top),
      };
    });
    assert.ok(result.title.width >= 70, `${width}: useful breadcrumb width ${result.title.width}`);
    for (const box of result.controls) assert.ok(box.height >= 36, `${width}: control too short ${JSON.stringify(box)}`);
    for (const box of result.summaries) assert.ok(box.height >= 32, `${width}: summary too short ${JSON.stringify(box)}`);
    for (const box of result.content) {
      assert.ok(box.left >= -1 && box.right <= width + 1, `${width}: outside viewport ${JSON.stringify(box)}`);
      assert.ok(box.scroll <= box.client + 1, `${width}: horizontal content overflow ${JSON.stringify(box)}`);
    }
    assert.ok(result.fonts.every(size => size >= 16), `${width}: iOS input font floor`);
    assert.equal(result.statusText, 'Waiting for approval');
    assert.ok(result.statusWidth <= 12, `${width}: status should be compact`);
    if (width === 320) assert.ok(result.actionRows[1] > result.actionRows[0], '320: child actions should wrap');
    // Native details activation must still work after enlarging summary targets.
    const tool = page.locator('.tool-message');
    await tool.locator('summary').click();
    assert.equal(await tool.getAttribute('open'), '');
    await tool.locator('summary').click();
    console.log(JSON.stringify({ width, titleWidth: result.title.width, minControlHeight: Math.min(...result.controls.map(x => x.height)), minSummaryHeight: Math.min(...result.summaries.map(x => x.height)), inputFonts: result.fonts, childActionsWrap: result.actionRows[1] > result.actionRows[0] }));
  }
  // Mobile overrides must not change desktop status text or control density.
  await page.setViewportSize({ width: 1024, height: 844 });
  const desktop = await page.evaluate(() => ({ status: getComputedStyle(document.querySelector('.topbar .status')).fontSize, input: getComputedStyle(document.querySelector('.question-other')).fontSize }));
  assert.equal(desktop.status, '11px');
  assert.equal(desktop.input, '11.5px');
  console.log('PASS mobile content source-CSS geometry (320/360/390/430), native disclosure, desktop scope. Not an iOS-device or live-app test.');
} finally {
  await browser.close();
}
