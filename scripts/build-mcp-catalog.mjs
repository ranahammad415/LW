#!/usr/bin/env node
/**
 * Builds apps/backend/src/mcp/catalog.json (purpose + guard text for the MCP route catalog) from
 * docs/ledger/api-routes.md. Re-run after the ledger's route tables change, then commit the JSON:
 *
 *   node apps/backend/scripts/build-mcp-catalog.mjs
 *
 * Read-only on the ledger; writes only the JSON. OmniSearch rows are skipped (never reachable through MCP).
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROW_RE = /^\| (GET|POST|PATCH|PUT|DELETE) \| `([^`]+)` \| (.*)$/;

function clean(text, max) {
  return String(text || '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Parses the markdown route tables into [{ m, p, g, pu }]. Exported for tests. */
export function parseLedgerRoutes(markdown) {
  const out = [];
  const seen = new Set();
  for (const line of String(markdown).split(/\r?\n/)) {
    const m = ROW_RE.exec(line.trim());
    if (!m) continue;
    const [, method, path, rest] = m;
    if (!path.startsWith('/api/') || path.startsWith('/api/omni-search')) continue;
    const parts = rest.replace(/\|\s*$/, '').split(' | ');
    const guard = parts[0] || '';
    const purpose = parts.slice(2).join(' | ');
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pu = clean(purpose, 240);
    out.push({ m: method, p: path, g: clean(guard, 120), pu: pu === '(see path)' ? '' : pu });
  }
  return out;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const ledger = resolve(here, '../../../docs/ledger/api-routes.md');
  const target = join(here, '../src/mcp/catalog.json');
  const routes = parseLedgerRoutes(readFileSync(ledger, 'utf8'));
  routes.sort((a, b) => (a.p === b.p ? a.m.localeCompare(b.m) : a.p.localeCompare(b.p)));
  // One route per line keeps the committed JSON diffable.
  writeFileSync(target, `{"source":"docs/ledger/api-routes.md","routes":[\n${routes.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`);
  // eslint-disable-next-line no-console
  console.log(`Wrote ${routes.length} routes to ${target}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
