/**
 * Executes OS requests for MCP tools by replaying an ordinary HTTP request through app.inject() with a 60-second
 * internal JWT for the signed-in user (features/mcp-server.md §Audit, limits, redaction). Every existing guard,
 * validation, Idempotency-Key, rate limit and the global redaction hook run unchanged. The MCP layer adds a second
 * mask (maskSecretsDeep), the danger gate (danger.js) and the confirm step for dangerous requests.
 * The MCP layer makes no Prisma write outside its own tables and no outbound HTTP.
 */
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { canonicalJson } from '../lib/idempotency.js';
import { classifyRequest } from './danger.js';
import { maskSecretsDeep, summarizeArgs } from './redact.js';
import { generateSecret, hasWriteScope, PREFIX, sha256Hex } from './oauth/tokens.js';

const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
export const MAX_BODY_BYTES = 65_536;
export const MAX_QUERY_BYTES = 2_048;
export const MAX_PATH = 500;

export function mintInternalJwt(user, grantId, secret = process.env.JWT_ACCESS_SECRET) {
  return jwt.sign({ sub: user.id, role: user.role, tv: user.tokenVersion ?? 0, via: 'mcp', mg: grantId }, secret, { expiresIn: '60s' });
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

export function buildQueryString(query) {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) sp.set(k, v.map(String).join(','));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Input checks shared by every tool request. Returns null or an error message. */
export function validateOsRequest({ method, path, query, body }) {
  if (!METHODS.has(method)) return 'method must be GET, POST, PATCH, PUT or DELETE';
  if (typeof path !== 'string' || !path.startsWith('/api/')) return 'path must start with /api/';
  if (path.length > MAX_PATH) return `path is longer than ${MAX_PATH} characters`;
  if (/[?#\s\\]/.test(path) || path.includes('..') || path.includes('//')) return 'path must be a plain route path (put the query in `query`)';
  if (query !== undefined && query !== null) {
    if (!isPlainObject(query)) return 'query must be an object';
    for (const v of Object.values(query)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return 'query values must be strings, numbers, booleans or arrays';
    }
    if (buildQueryString(query).length > MAX_QUERY_BYTES) return 'query is too long';
  }
  if (body !== undefined && body !== null) {
    if (typeof body !== 'object') return 'body must be a JSON object or array';
    if (method === 'GET') return 'GET requests cannot carry a body';
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) return `body is larger than ${MAX_BODY_BYTES} bytes`;
  }
  return null;
}

/** Route pattern for a concrete path: Fastify findRoute (existence + params) narrowed by the catalog. */
export function resolveRoute(app, catalog, method, path) {
  let params = null;
  if (typeof app.findRoute === 'function') {
    const found = app.findRoute({ method, url: path });
    if (!found) return null;
    params = Object.keys(found.params || {});
  }
  const m = catalog.match(method, path, params);
  if (!m) return params ? { pattern: path, params: {} } : null;
  return { pattern: m.entry.path, params: m.params };
}

/** One injected OS request. Never throws: timeouts and inject errors come back as { error }. */
export async function injectOsRoute(ctx, { method, path, query, body, idempotencyKey, toolName }) {
  const headers = {
    authorization: `Bearer ${mintInternalJwt(ctx.user, ctx.grant.id)}`,
    accept: 'application/json',
    'x-mcp-tool': String(toolName || 'mcp').slice(0, 64),
  };
  let payload;
  if (body !== undefined && body !== null && method !== 'GET') {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ctx.cfg.toolTimeoutMs);
  });
  let res;
  try {
    res = await Promise.race([
      ctx.app.inject({ method, url: path + buildQueryString(query), headers, payload, remoteAddress: ctx.ip || '127.0.0.1' }),
      timeout,
    ]);
  } catch (err) {
    ctx.log?.error?.({ err: err?.message, path }, 'mcp inject failed');
    return { error: 'OS_ERROR', statusCode: 500 };
  } finally {
    clearTimeout(timer);
  }
  if (res.timedOut) return { error: 'TIMEOUT', statusCode: 504 };
  const contentType = String(res.headers['content-type'] || '');
  const raw = typeof res.body === 'string' ? res.body : String(res.body ?? '');
  let parsed;
  if (contentType.includes('json')) {
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = { nonJson: true, contentType, bytes: Buffer.byteLength(raw) };
    }
  } else if (!raw) {
    parsed = null;
  } else {
    parsed = { nonJson: true, contentType: contentType || 'unknown', bytes: Buffer.byteLength(raw) };
  }
  return {
    statusCode: res.statusCode,
    body: maskSecretsDeep(parsed),
    idempotentReplayed: res.headers['idempotent-replayed'] === 'true',
  };
}

/** A short, safe message for an OS error response (never a stack, never the raw 5xx body). */
export function osErrorMessage(statusCode, body) {
  if (statusCode >= 500) return `OS error (${statusCode})`;
  const msg = body && typeof body === 'object' && typeof body.message === 'string' ? body.message.slice(0, 500) : `Request failed (${statusCode})`;
  return msg;
}

/**
 * Validates, resolves, classifies and runs one OS request (or parks it as a confirmation when dangerous).
 * Returns an outcome:
 *   { kind:'result', statusCode, body, idempotentReplayed, route, danger }
 *   { kind:'confirm', payload, route, danger, confirmationId }
 *   { kind:'error', message, code, statusCode?, route?, danger }
 * `confirmed: true` (confirm_action) skips the confirm step only; blocked and scope checks always run.
 */
export async function executeOsRequest(ctx, req, { confirmed = false, toolArgs = undefined } = {}) {
  const method = String(req.method || 'GET').toUpperCase();
  const { path, query, body, idempotencyKey } = req;
  const invalid = validateOsRequest({ method, path, query, body });
  if (invalid) return { kind: 'error', code: 'INVALID_REQUEST', message: invalid, danger: 'blocked', route: { method, path } };
  const resolved = resolveRoute(ctx.app, ctx.catalog, method, path);
  if (!resolved) return { kind: 'error', code: 'NOT_FOUND', statusCode: 404, message: `No route ${method} ${path}. Use os_route_search.`, danger: 'read', route: { method, path } };
  const route = { method, path, pattern: resolved.pattern };
  const c = classifyRequest({ method, routePattern: resolved.pattern, path, query, body });
  if (c.level === 'blocked') {
    return { kind: 'error', code: 'BLOCKED', statusCode: 403, message: 'This route is not available through MCP', reasons: c.reasons, danger: 'blocked', route };
  }
  if (c.level !== 'read' && !hasWriteScope(ctx.scope)) {
    return { kind: 'error', code: 'READ_ONLY_GRANT', statusCode: 403, message: 'This connection is read-only (os:read); reconnect with full access to make changes', danger: c.level, route };
  }
  if (c.level === 'dangerous' && !confirmed) {
    const conf = await createConfirmation(ctx, { tool: req.toolName, request: { method, path, query: query ?? null, body: body ?? null, idempotencyKey: idempotencyKey ?? null }, toolArgs }, { route, reasons: c.reasons, body });
    return { kind: 'confirm', payload: conf.payload, confirmationId: conf.id, danger: 'dangerous', route };
  }
  const res = await injectOsRoute(ctx, { method, path, query, body, idempotencyKey, toolName: req.toolName });
  if (res.error) {
    return { kind: 'error', code: res.error, statusCode: res.statusCode, message: res.error === 'TIMEOUT' ? `The OS did not answer within ${Math.round(ctx.cfg.toolTimeoutMs / 1000)} s` : 'OS error', danger: c.level, route };
  }
  if (res.statusCode >= 400) {
    return { kind: 'error', code: `HTTP_${res.statusCode}`, statusCode: res.statusCode, message: osErrorMessage(res.statusCode, res.body), osCode: res.body?.code, danger: c.level, route };
  }
  return { kind: 'result', statusCode: res.statusCode, body: res.body, idempotentReplayed: res.idempotentReplayed, danger: c.level, route };
}

/** Stores a single-use confirmation and returns the preview payload with the plaintext confirm token (shown once). */
export async function createConfirmation(ctx, args, { route, reasons, body }) {
  const token = generateSecret(PREFIX.confirm);
  const stored = JSON.parse(JSON.stringify(args ?? {}));
  const preview = {
    method: route.method,
    path: route.path,
    routePattern: route.pattern,
    reasons,
    bodySummary: summarizeArgs(body ?? null),
  };
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + ctx.cfg.confirmTtlSec * 1000);
  await ctx.db.mcpConfirmation.create({
    data: {
      id,
      grantId: ctx.grant.id,
      userId: ctx.user.id,
      tool: String(args?.tool || 'os_api_request').slice(0, 64),
      routeKey: `${route.method} ${route.pattern}`.slice(0, 200),
      argsHash: sha256Hex(canonicalJson(stored)),
      args: stored,
      preview,
      tokenHash: sha256Hex(token),
      expiresAt,
    },
  });
  return {
    id,
    payload: {
      status: 'confirmation_required',
      confirm_token: token,
      expires_in: ctx.cfg.confirmTtlSec,
      preview,
      next: 'Show the user this preview and ask. Only if they agree, call confirm_action with confirm_token.',
    },
  };
}
