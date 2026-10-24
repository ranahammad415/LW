/**
 * Executes OS requests for MCP tools by replaying an ordinary HTTP request through app.inject() with a 60-second
 * internal JWT for the signed-in user (features/mcp-server.md §Audit, limits, redaction). Every existing guard,
 * validation, Idempotency-Key, rate limit and the global redaction hook run unchanged. The MCP layer adds a second
 * mask (maskSecretsDeep), the danger gate (danger.js), the confirm step for dangerous / critical requests, and binds
 * each internal JWT to the classified route (`rk`, `cf`; enforced again by routeGuard.js on the matched route).
 * The MCP layer makes no Prisma write outside its own tables and no outbound HTTP.
 */
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { canonicalJson } from '../lib/idempotency.js';
import { classifyRequest, needsConfirm, normalizePattern } from './danger.js';
import { maskSecretsDeep, previewBody } from './redact.js';
import { generateSecret, hasWriteScope, PREFIX, sha256Hex } from './oauth/tokens.js';

const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
export const MAX_BODY_BYTES = 65_536;
export const MAX_QUERY_BYTES = 2_048;
export const MAX_PATH = 500;
/**
 * Concrete route paths only: no query, no exotic characters (security review H1). `%XX` is accepted syntactically
 * here, but executeOsRequest then allows it only in segments the resolved route pattern declares as a whole `:param`
 * (e.g. an emoji in /reactions/:emoji); a `%` in any static segment is refused (re-review).
 */
const PATH_CHARS_RE = /^[A-Za-z0-9/_\-.:~%]+$/;
const BAD_PCT_RE = /%(?![0-9A-Fa-f]{2})/;
/** Characters a decoded param segment may not contain (separators, a second encoding layer, control chars). */
// eslint-disable-next-line no-control-regex
const BAD_DECODED_RE = /[/\\?#%\u0000-\u001f\u007f]/;

function decodeSegment(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

/**
 * After the route is resolved: every percent-encoded path segment must line up with a pattern segment that is exactly
 * one `:param`. Returns { error } or { classifyPath } (the path with encoded segments replaced by `_`, so the
 * classifier never sees `%`).
 */
export function checkEncodedSegments(path, pattern) {
  if (!path.includes('%')) return { classifyPath: path };
  const raw = path.split('/');
  const pat = normalizePattern(pattern).split('/');
  const rawTrim = raw.length > 1 && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;
  if (rawTrim.length !== pat.length) return { error: 'percent-encoding is only allowed in a route parameter segment' };
  const out = [];
  for (let i = 0; i < rawTrim.length; i += 1) {
    const seg = rawTrim[i];
    if (!seg.includes('%')) {
      out.push(seg);
      continue;
    }
    if (!/^:[A-Za-z_][A-Za-z0-9_]*$/.test(pat[i])) return { error: 'percent-encoding is only allowed in a route parameter segment' };
    const dec = decodeSegment(seg);
    if (dec === null || dec === '' || BAD_DECODED_RE.test(dec) || dec === '.' || dec === '..') return { error: 'invalid percent-encoded path segment' };
    out.push('_');
  }
  return { classifyPath: out.join('/') };
}

/** `rk` = the classified "METHOD /pattern"; `cf` = confirmed through confirm_action (dangerous / critical). */
export function mintInternalJwt(user, grantId, { rk = null, cf = false } = {}, secret = process.env.JWT_ACCESS_SECRET) {
  return jwt.sign({ sub: user.id, role: user.role, tv: user.tokenVersion ?? 0, via: 'mcp', mg: grantId, rk, cf: cf === true }, secret, { expiresIn: '60s' });
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
  if (!PATH_CHARS_RE.test(path) || path.includes('..') || path.includes('//')) return 'path may only contain letters, digits and / _ - . : ~ (put the query in `query`; percent-encode only a route parameter value)';
  if (BAD_PCT_RE.test(path)) return 'path has a malformed percent-encoding';
  for (const seg of path.split('/')) {
    if (!seg.includes('%')) continue;
    const dec = decodeSegment(seg);
    if (dec === null || dec === '' || BAD_DECODED_RE.test(dec) || dec === '.' || dec === '..') return 'invalid percent-encoded path segment';
  }
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

/**
 * Route pattern for a concrete path: Fastify findRoute (existence + params) narrowed by the live catalog. A route the
 * catalog cannot name is refused (never classified on the raw path).
 */
export function resolveRoute(app, catalog, method, path) {
  let params = null;
  if (typeof app.findRoute === 'function') {
    const found = app.findRoute({ method, url: path });
    if (!found) return null;
    params = Object.keys(found.params || {});
  }
  const m = catalog.match(method, path, params);
  if (!m) return null;
  return { pattern: normalizePattern(m.entry.path), params: m.params, routeConfig: m.entry.mcp ? { mcp: m.entry.mcp } : null };
}

/** One injected OS request. Never throws: timeouts and inject errors come back as { error }. */
export async function injectOsRoute(ctx, { method, path, query, body, idempotencyKey, toolName, rk = null, cf = false }) {
  const headers = {
    authorization: `Bearer ${mintInternalJwt(ctx.user, ctx.grant.id, { rk, cf })}`,
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
 * Validates, resolves, classifies and runs one OS request (or parks it as a confirmation when dangerous / critical).
 * Returns an outcome:
 *   { kind:'result', statusCode, body, idempotentReplayed, route, danger }
 *   { kind:'confirm', payload, route, danger, confirmationId }
 *   { kind:'error', message, code, statusCode?, route?, danger }
 * `confirmed: true` (confirm_action, after any owner approval) skips the confirm step only; blocked and scope checks
 * always run, and the internal JWT then carries cf=true for this one route.
 */
export async function executeOsRequest(ctx, req, { confirmed = false, toolArgs = undefined } = {}) {
  const method = String(req.method || 'GET').toUpperCase();
  const { path, query, body, idempotencyKey } = req;
  const invalid = validateOsRequest({ method, path, query, body });
  if (invalid) return { kind: 'error', code: 'INVALID_REQUEST', message: invalid, danger: 'blocked', route: { method, path } };
  const resolved = resolveRoute(ctx.app, ctx.catalog, method, path);
  if (!resolved) return { kind: 'error', code: 'NOT_FOUND', statusCode: 404, message: `No route ${method} ${path}. Use os_route_search.`, danger: 'read', route: { method, path } };
  const route = { method, path, pattern: resolved.pattern };
  const enc = checkEncodedSegments(path, resolved.pattern);
  if (enc.error) return { kind: 'error', code: 'INVALID_REQUEST', message: enc.error, danger: 'blocked', route };
  if (path.includes('%')) {
    // The decoded path (what Fastify's router matches) must resolve to the same pattern; the route guard checks again.
    const decoded = path.split('/').map((s) => (s.includes('%') ? decodeSegment(s) : s)).join('/');
    const again = ctx.catalog.match(method, decoded);
    if (!again || normalizePattern(again.entry.path) !== resolved.pattern) {
      return { kind: 'error', code: 'INVALID_REQUEST', message: 'percent-encoding is only allowed in a route parameter segment', danger: 'blocked', route };
    }
  }
  const c = classifyRequest({ method, routePattern: resolved.pattern, path: enc.classifyPath, query, body, routeConfig: resolved.routeConfig });
  if (c.level === 'blocked') {
    return { kind: 'error', code: 'BLOCKED', statusCode: 403, message: 'This route is not available through MCP', reasons: c.reasons, danger: 'blocked', route };
  }
  if (c.level !== 'read' && !hasWriteScope(ctx.scope)) {
    return { kind: 'error', code: 'READ_ONLY_GRANT', statusCode: 403, message: 'This connection is read-only (os:read); reconnect with full access to make changes', danger: c.level, route };
  }
  if (needsConfirm(c.level) && !confirmed) {
    const conf = await createConfirmation(ctx, { tool: req.toolName, request: { method, path, query: query ?? null, body: body ?? null, idempotencyKey: idempotencyKey ?? null }, toolArgs }, { route, reasons: c.reasons, body, level: c.level });
    return { kind: 'confirm', payload: conf.payload, confirmationId: conf.id, danger: c.level, route };
  }
  const res = await injectOsRoute(ctx, { method, path, query, body, idempotencyKey, toolName: req.toolName, rk: `${method} ${resolved.pattern}`, cf: confirmed && needsConfirm(c.level) });
  if (res.error) {
    return { kind: 'error', code: res.error, statusCode: res.statusCode, message: res.error === 'TIMEOUT' ? `The OS did not answer within ${Math.round(ctx.cfg.toolTimeoutMs / 1000)} s` : 'OS error', danger: c.level, route };
  }
  if (res.statusCode >= 400) {
    return { kind: 'error', code: `HTTP_${res.statusCode}`, statusCode: res.statusCode, message: osErrorMessage(res.statusCode, res.body), osCode: res.body?.code, danger: c.level, route };
  }
  return { kind: 'result', statusCode: res.statusCode, body: res.body, idempotentReplayed: res.idempotentReplayed, danger: c.level, route };
}

/**
 * Stores a single-use confirmation and returns the preview payload with the plaintext confirm token (shown once).
 * The preview shows every non-secret field (strings ≤ 500 chars, first array items) so the human can judge it.
 * `critical` confirmations also need the owner's approval in the OS UI (MCP_CRITICAL_APPROVAL) and live 30 minutes.
 */
export async function createConfirmation(ctx, args, { route, reasons, body, level = 'dangerous' }) {
  const token = generateSecret(PREFIX.confirm);
  const stored = JSON.parse(JSON.stringify(args ?? {}));
  const approval = level === 'critical' && ctx.cfg.criticalApproval !== false;
  const preview = {
    method: route.method,
    path: route.path,
    routePattern: route.pattern,
    level,
    reasons,
    query: previewBody(args?.request?.query ?? null),
    body: previewBody(body ?? null),
  };
  const id = randomUUID();
  const ttl = approval ? ctx.cfg.criticalTtlSec || 1800 : ctx.cfg.confirmTtlSec;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  await ctx.db.mcpConfirmation.create({
    data: {
      id,
      grantId: ctx.grant.id,
      userId: ctx.user.id,
      tool: String(args?.tool || 'os_api_request').slice(0, 64),
      routeKey: `${route.method} ${route.pattern}`.slice(0, 200),
      level: approval ? 'critical' : 'dangerous',
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
      expires_in: ttl,
      preview,
      ...(approval
        ? {
            owner_approval_required: true,
            approve_url: approvalUrl(ctx.cfg, id),
            next: 'Show the user this preview. This action is critical: after the user agrees, call confirm_action; it will answer approval_pending with a link where the owner must approve it in the OS, then call confirm_action again.',
          }
        : { next: 'Show the user this preview and ask. Only if they agree, call confirm_action with confirm_token.' }),
    },
  };
}

export function approvalUrl(cfg, id) {
  return `${cfg.spaUrl}/portal/admin/mcp?approve=${encodeURIComponent(id)}`;
}
