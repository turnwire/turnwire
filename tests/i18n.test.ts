import { afterEach, expect, it, vi } from 'vitest';
import { turnwireErrorCodes } from '@turnwire/protocol';
import { catalogs, clearLocaleOverride, detectLocale, errorMessageKey, getLocale, messageForError, setLocale, t } from '../apps/remote-web/src/i18n.js';

const locales = ['en', 'zh'] as const;

afterEach(() => { vi.unstubAllGlobals(); clearLocaleOverride(); setLocale('en'); });

it('keeps every message key present and non-empty in both locales', () => {
  const keys = Object.keys(catalogs.en);
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) {
    for (const locale of locales) {
      const value = catalogs[locale][key as keyof typeof catalogs.en];
      expect(typeof value, `${locale}.${key}`).toBe('string');
      expect(value.trim(), `${locale}.${key} is empty`).not.toBe('');
    }
  }
  // Neither catalogue may drift ahead of the other.
  expect(Object.keys(catalogs.zh).sort()).toEqual([...keys].sort());
});

it('gives every shared protocol error code a localized sentence in both locales', () => {
  for (const code of turnwireErrorCodes) {
    for (const locale of locales) {
      const value = catalogs[locale][errorMessageKey(code)];
      expect(typeof value, `${locale} ${code}`).toBe('string');
      expect(value.trim(), `${locale} ${code} is empty`).not.toBe('');
    }
    // A known code must never fall through to the host's own message.
    expect(messageForError(code, 'host message'), code).not.toBe('host message');
  }
});

it('falls back to the host message for an unknown or absent code', () => {
  expect(messageForError('NOT_A_REAL_CODE', 'host message')).toBe('host message');
  expect(messageForError(undefined, 'host message')).toBe('host message');
});

it('serves text through the active locale and switches with setLocale', () => {
  setLocale('en');
  expect(t('status.running')).toBe(catalogs.en['status.running']);
  setLocale('zh');
  expect(getLocale()).toBe('zh');
  expect(t('status.running')).toBe(catalogs.zh['status.running']);
  expect(t('health.retry', { seconds: 5 })).toContain('5');
});

it('detects a Chinese browser as zh and every other language as en', () => {
  clearLocaleOverride();
  vi.stubGlobal('navigator', { language: 'zh-CN' });
  expect(detectLocale()).toBe('zh');
  vi.stubGlobal('navigator', { language: 'fr-FR' });
  expect(detectLocale()).toBe('en');
});
