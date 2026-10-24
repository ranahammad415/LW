/**
 * Route catalog for os_route_search / os_route_describe / os_api_request.
 * - Truth for existence: the live Fastify route table, collected with an onRoute hook at boot (createRouteCollector).
 * - Purpose + guard text: src/mcp/catalog.json, generated from docs/ledger/api-routes.md by
 *   scripts/build-mcp-catalog.mjs (the ledger is not deployed with apps/backend, so the JSON is committed).
 * Routes missing from the ledger still work; they just have no purpose text.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { classifyRequest, normalizePattern } from './danger.js';

const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);

let cachedJson = null;
export function loadCatalogJson() {
  if (cachedJson) return cachedJson;
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'catalog.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    cachedJson = Array.isArray(parsed?.routes) ? parsed.routes : [];
  } catch {
    cachedJson = [];
  }
  return cachedJson;
}

/** onRoute collector: { onRoute(routeOptions), routes: [{method, url}] }. Register before any route plugin. */
export function createRouteCollector() {
  const routes = [];
  const seen = new Set();
  return {
    routes,
    onRoute(opts) {
      const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
      for (const raw of methods) {
        const method = String(raw).toUpperCase();
        if (!METHODS.has(method)) continue;
        const url = normalizePattern(String(opts.url || opts.path || ''));
        if (!url.startsWith('/api/')) continue;
        const key = `${method} ${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        routes.push({ method, url, mcp: typeof opts.config?.mcp === 'string' ? opts.config.mcp : null });
      }
    },
  };
}

function compilePattern(url) {
  const segs = url.split('/').filter(Boolean);
  let statics = 0;
  const names = [];
  const re = segs
    .map((s) => {
      if (s === '*') {
        names.push('*');
        return '(.*)';
      }
      if (s.startsWith(':')) {
        names.push(s.slice(1).replace(/\(.*$/, ''));
        return '([^/]+)';
      }
      statics += 1;
      return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^/${re}/?$`), statics, names };
}

export class RouteCatalog {
  constructor(liveRoutes = [], jsonRoutes = loadCatalogJson()) {
    const meta = new Map(jsonRoutes.map((r) => [`${r.m} ${r.p}`, r]));
    this.entries = liveRoutes.map(({ method, url, mcp = null }) => {
      const j = meta.get(`${method} ${url}`);
      const c = compilePattern(url);
      return { method, path: url, mcp, guard: j?.g || '', purpose: j?.pu || '', ...c };
    });
  }

  /**
   * The route pattern a concrete path resolves to (static segments beat params, like find-my-way), optionally
   * narrowed by the param names Fastify's findRoute reported. Returns { entry, params } or null.
   */
  match(method, path, paramNames = null) {
    const clean = String(path).split('?')[0];
    const key = (names) => names.filter((n) => n !== '*').sort().join(',');
    const want = paramNames ? key([...paramNames]) : null;
    let best = null;
    for (const e of this.entries) {
      if (e.method !== method) continue;
      const m = e.regex.exec(clean);
      if (!m) continue;
      if (want !== null && key(e.names) !== want) continue;
      if (!best || e.statics > best.entry.statics) {
        const params = {};
        e.names.forEach((n, i) => {
          params[n] = decodeURIComponent(m[i + 1]);
        });
        best = { entry: e, params };
      }
    }
    return best;
  }

  /** Exact pattern lookup ("GET /api/tasks/:id/comments"). */
  byPattern(method, pattern) {
    const p = normalizePattern(pattern);
    return this.entries.find((e) => e.method === method && e.path === p) || null;
  }

  describe(entry) {
    const c = classifyRequest({ method: entry.method, routePattern: entry.path, path: entry.path, routeConfig: entry.mcp ? { mcp: entry.mcp } : null });
    return {
      method: entry.method,
      path: entry.path,
      guard: entry.guard,
      purpose: entry.purpose,
      danger: c.level,
      reasons: c.reasons,
      blocked: c.level === 'blocked',
      confirmRequired: c.level === 'dangerous' || c.level === 'critical',
      ownerApprovalRequired: c.level === 'critical',
      scopeRequired: c.scopeRequired,
    };
  }

  search(query, { method, area, limit = 15 } = {}) {
    const AREAS = { admin: '/api/admin/', pm: '/api/pm/', client: '/api/client/', projects: '/api/projects', tasks: '/api/tasks', staff: '/api/staff/' };
    const tokens = String(query || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1);
    const lim = Math.min(30, Math.max(1, Number(limit) || 15));
    const scored = [];
    for (const e of this.entries) {
      if (method && e.method !== method) continue;
      if (area && AREAS[area] && !e.path.startsWith(AREAS[area])) continue;
      const pathL = e.path.toLowerCase();
      const segs = pathL.split(/[^a-z0-9]+/);
      const purposeL = e.purpose.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (segs.includes(t)) score += 4;
        else if (pathL.includes(t)) score += 2;
        if (purposeL.includes(t)) score += 1;
      }
      if (tokens.length && score === 0) continue;
      const d = this.describe(e);
      if (d.blocked) continue;
      scored.push({ score: score - (e.path.length / 1000), d });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, lim).map(({ d }) => ({ method: d.method, path: d.path, guard: d.guard, purpose: d.purpose.slice(0, 200), danger: d.danger, blocked: d.blocked }));
  }
}
