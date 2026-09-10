import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The question card and the agent strip live under the PWA's shared button rule, which centres what
 * a button holds. A grid button that does not re-anchor that centring lays each of its own lines out
 * as a centred track, so every option starts at a different left edge — the "ragged option table"
 * that was reported twice. Text with no break opportunity in it (a path, a key, a digest) is the
 * other half of the same defect: without wrapping it runs past the card and makes the card pannable.
 *
 * These are source-level assertions because both regressions are invisible to a unit test of React
 * output — they are decided entirely in CSS — and because the browser scenario that measures them
 * (`scripts/question-ui-check.mjs`) is deliberately on demand rather than on every push.
 */
const css = readFileSync(resolve('apps/remote-web/src/style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string) => {
  const match = new RegExp(`(?:^|[},])\\s*${selector.replace(/[.[\]>]/g, character => `\\${character}`)}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `no CSS rule for ${selector}`).not.toBeNull();
  // Normalised to `property:value` so a rule written on one line and the same rule written across
  // several both read the same way here.
  return match![1]!.split(';').map(declaration => declaration.split(':').map(part => part.trim()).join(':')).filter(Boolean).join(';');
};

it('anchors the options the shared button rule would centre', () => {
  const options = rule('.question-options button');
  expect(options).toContain('grid-template-columns:minmax(0,1fr)');
  expect(options).toContain('justify-content:start');
  expect(options).toContain('justify-items:stretch');
  expect(rule('.question-options')).toContain('grid-template-columns:minmax(0,1fr)');
});

it('wraps question text that has no break opportunity', () => {
  for (const selector of ['.question-given', '.question-text', '.question-detail', '.question-header', '.question-options button', '.question-options button small']) {
    expect(rule(selector), `${selector} does not wrap long values`).toContain('overflow-wrap:anywhere');
  }
});

it('bounds all composer attachments together and the expanded agent list separately', () => {
  for (const selector of ['.composer-attachments', '.agent-list']) {
    expect(rule(selector)).toMatch(/max-height:\d+dvh/);
    expect(rule(selector)).toContain('overflow-y:auto');
    expect(rule(selector)).toContain('min-width:0');
  }
});

it('lines up the columns of a revealed plan', () => {
  const plan = rule('.agent-plan>li');
  expect(plan).toContain('display:grid');
  expect(plan).toMatch(/grid-template-columns:\s*12px minmax\(58px, auto\) minmax\(0, 1fr\)/);
  expect(rule('.agent-detail')).toContain('max-height');
});
