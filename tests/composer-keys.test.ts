import { expect, it } from 'vitest';
import { composerKeyAction } from '../apps/remote-web/src/composerKeys.js';
const enter = { key: 'Enter', shiftKey: false, altKey: false, repeat: false, nativeEvent: { isComposing: false, keyCode: 13 } };
it('sends on Enter and retains Alt+Enter steering', () => {
  expect(composerKeyAction(enter)).toBe('send');
  expect(composerKeyAction({ ...enter, altKey: true })).toBe('steer');
});
it('keeps Shift+Enter as newline and never sends IME confirmation or repeat', () => {
  expect(composerKeyAction({ ...enter, shiftKey: true })).toBeUndefined();
  expect(composerKeyAction({ ...enter, shiftKey: true, altKey: true })).toBeUndefined();
  expect(composerKeyAction({ ...enter, nativeEvent: { isComposing: true, keyCode: 13 } })).toBeUndefined();
  expect(composerKeyAction({ ...enter, nativeEvent: { isComposing: false, keyCode: 229 } })).toBeUndefined();
  expect(composerKeyAction({ ...enter, repeat: true })).toBeUndefined();
  expect(composerKeyAction({ ...enter, key: 'a' })).toBeUndefined();
});
