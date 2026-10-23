/**
 * Token endpoint (authorization_code with PKCE, refresh_token with rotation) and revocation (RFC 7009).
 * Bodies may be application/x-www-form-urlencoded (parsed by the MCP plugin) or JSON.
 * Errors follow RFC 6749 §5.2: 400 { error, error_description } (401 for invalid_client).
 */
import { verifyPkceS256 } from './pkce.js';
import { sameResource } from '../config.js';
import { authenticateClient } from './clients.js';
import { publicJsonHeaders } from './metadata.js';
import { issueTokenPair, revokeGrantAndFamily, revokeTokenByValue, rotateRefreshToken, sameHash, sha256Hex, looksLikeSecret, PREFIX, isMcpPaused } from './tokens.js';
import { AUTH_USER_SELECT } from '../../lib/apiTokens.js';
import { writeAudit } from '../audit.js';
import { clientIp, mcpRateLimit } from '../clientIp.js';

function oauthError(reply, error, description, status = 400) {
  return reply.code(error === 'invalid_client' ? 401 : status).send({ error, error_description: description });
}

/**
 * grant_type=authorization_code. Exported for tests. Returns { ok:true, tokens, grant } or { ok:false, error, description }.
 */
export async function exchangeCode(db, { body, client, cfg, now = new Date() }) {
  const fail = (description, error = 'invalid_grant') => ({ ok: false, error, description });
  const code = body.code;
  if (!looksLikeSecret(code, PREFIX.code)) return fail('Unknown authorization code');
  const hash = sha256Hex(code);
  const row = await db.mcpAuthRequest.findUnique({ where: { codeHash: hash } });
  if (!row || !sameHash(row.codeHash, hash)) return fail('Unknown authorization code');
  if (row.clientId !== client.id) return fail('Code was not issued to this client');
  if (row.status === 'consumed') {
    // Code replay: kill everything issued from it (RFC 6749 §4.1.2).
    if (row.grantId) await revokeGrantAndFamily(db, { grantId: row.grantId, reason: 'code_replay', now });
    return fail('Authorization code already used');
  }
  if (row.status !== 'approved' || !row.grantId) return fail('Authorization code is not valid');
  if (!row.codeExpiresAt || new Date(row.codeExpiresAt).getTime() <= now.getTime()) return fail('Authorization code expired');
  if (body.redirect_uri !== row.redirectUri) return fail('redirect_uri does not match');
  if (!verifyPkceS256(body.code_verifier, row.codeChallenge)) return fail('PKCE verification failed');
  if (body.resource !== undefined && !sameResource(body.resource, row.resource)) return fail('Unknown resource', 'invalid_target');
  const claimed = await db.mcpAuthRequest.updateMany({ where: { id: row.id, status: 'approved' }, data: { status: 'consumed' } });
  if (claimed.count !== 1) {
    await revokeGrantAndFamily(db, { grantId: row.grantId, reason: 'code_replay', now });
    return fail('Authorization code already used');
  }
  const grant = await db.mcpGrant.findUnique({ where: { id: row.grantId }, include: { user: { select: AUTH_USER_SELECT } } });
  if (!grant || grant.revokedAt || !grant.user?.isActive || grant.user.tokenVersion !== grant.userTokenVersion || !cfg.allowedRoles.includes(grant.user.role)) {
    return fail('Grant is no longer valid');
  }
  const tokens = await issueTokenPair(db, { grant, resource: row.resource, cfg, now });
  return { ok: true, tokens, grant };
}

export async function tokenRoutes(app, { cfg, db }) {
  app.post('/api/mcp/oauth/token', { config: { cors: false, rateLimit: mcpRateLimit(60, '15 minutes') }, bodyLimit: 16_384 }, async (request, reply) => {
    publicJsonHeaders(reply);
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const auth = await authenticateClient(db, request);
    if (!auth.ok) return oauthError(reply, auth.error, auth.description);
    const client = auth.client;
    const grantType = body.grant_type;
    if (!(Array.isArray(client.grantTypes) ? client.grantTypes : []).includes(grantType)) {
      return oauthError(reply, 'unauthorized_client', 'grant_type not allowed for this client');
    }
    if (await isMcpPaused(db)) return oauthError(reply, 'temporarily_unavailable', 'MCP access is paused by the agency owner', 503);
    if (grantType === 'authorization_code') {
      const out = await exchangeCode(db, { body, client, cfg });
      if (!out.ok) return oauthError(reply, out.error, out.description);
      return reply.send(out.tokens);
    }
    if (grantType === 'refresh_token') {
      const out = await rotateRefreshToken(db, { raw: body.refresh_token, clientId: client.id, resource: body.resource, cfg });
      if (!out.ok) {
        if (out.reuse) {
          await writeAudit(db, { grantId: out.grantId, userId: out.userId, clientId: client.id, tool: 'oauth.refresh_reuse', danger: 'auth', ok: false, errorCode: 'REFRESH_REUSE', ip: clientIp(request) }, request.log);
        }
        return oauthError(reply, out.error, out.description);
      }
      return reply.send(out.tokens);
    }
    return oauthError(reply, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  });

  app.post('/api/mcp/oauth/revoke', { config: { cors: false, rateLimit: mcpRateLimit(60, '15 minutes') }, bodyLimit: 16_384 }, async (request, reply) => {
    publicJsonHeaders(reply);
    const auth = await authenticateClient(db, request);
    if (!auth.ok) return oauthError(reply, auth.error, auth.description);
    const out = await revokeTokenByValue(db, { raw: request.body?.token, clientId: auth.client.id });
    if (out.revoked) {
      await writeAudit(db, { grantId: out.grantId, userId: out.userId, clientId: auth.client.id, tool: 'oauth.revoke', danger: 'auth', ok: true, args: { kind: out.kind }, ip: clientIp(request) }, request.log);
    }
    return reply.code(200).send({});
  });
}
