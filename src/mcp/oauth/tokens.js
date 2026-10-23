/**
 * MCP OAuth tokens (features/mcp-server.md §OAuth). Opaque random secrets, only sha256 hex stored:
 *   mcpc_ authorization code (5 min, on McpAuthRequest.codeHash), mcpa_ access token (MCP_ACCESS_TTL_SEC),
 *   mcpr_ refresh token (MCP_REFRESH_TTL_DAYS sliding, rotated on every use, never past the grant's
 *   MCP_GRANT_MAX_DAYS), mcpx_ confirm token (McpConfirmation.tokenHash).
 * A refresh token presented twice revokes its whole family and the grant (reuse detection).
 * verifyMcpBearer runs on every POST /api/mcp: token, grant, user, role, tokenVersion, resource and the pause switch.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { AUTH_USER_SELECT } from '../../lib/apiTokens.js';

export const PREFIX = { code: 'mcpc_', access: 'mcpa_', refresh: 'mcpr_', confirm: 'mcpx_' };
const SECRET_RE = /^mcp[acrx]_[A-Za-z0-9_-]{43}$/;
const LAST_USED_THROTTLE_MS = 60_000;
const PAUSE_CACHE_MS = 10_000;

export function generateSecret(prefix) {
  return prefix + randomBytes(32).toString('base64url');
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function looksLikeSecret(raw, prefix) {
  return typeof raw === 'string' && raw.startsWith(prefix) && SECRET_RE.test(raw);
}

/** Constant-time comparison of two equal-length hex digests (after the unique-hash lookup). */
export function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function parseScope(scope) {
  return new Set(String(scope || '').split(/\s+/).filter(Boolean));
}

export function hasWriteScope(scope) {
  return parseScope(scope).has('os:write');
}

const DAY_MS = 86_400_000;

/** Absolute end of a grant (createdAt + MCP_GRANT_MAX_DAYS). */
export function grantHardExpiry(grant, cfg) {
  return new Date(new Date(grant.createdAt).getTime() + cfg.grantMaxDays * DAY_MS);
}

/**
 * Issues an access + refresh pair for a grant. `familyId` is new for a code exchange and kept on rotation.
 * Returns the plaintext tokens once; only hashes are written.
 */
export async function issueTokenPair(db, { grant, resource, cfg, familyId = randomUUID(), parentId = null, now = new Date() }) {
  const access = generateSecret(PREFIX.access);
  const refresh = generateSecret(PREFIX.refresh);
  const hardEnd = grantHardExpiry(grant, cfg).getTime();
  const accessExp = new Date(Math.min(now.getTime() + cfg.accessTtlSec * 1000, hardEnd));
  const refreshExp = new Date(Math.min(now.getTime() + cfg.refreshTtlDays * DAY_MS, hardEnd));
  await db.mcpToken.createMany({
    data: [
      { grantId: grant.id, kind: 'access', tokenHash: sha256Hex(access), prefix: access.slice(0, 10), familyId, parentId, resource, expiresAt: accessExp },
      { grantId: grant.id, kind: 'refresh', tokenHash: sha256Hex(refresh), prefix: refresh.slice(0, 10), familyId, parentId, resource, expiresAt: refreshExp },
    ],
  });
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.max(1, Math.floor((accessExp.getTime() - now.getTime()) / 1000)),
    refresh_token: refresh,
    scope: grant.scope,
  };
}

/** Revokes every token of a refresh family and the grant (refresh reuse / code replay). */
export async function revokeGrantAndFamily(db, { grantId, familyId = null, reason, now = new Date() }) {
  if (familyId) {
    await db.mcpToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
  }
  if (grantId) {
    await db.mcpToken.updateMany({ where: { grantId, revokedAt: null }, data: { revokedAt: now } });
    await db.mcpGrant.updateMany({ where: { id: grantId, revokedAt: null }, data: { revokedAt: now, revokedReason: reason } });
  }
}

function grantUsable(grant, user, cfg, now) {
  if (!grant || grant.revokedAt) return 'grant revoked';
  if (grant.client?.disabledAt) return 'client disabled';
  if (grantHardExpiry(grant, cfg).getTime() <= now.getTime()) return 'grant expired';
  if (!user || !user.isActive) return 'user inactive';
  if (user.tokenVersion !== grant.userTokenVersion) return 'session invalidated';
  if (!cfg.allowedRoles.includes(user.role)) return 'role not allowed';
  return null;
}

/**
 * grant_type=refresh_token. Rotation with reuse detection:
 * - unknown / expired / revoked / wrong client / wrong resource → invalid_grant;
 * - already used → reuse: the family and the grant are revoked → invalid_grant (+ reuse info for the audit row);
 * - else the old token is CAS-marked used and a new pair is issued in the same family.
 */
export async function rotateRefreshToken(db, { raw, clientId, resource, cfg, now = new Date() }) {
  const fail = (description, extra = {}) => ({ ok: false, error: 'invalid_grant', description, ...extra });
  if (!looksLikeSecret(raw, PREFIX.refresh)) return fail('Unknown refresh token');
  const hash = sha256Hex(raw);
  const row = await db.mcpToken.findUnique({
    where: { tokenHash: hash },
    include: { grant: { include: { client: true, user: { select: AUTH_USER_SELECT } } } },
  });
  if (!row || row.kind !== 'refresh' || !sameHash(row.tokenHash, hash)) return fail('Unknown refresh token');
  const grant = row.grant;
  if (!grant || grant.clientId !== clientId) return fail('Refresh token was not issued to this client');
  if (row.usedAt) {
    await revokeGrantAndFamily(db, { grantId: grant.id, familyId: row.familyId, reason: 'refresh_reuse', now });
    return fail('Refresh token reuse detected; the grant was revoked', { reuse: true, grantId: grant.id, userId: grant.userId });
  }
  if (row.revokedAt) return fail('Refresh token revoked');
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return fail('Refresh token expired');
  if (resource && resource !== row.resource) return fail('Resource does not match the original grant');
  const why = grantUsable(grant, grant.user, cfg, now);
  if (why) return fail(why);
  const claimed = await db.mcpToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
  if (claimed.count !== 1) {
    await revokeGrantAndFamily(db, { grantId: grant.id, familyId: row.familyId, reason: 'refresh_reuse', now });
    return fail('Refresh token reuse detected; the grant was revoked', { reuse: true, grantId: grant.id, userId: grant.userId });
  }
  // The access token of the previous pair stops working too (one live pair per family).
  await db.mcpToken.updateMany({ where: { familyId: row.familyId, kind: 'access', revokedAt: null }, data: { revokedAt: now } });
  const tokens = await issueTokenPair(db, { grant, resource: row.resource, cfg, familyId: row.familyId, parentId: row.id, now });
  return { ok: true, tokens, grant };
}

/**
 * RFC 7009 revocation. A refresh token revokes its whole grant; an access token only itself. Unknown tokens are
 * ignored (the endpoint always answers 200). Only tokens issued to `clientId` are touched.
 */
export async function revokeTokenByValue(db, { raw, clientId, now = new Date() }) {
  if (typeof raw !== 'string' || !/^mcp[ar]_/.test(raw)) return { revoked: false };
  const hash = sha256Hex(raw);
  const row = await db.mcpToken.findUnique({ where: { tokenHash: hash }, include: { grant: true } });
  if (!row || !sameHash(row.tokenHash, hash) || !row.grant) return { revoked: false };
  if (clientId && row.grant.clientId !== clientId) return { revoked: false };
  if (row.kind === 'refresh') {
    await revokeGrantAndFamily(db, { grantId: row.grantId, familyId: row.familyId, reason: 'client_revoked', now });
  } else {
    await db.mcpToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: now } });
  }
  return { revoked: true, grantId: row.grantId, userId: row.grant.userId, kind: row.kind };
}

// ── pause switch (AgencySetting.mcpPausedAt), cached per instance ──
let pauseCache = { at: 0, paused: false };
export function invalidatePauseCache() {
  pauseCache = { at: 0, paused: false };
}
export async function isMcpPaused(db, now = Date.now()) {
  if (now - pauseCache.at < PAUSE_CACHE_MS) return pauseCache.paused;
  let paused = false;
  try {
    const row = await db.agencySetting.findFirst({ select: { mcpPausedAt: true } });
    paused = !!row?.mcpPausedAt;
  } catch {
    // A missing column (migration not applied yet) must not open the gate: treat as paused.
    paused = true;
  }
  pauseCache = { at: now, paused };
  return paused;
}

const lastUsed = new Map();
function touchGrant(db, grant, log) {
  const now = Date.now();
  const prev = lastUsed.get(grant.id) || (grant.lastUsedAt ? new Date(grant.lastUsedAt).getTime() : 0);
  if (now - prev < LAST_USED_THROTTLE_MS) return;
  lastUsed.set(grant.id, now);
  if (lastUsed.size > 5000) lastUsed.clear();
  const cutoff = new Date(now - LAST_USED_THROTTLE_MS);
  const stamp = new Date(now);
  Promise.all([
    db.mcpGrant.updateMany({ where: { id: grant.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }] }, data: { lastUsedAt: stamp } }),
    db.mcpClient.updateMany({ where: { id: grant.clientId, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }] }, data: { lastUsedAt: stamp } }),
  ]).catch((err) => log?.warn?.({ err: err?.message, grantId: grant.id }, 'mcp grant lastUsedAt update failed'));
}

/**
 * Bearer check for POST /api/mcp. Returns { ok:true, ctx:{grant, user, client, scope, tokenId} } or
 * { ok:false, status, error, description, code? } (401 invalid_token, 403 role, 503 paused).
 */
export async function verifyMcpBearer(db, request, cfg, now = new Date()) {
  const header = request.headers?.authorization;
  const raw = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!raw) return { ok: false, status: 401, error: null, description: 'Missing bearer token' };
  const invalid = (description) => ({ ok: false, status: 401, error: 'invalid_token', description });
  if (!looksLikeSecret(raw, PREFIX.access)) return invalid('Unknown access token');
  const hash = sha256Hex(raw);
  let row;
  try {
    row = await db.mcpToken.findUnique({
      where: { tokenHash: hash },
      include: { grant: { include: { client: true, user: { select: AUTH_USER_SELECT } } } },
    });
  } catch (err) {
    request.log?.error?.({ err: err?.message }, 'mcp token lookup failed');
    return invalid('Unknown access token');
  }
  if (!row || row.kind !== 'access' || !sameHash(row.tokenHash, hash)) return invalid('Unknown access token');
  if (row.revokedAt) return invalid('Access token revoked');
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return invalid('Access token expired');
  if (row.resource !== cfg.resource) return invalid('Access token was issued for another resource');
  const grant = row.grant;
  const user = grant?.user;
  const why = grantUsable(grant, user, cfg, now);
  if (why === 'role not allowed') {
    return { ok: false, status: 403, error: 'insufficient_scope', description: 'MCP access is limited to the agency owner', code: 'MCP_ROLE_NOT_ALLOWED' };
  }
  if (why) return invalid(why);
  if (await isMcpPaused(db)) {
    return { ok: false, status: 503, error: null, description: 'MCP access is paused by the agency owner', code: 'MCP_PAUSED' };
  }
  touchGrant(db, grant, request.log);
  const { user: _u, client, ...grantRow } = grant;
  return { ok: true, ctx: { grant: grantRow, user, client, scope: grant.scope, tokenId: row.id } };
}
