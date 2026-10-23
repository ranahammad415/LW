/**
 * OAuth 2.1 authorization endpoint + SPA consent API (features/mcp-server.md §OAuth flow, steps 4–7).
 *
 * GET  /api/mcp/oauth/authorize                  browser; validates, stores McpAuthRequest, 302 → SPA /mcp/authorize?rid=
 * GET  /api/mcp/oauth/authorize/:rid             OS JWT; consent context for the SPA page (role must be in MCP_ALLOWED_ROLES)
 * POST /api/mcp/oauth/authorize/:rid/decision    OS JWT + browser Origin in FRONTEND_URL; allow → McpGrant + code; deny
 *
 * The SPA never sees state, code_challenge or redirect_uri: they stay on the row. Errors go back to the client's
 * redirect_uri only once the client and that exact redirect_uri are known; otherwise a plain 400 page.
 */
import { MCP_SCOPES, sameResource } from '../config.js';
import { isValidCodeChallenge } from './pkce.js';
import { generateSecret, isMcpPaused, sha256Hex, PREFIX } from './tokens.js';
import { writeAudit } from '../audit.js';
import { clientIp, mcpRateLimit } from '../clientIp.js';
import { isPinnedRedirect } from './clients.js';

const ERR_PAGE = (msg) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Authorization error</title></head><body style="font-family:sans-serif;max-width:560px;margin:3rem auto"><h1>Authorization error</h1><p>${msg}</p><p>Start the connection again from Claude.</p></body></html>`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** redirect_uri with OAuth result params added (existing query kept). */
export function buildRedirect(redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

/** Requested scope → normalized "os:read" | "os:read os:write"; null when it holds anything unsupported. */
export function normalizeScope(raw, fallback = 'os:read os:write') {
  const parts = String(raw ?? '').split(/\s+/).filter(Boolean);
  const list = parts.length ? parts : String(fallback).split(/\s+/).filter(Boolean);
  if (list.some((p) => !MCP_SCOPES.includes(p))) return null;
  return list.includes('os:write') ? 'os:read os:write' : 'os:read';
}

function q(v) {
  return typeof v === 'string' ? v : Array.isArray(v) ? null : v == null ? undefined : String(v);
}

/**
 * Pure validation of the authorize query against a loaded client. Returns
 * { ok:true, value } | { ok:false, redirect:false, message } | { ok:false, redirect:true, error, description }.
 */
export function validateAuthorizeQuery(query, client, cfg) {
  const clientId = q(query.client_id);
  const redirectUri = q(query.redirect_uri);
  if (!clientId) return { ok: false, redirect: false, message: 'client_id is required.' };
  if (!client || client.disabledAt) return { ok: false, redirect: false, message: 'Unknown or disabled client.' };
  const registered = Array.isArray(client.redirectUris) ? client.redirectUris : [];
  if (!redirectUri || !registered.includes(redirectUri)) {
    return { ok: false, redirect: false, message: 'redirect_uri does not match a registered redirect URI.' };
  }
  const state = q(query.state);
  if (state && state.length > 1024) return { ok: false, redirect: true, error: 'invalid_request', description: 'state is too long', redirectUri, state: null };
  const back = (error, description) => ({ ok: false, redirect: true, error, description, redirectUri, state });
  if (q(query.response_type) !== 'code') return back('unsupported_response_type', 'response_type must be code');
  const challenge = q(query.code_challenge);
  if (!challenge) return back('invalid_request', 'code_challenge is required (PKCE)');
  if (q(query.code_challenge_method) !== 'S256') return back('invalid_request', 'code_challenge_method must be S256');
  if (!isValidCodeChallenge(challenge)) return back('invalid_request', 'code_challenge is malformed');
  const scope = normalizeScope(q(query.scope), client.scope || 'os:read os:write');
  if (!scope) return back('invalid_scope', 'Unsupported scope');
  const resource = q(query.resource);
  if (resource !== undefined && resource !== null && !sameResource(resource, cfg.resource)) return back('invalid_target', 'Unknown resource');
  return { ok: true, value: { clientId: client.id, redirectUri, state: state || null, scope, resource: cfg.resource, codeChallenge: challenge } };
}

function userCanConnect(user, cfg) {
  return !!user && user.isActive !== false && user.isAgent !== true && cfg.allowedRoles.includes(user.role);
}

export async function authorizeRoutes(app, { cfg, db }) {
  app.get('/api/mcp/oauth/authorize', { config: { rateLimit: mcpRateLimit(30, '15 minutes') } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = request.query || {};
    const clientId = q(query.client_id);
    const client = clientId && clientId.length <= 191 ? await db.mcpClient.findUnique({ where: { id: clientId } }) : null;
    const v = validateAuthorizeQuery(query, client, cfg);
    if (!v.ok && !v.redirect) return reply.code(400).type('text/html; charset=utf-8').send(ERR_PAGE(escapeHtml(v.message)));
    if (!v.ok) {
      return reply.redirect(buildRedirect(v.redirectUri, { error: v.error, error_description: v.description, state: v.state, iss: cfg.issuer }), 302);
    }
    // Global cap across all IPs and instances (review M5).
    const recent = await db.mcpAuthRequest.count({ where: { createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
    if (recent >= cfg.authRequestsMaxPerHour) {
      reply.header('Retry-After', '600');
      return reply.code(429).type('text/html; charset=utf-8').send(ERR_PAGE('Too many connection attempts right now. Try again in a few minutes.'));
    }
    const row = await db.mcpAuthRequest.create({
      data: { ...v.value, ip: clientIp(request), expiresAt: new Date(Date.now() + cfg.authRequestTtlSec * 1000) },
      select: { id: true },
    });
    return reply.redirect(`${cfg.spaUrl}/mcp/authorize?rid=${encodeURIComponent(row.id)}`, 302);
  });

  async function loadPending(rid) {
    if (typeof rid !== 'string' || rid.length > 191) return null;
    const row = await db.mcpAuthRequest.findUnique({ where: { id: rid }, include: { client: true } });
    if (!row || row.status !== 'pending' || new Date(row.expiresAt).getTime() <= Date.now() || row.client?.disabledAt) return null;
    return row;
  }

  const expired = (reply) => reply.code(404).send({ message: 'This connection request has expired; start again from Claude.', code: 'MCP_AUTH_REQUEST_EXPIRED' });

  app.get('/api/mcp/oauth/authorize/:rid', { onRequest: [app.verifyJwt] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.authMethod !== 'jwt' || request.viaMcp) return reply.code(403).send({ message: 'Sign in to the OS to connect an app', code: 'MCP_ROLE_NOT_ALLOWED' });
    const row = await loadPending(request.params.rid);
    if (!row) return expired(reply);
    const user = request.user;
    const base = {
      requestId: row.id,
      client: { name: row.client.clientName, redirectHost: new URL(row.redirectUri).host, redirectUri: row.redirectUri, verified: isPinnedRedirect(row.redirectUri, cfg), clientUri: row.client.clientUri || null },
      requestedScope: row.scope,
      scopes: row.scope.split(' '),
      user: { name: user.name, email: user.email, role: user.role },
      expiresAt: row.expiresAt,
      paused: await isMcpPaused(db),
    };
    if (!userCanConnect(user, cfg)) {
      return reply.code(403).send({ ...base, message: 'MCP access is limited to the agency owner', code: 'MCP_ROLE_NOT_ALLOWED' });
    }
    return reply.send(base);
  });

  app.post('/api/mcp/oauth/authorize/:rid/decision', { onRequest: [app.verifyJwt] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!cfg.consentOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ message: 'Consent must come from the OS web app', code: 'MCP_BAD_ORIGIN' });
    }
    if (request.authMethod !== 'jwt' || request.viaMcp) return reply.code(403).send({ message: 'Sign in to the OS to connect an app', code: 'MCP_ROLE_NOT_ALLOWED' });
    const decision = request.body?.decision;
    if (decision !== 'allow' && decision !== 'deny') return reply.code(400).send({ message: 'decision must be allow or deny' });
    const row = await loadPending(request.params.rid);
    if (!row) return expired(reply);
    const user = request.user;

    if (decision === 'deny') {
      const done = await db.mcpAuthRequest.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'denied', userId: user.id } });
      if (done.count !== 1) return expired(reply);
      return reply.send({ redirect_to: buildRedirect(row.redirectUri, { error: 'access_denied', error_description: 'The user denied access', state: row.state, iss: cfg.issuer }) });
    }

    if (!userCanConnect(user, cfg)) return reply.code(403).send({ message: 'MCP access is limited to the agency owner', code: 'MCP_ROLE_NOT_ALLOWED' });
    if (await isMcpPaused(db)) return reply.code(503).send({ message: 'MCP access is paused by the agency owner', code: 'MCP_PAUSED' });
    const wanted = request.body?.scope === 'os:read' ? 'os:read' : request.body?.scope === 'os:write' || request.body?.scope === undefined ? row.scope : null;
    if (!wanted) return reply.code(400).send({ message: 'scope must be os:read or os:write' });
    // Never more than requested: a read-only request cannot be widened on the consent page.
    const scope = row.scope === 'os:read' ? 'os:read' : wanted;

    const code = generateSecret(PREFIX.code);
    const result = await db.$transaction(async (tx) => {
      const claimed = await tx.mcpAuthRequest.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'approving' } });
      if (claimed.count !== 1) return null;
      const grant = await tx.mcpGrant.create({
        data: { userId: user.id, clientId: row.clientId, scope, userTokenVersion: user.tokenVersion ?? 0 },
        select: { id: true },
      });
      await tx.mcpAuthRequest.update({
        where: { id: row.id },
        data: { status: 'approved', userId: user.id, grantId: grant.id, scope, codeHash: sha256Hex(code), codeExpiresAt: new Date(Date.now() + cfg.codeTtlSec * 1000) },
      });
      return grant;
    });
    if (!result) return expired(reply);
    await writeAudit(db, { grantId: result.id, userId: user.id, clientId: row.clientId, tool: 'oauth.consent', danger: 'auth', ok: true, args: { scope, client: row.client.clientName }, ip: clientIp(request) }, request.log);
    return reply.send({ redirect_to: buildRedirect(row.redirectUri, { code, state: row.state, iss: cfg.issuer }) });
  });
}
