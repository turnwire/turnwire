import { expect, it } from 'vitest';
import { createProgram } from '../apps/cli/src/program.js';
import { detectLocale, errorMessages, localeFromArgv, locales, localizedError, messageForError, messages, protocolErrorCodes, setLocale } from '../apps/cli/src/i18n.js';
import type { ErrorKey, Locale, TextKey } from '../apps/cli/src/i18n.js';

const errorText = (locale: Locale, code: string) => (errorMessages[locale] as Record<string, string | undefined>)[code];

it('defines every catalog key in both locales with non-empty text', () => {
  const keys = Object.keys(messages.en) as TextKey[];
  expect(keys.length).toBeGreaterThan(0);
  expect(Object.keys(messages.zh).sort()).toEqual([...keys].sort());
  for (const locale of locales) for (const key of keys) expect(messages[locale][key], `${locale}.${key}`).toBeTruthy();
});

it('defines every error code in both locales with non-empty text', () => {
  const codes = Object.keys(errorMessages.en) as ErrorKey[];
  expect(codes.length).toBeGreaterThan(0);
  expect(Object.keys(errorMessages.zh).sort()).toEqual([...codes].sort());
  for (const locale of locales) for (const code of codes) expect(errorText(locale, code), `${locale}.${code}`).toBeTruthy();
});

it('offers a message for every shared protocol error code', () => {
  const codes = protocolErrorCodes();
  expect(codes.length).toBeGreaterThan(0);
  const missing = codes.filter(code => locales.some(locale => !errorText(locale, code)));
  expect(missing).toEqual([]);
});

it('detects Chinese from TURNWIRE_LANG, then LC_ALL, then LANG', () => {
  expect(detectLocale({ TURNWIRE_LANG: 'zh-CN', LANG: 'en_US.UTF-8' })).toBe('zh');
  expect(detectLocale({ TURNWIRE_LANG: 'en', LANG: 'zh_CN.UTF-8' })).toBe('en');
  expect(detectLocale({ LC_ALL: 'zh_TW.UTF-8' })).toBe('zh');
  expect(detectLocale({ LANG: 'zh_CN.UTF-8' })).toBe('zh');
  expect(detectLocale({ LANG: 'en_US.UTF-8' })).toBe('en');
  expect(detectLocale({})).toBe('en');
});

it('reads an explicit --lang override from arguments', () => {
  expect(localeFromArgv(['--lang', 'zh', 'status'])).toBe('zh');
  expect(localeFromArgv(['--lang=zh', 'status'])).toBe('zh');
  expect(localeFromArgv(['--lang', 'fr', 'status'])).toBeUndefined();
  expect(localeFromArgv(['status', '--json'])).toBeUndefined();
});

it('localises known error codes and keeps unknown fallbacks', () => {
  setLocale('zh');
  expect(messageForError('SESSION_NOT_FOUND', 'Session not found')).toBe(errorMessages.zh.SESSION_NOT_FOUND);
  expect(messageForError('NOT_A_CODE', 'server detail')).toBe('server detail');
  expect(messageForError(undefined, 'server detail')).toBe('server detail');
  const error = localizedError('CLI_MISSING_CONFIG');
  expect(error.code).toBe('CLI_MISSING_CONFIG');
  expect(error.message).toBe(errorMessages.en.CLI_MISSING_CONFIG);
  setLocale('en');
});

it('builds localised command descriptions for --lang', () => {
  const original = process.argv;
  try {
    process.argv = ['node', 'turnwire', '--lang', 'zh', 'status'];
    const zhProgram = createProgram();
    process.argv = ['node', 'turnwire', '--lang', 'en', 'status'];
    const enProgram = createProgram();
    const description = (program: ReturnType<typeof createProgram>, name: string) => program.commands.find(command => command.name() === name)?.description();
    expect(description(zhProgram, 'status')).toBe(messages.zh['command.status']);
    expect(description(enProgram, 'status')).toBe(messages.en['command.status']);
    expect(description(zhProgram, 'status')).not.toBe(description(enProgram, 'status'));
  } finally { process.argv = original; }
});
