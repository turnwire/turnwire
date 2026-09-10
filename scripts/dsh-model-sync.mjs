#!/usr/bin/env node
/**
 * Refresh the model list of every OpenAI-shaped provider route from the endpoint that route names.
 *
 * DSH serves exactly the models a route lists: `resolveRouteModels` refuses a declared route with none
 * ("the installed catalog does not describe this route, so its models must be listed in configuration"),
 * and the plugin's own discovery API only feeds the Models page for adoption. So the list has to exist —
 * but the endpoint is the authority for which ids exist, and a hand-written list drifts from it in both
 * directions. This script asks each route's own `GET {baseURL}/models` and writes exactly that answer.
 *
 * Nothing is invented: an id the endpoint does not answer with is dropped, one it adds appears, and a
 * display name already written by hand is kept for as long as its id stays.
 *
 * Usage: node scripts/dsh-model-sync.mjs [--check] [--file config/dsh-deepseek.patch.yml]
 *        --check reports what would change and exits 1 when the file is out of date, changing nothing.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const indentOf = line => line.match(/^\s*/)[0].length;

/**
 * Provider routes declared under `providers:` in a DSH patch overlay, each with the text block its
 * `models:` list occupies. Routes without a `baseURL` (an installed-catalog route) are left alone: their
 * models come from the catalog, not from an endpoint.
 */
export function routeModels(text) {
  const lines = text.split('\n');
  const routes = [];
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*providers:\s*$/.test(lines[index])) continue;
    const providersIndent = indentOf(lines[index]);
    for (let scan = index + 1; scan < lines.length; scan++) {
      const line = lines[scan];
      if (line.trim() === '') continue;
      const depth = indentOf(line);
      if (depth <= providersIndent) break;
      // A route is a direct child of `providers:`; anything deeper belongs to the route above it.
      if (depth !== providersIndent + 2) continue;
      const declared = /^\s*([\w.-]+):\s*$/.exec(line);
      if (!declared) continue;
      let baseURL; let apiKeyEnv; let api; let list;
      for (let key = scan + 1; key < lines.length; key++) {
        const candidate = lines[key];
        if (candidate.trim() === '') continue;
        const keyDepth = indentOf(candidate);
        if (keyDepth <= depth) break;
        const field = /^\s*([A-Za-z]+):\s*(.*?)\s*$/.exec(candidate);
        if (!field) continue;
        if (field[1] === 'baseURL') baseURL = field[2];
        else if (field[1] === 'apiKeyEnv') apiKeyEnv = field[2];
        else if (field[1] === 'api') api = field[2];
        else if (field[1] === 'models') list = { listIndent: keyDepth, start: key + 1 };
      }
      if (!list) continue;
      let end = list.start;
      for (; end < lines.length; end++) {
        if (lines[end].trim() === '') continue;
        if (indentOf(lines[end]) <= list.listIndent) break;
      }
      routes.push({ id: declared[1], baseURL, apiKeyEnv, api, listIndent: list.listIndent, start: list.start, end });
    }
  }
  return routes;
}

/** The ids (and hand-written names) currently listed for one route. */
export function listedModels(lines, route) {
  const models = [];
  for (let index = route.start; index < route.end; index++) {
    const hit = /^\s*-\s+id:\s*(\S+)\s*$/.exec(lines[index]);
    if (!hit) continue;
    const next = lines[index + 1] ?? '';
    const name = indentOf(next) > route.listIndent ? /^\s*name:\s*(.+?)\s*$/.exec(next) : undefined;
    models.push({ id: hit[1], ...(name ? { name: name[1] } : {}) });
  }
  return models;
}

/** A readable fallback for an id nobody wrote a name for: `gpt-6-astra` becomes `GPT 6 Astra`. */
export function displayName(id) {
  return id.split('-').map((part, index) => (index === 0 && /^[a-z]{2,4}$/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))).join(' ');
}

/** Replaces one route's list with `ids`, keeping the names it already had. Returns the new text. */
export function rewrite(text, route, ids) {
  const lines = text.split('\n');
  const known = new Map(listedModels(lines, route).map(model => [model.id, model.name]));
  const pad = ' '.repeat(route.listIndent + 2);
  const entryPad = ' '.repeat(route.listIndent + 4);
  const block = [
    `${pad}# Asked of this route's own GET {baseURL}/models by scripts/dsh-model-sync.mjs: an id the endpoint`,
    `${pad}# stops answering with is dropped, so a model it adds appears without anyone editing this file.`,
    ...ids.flatMap(id => [`${pad}- id: ${id}`, `${entryPad}name: ${known.get(id) ?? displayName(id)}`]),
  ];
  return [...lines.slice(0, route.start), ...block, ...lines.slice(route.end)].join('\n');
}

async function reachable(route, environment) {
  const key = route.apiKeyEnv ? (process.env[route.apiKeyEnv] ?? environment[route.apiKeyEnv]) : undefined;
  const answer = await fetch(`${route.baseURL.replace(/\/$/, '')}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000) });
  if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
  const body = await answer.json().catch(() => undefined);
  const ids = (Array.isArray(body?.data) ? body.data : []).map(entry => String(entry?.id ?? '')).filter(Boolean);
  if (!ids.length) throw new Error('the endpoint listed no models');
  return ids;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const named = args.indexOf('--file');
  const file = resolve(named < 0 ? 'config/dsh-deepseek.patch.yml' : args[named + 1]);
  const text = await readFile(file, 'utf8');
  let environment = {};
  try { environment = JSON.parse(await readFile(resolve('config/dsh.env.json'), 'utf8')); } catch { /* the environment may carry the key instead */ }

  let updated = text; let changed = false; let unreachable = 0;
  // Later routes are rewritten first so an edit cannot move an earlier route's block boundaries.
  for (const route of routeModels(text).filter(route => route.baseURL && /openai-(completions|responses)/.test(route.api ?? '')).reverse()) {
    let ids;
    try { ids = await reachable(route, environment); }
    catch (error) { console.error(`  ${route.id}: ${error instanceof Error ? error.message : String(error)} — left as it is`); unreachable++; continue; }
    const before = listedModels(updated.split('\n'), route).map(model => model.id);
    if (before.length === ids.length && before.every((id, index) => id === ids[index])) { console.log(`  ${route.id}: ${ids.length} models, already current`); continue; }
    console.log(`  ${route.id}: ${before.filter(id => !ids.includes(id)).length} dropped, ${ids.filter(id => !before.includes(id)).length} added`);
    updated = rewrite(updated, route, ids); changed = true;
  }

  if (!changed) {
    console.log(unreachable ? 'Nothing written; an endpoint could not be asked.' : 'Every list matches its endpoint.');
    process.exit(unreachable && check ? 1 : 0);
  }
  if (check) { console.error('The model lists are out of date; run: node scripts/dsh-model-sync.mjs'); process.exit(1); }
  await writeFile(file, updated);
  console.log(`Wrote ${file}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
