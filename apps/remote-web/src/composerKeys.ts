/** IME confirmation must never send a draft. Shift+Enter always remains a newline. */
export function composerKeyAction(event: { key: string; shiftKey: boolean; altKey: boolean; repeat: boolean; nativeEvent: { isComposing: boolean; keyCode: number } }): 'send' | 'steer' | undefined {
  if (event.key !== 'Enter' || event.shiftKey || event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  return event.altKey ? 'steer' : 'send';
}
