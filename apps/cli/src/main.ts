#!/usr/bin/env node
import { createProgram } from './program.js';
import { safe } from './terminal.js';
try { await createProgram().parseAsync(); }
catch (error) {
  const code = (error as { code?: string }).code;
  if (!['commander.help', 'commander.helpDisplayed', 'commander.version'].includes(code ?? '')) {
    console.error(safe(error instanceof Error ? error.message : String(error))); process.exitCode = 1;
  }
}
