#!/usr/bin/env node
// Keep even in-process test fixtures away from the invoking user's host state.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { hermeticEnv } from '../tests/helpers/hermetic-env.mjs';

const root = await mkdtemp(join(tmpdir(), 'turnwire-tests-'));
const workspace = fileURLToPath(new URL('../', import.meta.url));
let child;
const forward = signal => child?.kill(signal);
const interrupt = () => forward('SIGINT');
const terminate = () => forward('SIGTERM');
try {
  child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', ...process.argv.slice(2)], {
    cwd: workspace, env: hermeticEnv(root), stdio: 'inherit',
  });
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  process.exitCode = result.code ?? (result.signal === 'SIGINT' ? 130 : 143);
} finally {
  process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  await rm(root, { recursive: true, force: true });
}
