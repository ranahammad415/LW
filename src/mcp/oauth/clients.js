/**
 * Dynamic client registration (RFC 7591) for MCP connectors, and client authentication at the token endpoint.
 * Redirect policy: absolute URIs only; https, or http only for loopback hosts; the host (or a parent domain) must be
 * in MCP_REDIRECT_HOST_ALLOWLIST; no fragments, no wildcards; at most 10 URIs. A secret is issued only for the
 * client_secret_post / client_secret_basic auth methods (stored as sha256).
 */
import { generateSecret, sameHash, sha256Hex } from './tokens.js';
import { MCP_SCOPES } from '../config.js';
import { publicJsonHeaders } from './metadata.js';

const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];
const GRANT_TYPES = ['authorization_code', 'refresh_token'];
const MAX_URIS = 10;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostAllowed(host, allowlist) {
  const h = String(host || '').toLowerCase();
  return allowlist.some((a) => h === a || h.endsWith(`.${a}`));
}

/** Policy check for one redirect URI. Returns null when allowed, else the reason. */
export function checkRedirectUri(uri, cfg) {
  if (typeof uri !== 'string' || !uri || uri.length > 500) return 'redirect_uri must be a string of at most 500 characters';
  if (uri.includes('*')) return 'wildcards are not allowed in redirect_uri';
  let u;
  try {
    u = new URL(uri);
  } catch {
    return 'redirect_uri must be an absolute URL';
  }
  if (u.hash || uri.includes('#')) return 'redirect_uri must not have a fragment';
  if (u.username || u.password) return 'redirect_uri must not carry credentials';
  if (u.protocol === 'http:') {
    if (!LOOPBACK.has(u.hostname)) return 'http redirect_uri is only allowed for localhost';
  } else if (u.protocol !== 'https:') {
    return 'redirect_uri must use https';
  }
  if (!hostAllowed(u.hostname, cfg.redirectHosts)) return `redirect host ${u.hostname} is not allowed`;
  return null;
}

function str(v, max) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

function optionalUrl(v) {
  const s = str(v, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
}

/**
 * Validates an RFC 7591 registration body. Returns { ok:true, value } or { ok:false, error, description }.
 * Unknown fields are ignored.
 */
export function validateRegistration(body, cfg) {
  const fail = (description, error = 'invalid_client_metadata') => ({ ok: false, error, description });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Body must be a JSON object');
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return fail('redirect_uris is required', 'invalid_redirect_uri');
  if (uris.length > MAX_URIS) return fail(`At most ${MAX_URIS} redirect_uris`, 'invalid_redirect_uri');
  for (const uri of uris) {
    const why = checkRedirectUri(uri, cfg);
    if (why) return fail(why, 'invalid_redirect_uri');
  }
  const method = body.token_endpoint_auth_method ?? 'none';
  if (!AUTH_METHODS.includes(method)) return fail('Unsupported token_endpoint_auth_method');
  const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grantTypes) || grantTypes.length === 0 || grantTypes.some((g) => !GRANT_TYPES.includes(g))) {
    return fail('grant_types may only contain authorization_code and refresh_token');
  }
  const responseTypes = body.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || responseTypes.length === 0 || responseTypes.some((r) => r !== 'code')) {
    return fail('response_types may only contain code');
  }
  let scope = null;
  if (body.scope !== undefined) {
    if (typeof body.scope !== 'string') return fail('scope must be a string');
    const parts = body.scope.split(/\s+/).filter(Boolean);
    if (parts.some((p) => !MCP_SCOPES.includes(p))) return fail('Unsupported scope');
    scope = parts.join(' ') || null;
  }
  const clientName = str(body.client_name, 100) || 'MCP client';
  return {
    ok: true,
    value: {
      clientName,
      redirectUris: [...new Set(uris)],
      tokenEndpointAuthMethod: method,
      grantTypes: [...new Set(grantTypes)],
      responseTypes: ['code'],
      scope,
      clientUri: optionalUrl(body.client_uri),
      logoUri: optionalUrl(body.logo_uri),
      softwareId: str(body.software_id, 100),
      softwareVersion: str(body.software_version, 50),
    },
  };
}

/** RFC 7591 response body for a stored client (+ the plaintext secret once, when one was issued). */
export function registrationResponse(row, secret = null) {
  const out = {
    client_id: row.id,
    client_id_issued_at: Math.floor(new Date(row.createdAt || Date.now()).getTime() / 1000),
    client_name: row.clientName,
    redirect_uris: row.redirectUris,
    grant_types: row.grantTypes,
    response_types: row.responseTypes,
    token_endpoint_auth_method: row.tokenEndpointAuthMethod,
  };
  if (row.scope) out.scope = row.scope;
  if (row.clientUri) out.client_uri = row.clientUri;
  if (row.logoUri) out.logo_uri = row.logoUri;
  if (row.softwareId) out.software_id = row.softwareId;
  if (row.softwareVersion) out.software_version = row.softwareVersion;
  if (secret) {
    out.client_secret = secret;
    out.client_secret_expires_at = 0;
  }
  return out;
}

/** Client credentials from the request: HTTP Basic (client_secret_basic) or the body (client_secret_post / none). */
export function readClientCredentials(request) {
  const auth = request.headers?.authorization;
  if (typeof auth === 'string' && auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i > 0) {
        return { clientId: decodeURIComponent(decoded.slice(0, i)), clientSecret: decodeURIComponent(decoded.slice(i + 1)), method: 'client_secret_basic' };
      }
    } catch {
      /* fall through */
    }
    return { clientId: null, clientSecret: null, method: 'invalid' };
  }
  const body = request.body || {};
  const clientId = typeof body.client_id === 'string' ? body.client_id : null;
  const clientSecret = typeof body.client_secret === 'string' ? body.client_secret : null;
  return { clientId, clientSecret, method: clientSecret ? 'client_secret_post' : 'none' };
}

/**
 * Loads and authenticates the calling client. Public clients ('none') need only a known, enabled id; confidential
 * ones must present their secret with the method they registered.
 */
export async function authenticateClient(db, request) {
  const creds = readClientCredentials(request);
  if (!creds.clientId || creds.method === 'invalid') return { ok: false, error: 'invalid_client', description: 'Client authentication failed' };
  const client = await db.mcpClient.findUnique({ where: { id: creds.clientId } });
  if (!client || client.disabledAt) return { ok: false, error: 'invalid_client', description: 'Unknown or disabled client' };
  if (client.tokenEndpointAuthMethod !== 'none') {
    if (!creds.clientSecret || !client.clientSecretHash || !sameHash(sha256Hex(creds.clientSecret), client.clientSecretHash)) {
      return { ok: false, error: 'invalid_client', description: 'Client authentication failed' };
    }
  }
  return { ok: true, client };
}

export async function registerRoute(app, { cfg, db }) {
  app.post(
    '/api/mcp/oauth/register',
    { config: { cors: false, rateLimit: { max: 10, timeWindow: '1 hour' } }, bodyLimit: 16_384 },
    async (request, reply) => {
      publicJsonHeaders(reply);
      const parsed = validateRegistration(request.body, cfg);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error, error_description: parsed.description });
      const secret = parsed.value.tokenEndpointAuthMethod === 'none' ? null : generateSecret('mcps_');
      const row = await db.mcpClient.create({
        data: { ...parsed.value, clientSecretHash: secret ? sha256Hex(secret) : null, registrationIp: request.ip || null },
      });
      request.log?.info?.(
        { mcpClientId: row.id, clientName: row.clientName, redirectHosts: row.redirectUris.map((u) => new URL(u).host), ip: request.ip },
        'MCP client registered'
      );
      return reply.code(201).send(registrationResponse(row, secret));
    }
  );
}
