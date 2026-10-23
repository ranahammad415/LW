/**
 * Enforcement on the route Fastify actually matched (security review H1). Tool calls reach OS routes through
 * app.inject with a 60 s internal JWT `{via:'mcp', mg, rk, cf}`:
 *   rk = "METHOD /route/pattern" the MCP layer classified, cf = true only for a confirmed (dangerous / critical) call.
 * This global preHandler (after the route's own onRequest guards and body parsing, before its preHandlers and the
 * handler) re-runs classifyRequest on request.routeOptions.url + method + query + body + route config and answers
 * 403 MCP_ROUTE_REFUSED when the result is blocked, the matched route is not `rk`, or a dangerous / critical request
 * has no `cf`. It also binds each internal JWT to one route. Requests without an MCP JWT are untouched.
 * Install on the root app before any route plugin (src/index.js, tests).
 */
import jwt from 'jsonwebtoken';
import { classifyRequest, needsConfirm, normalizePattern } from './danger.js';

export function mcpJwtClaims(request, secret = process.env.JWT_ACCESS_SECRET) {
  const h = request.headers?.authorization;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
  const token = h.slice(7).trim();
  if (!token.startsWith('eyJ')) return null;
  try {
    const p = jwt.verify(token, secret);
    return p && p.via === 'mcp' ? p : null;
  } catch {
    return null;
  }
}

export function routeGuardDecision(request, claims) {
  const method = request.method === 'HEAD' ? 'GET' : String(request.method || '').toUpperCase();
  const url = normalizePattern(request.routeOptions?.url || '');
  const c = classifyRequest({ method, routePattern: url, path: url, query: request.query, body: request.body, routeConfig: request.routeOptions?.config });
  const key = `${method} ${url}`;
  if (c.level === 'blocked') return { ok: false, why: 'blocked', key, level: c.level };
  if (claims.rk !== key) return { ok: false, why: 'route mismatch', key, level: c.level };
  if (needsConfirm(c.level) && claims.cf !== true) return { ok: false, why: 'confirm required', key, level: c.level };
  return { ok: true, key, level: c.level };
}

export function installMcpRouteGuard(app, { secret } = {}) {
  app.addHook('preHandler', async (request, reply) => {
    const claims = mcpJwtClaims(request, secret || process.env.JWT_ACCESS_SECRET);
    if (!claims) return;
    const d = routeGuardDecision(request, claims);
    if (d.ok) return;
    request.log?.warn?.({ rk: claims.rk, matched: d.key, level: d.level, why: d.why, grantId: claims.mg }, 'MCP route guard refused a request');
    return reply.code(403).send({ message: 'This request is not allowed through MCP', code: 'MCP_ROUTE_REFUSED', reason: d.why });
  });
}
