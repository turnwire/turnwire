#!/usr/bin/env node
// Probes the DSH model-selection contract against an isolated Host.
//
// The adapter pins a DSH source revision because its wire contracts are only partly
// documented. `session/modelCatalog` and `session/selectModel` were derived from the
// installed Host declarations (dsh-api-session-controller/lib/typert.host.js), not from
// prose, so this script exercises them for real and records the exact shapes and error
// codes. It never sends a prompt and never calls a model.
//
// Usage: node scripts/dsh-model-probe.mjs
// Env:   DSH_BIN     path to the dsh launcher (defaults to the installed host runtime)
//        DSH_PORT    loopback port (defaults to 3199)

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const dshBin = process.env.DSH_BIN ?? '/home/arjenzhou/nova/runtime/dsh/node_modules/.bin/dsh';
const port = Number(process.env.DSH_PORT ?? 3199);

function section(title) { console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`); }
function show(label, value) { console.log(`\n--- ${label} ---\n${JSON.stringify(value, null, 2)}`); }

const scratch = await mkdtemp(join(tmpdir(), 'turnwire-dsh-probe-'));
const dshHome = join(scratch, 'dsh-state');
await mkdir(dshHome, { recursive: true, mode: 0o700 });
const patch = join(scratch, 'deepseek.patch.yml');
await writeFile(patch, await (await import('node:fs/promises')).readFile(join(root, 'config/dsh-deepseek.patch.yml')));

let child;
let cookie = '';
let url;

/** Same Connection envelope and launch-URL contract the adapter uses. */
async function authenticate(base, token) {
  const auth = new URL(base);
  auth.searchParams.set('token', token);
  const response = await fetch(auth, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  const setCookie = response.headers.get('set-cookie');
  await response.body?.cancel();
  if (response.status !== 303 || !setCookie) throw new Error(`auth failed: HTTP ${response.status}`);
  return setCookie.split(';')[0];
}

async function rpc(endpoint, args) {
  const rpcId = randomUUID();
  const response = await fetch(new URL(`/api/${endpoint}`, url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  const envelope = JSON.parse(text);
  if (!envelope.result?.ok) throw Object.assign(new Error(envelope.result?.error?.message ?? 'rpc failed'), { code: envelope.result?.error?.code, raw: envelope });
  return envelope.result.value;
}

try {
  section('1. 启动隔离的 DSH Host');
  console.log(`  DSH_HOME = ${dshHome}`);
  console.log(`  patch    = ${patch}`);
  console.log(`  port     = ${port}`);
  console.log(`  bin      = ${dshBin}`);

  child = spawn(dshBin, ['--patch', patch, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, DSH_HOME: dshHome, DO_NOT_TRACK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const launch = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('DSH did not print a launch URL in time')), 90_000);
    const onLine = line => {
      const found = line.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+)/)?.[1];
      if (found) { clearTimeout(timer); res(found); }
    };
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', onLine);
    child.once('exit', code => { clearTimeout(timer); rej(new Error(`DSH exited early with code ${code}`)); });
  });
  url = new URL(launch); const token = url.searchParams.get('token');
  url.search = ''; url.pathname = '/';
  console.log(`  启动 URL 已获取（token 长度 ${token.length}，不打印）`);

  section('2. 认证');
  cookie = await authenticate(url.href, token);
  console.log(`  cookie 已获取（${cookie.length} 字符）`);

  section('3. session/modelCatalog（无参数）');
  let catalog;
  try {
    catalog = await rpc('session/modelCatalog', {});
    show('ModelCatalog', catalog);
  } catch (error) {
    console.log(`  失败: ${error.code ?? ''} ${error.message}`);
    if (error.raw) show('原始响应', error.raw);
  }

  section('4. session/create（用于后续 selectModel）');
  const sessionId = randomUUID();
  let created;
  try {
    created = await rpc('session/create', { request: { sessionId, cwd: root } });
    show('创建结果', created);
  } catch (error) {
    console.log(`  失败: ${error.code ?? ''} ${error.message}`);
  }

  section('5. session/selectModel —— 用目录里的 default（若可用）');
  const selection = catalog?.default ?? { provider: 'deepseek', model: 'deepseek-chat' };
  console.log(`  尝试选择: ${JSON.stringify(selection)}`);
  try {
    show('selectModel 结果', await rpc('session/selectModel', { request: { sessionId: (created?.sessionId ?? sessionId), ...selection } }));
  } catch (error) {
    console.log(`  失败: code=${error.code ?? '(none)'} message=${error.message}`);
    if (error.raw) show('原始响应', error.raw);
  }

  section('6. session/selectModel —— 故意选一个不存在的模型（抓错误形状）');
  try {
    show('selectModel 结果', await rpc('session/selectModel', { request: { sessionId: (created?.sessionId ?? sessionId), provider: 'no-such-provider', model: 'no-such-model' } }));
  } catch (error) {
    console.log(`  code    = ${error.code ?? '(none)'}`);
    console.log(`  message = ${error.message}`);
    if (error.raw) show('原始响应（错误信封）', error.raw);
  }

  section('7. 结论');
  console.log('  以上即 session/modelCatalog 与 session/selectModel 的实测契约。');
  console.log('  未发送任何 prompt，未调用任何模型。');
} catch (error) {
  console.error(`\n探测失败: ${error.message}`);
  process.exitCode = 1;
} finally {
  child?.kill('SIGTERM');
  await new Promise(res => setTimeout(res, 500));
  child?.kill('SIGKILL');
  await rm(scratch, { recursive: true, force: true });
  console.log(`\n清理完成（已停止 DSH 并删除 ${scratch}）`);
}
