#!/usr/bin/env node
import { createProgram } from './program.js';
import { safe } from './terminal.js';
import { messageForError } from './i18n.js';

/** `--json` promises stable machine output, so its errors keep the server's own English message. */
function jsonRequested(argv: readonly string[]): boolean {
  for (const arg of argv) { if (arg === '--') break; if (arg === '--json' || arg.startsWith('--json=')) return true; }
  return false;
}
try { await createProgram().parseAsync(); }
catch (error) {
  const code = (error as { code?: string }).code;
  if (!['commander.help', 'commander.helpDisplayed', 'commander.version'].includes(code ?? '')) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(safe(jsonRequested(process.argv) ? message : messageForError(code, message))); process.exitCode = 1;
  }
}
