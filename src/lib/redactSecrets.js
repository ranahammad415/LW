/**
 * Response-wide secret redaction (e2e O21). The API serializes with plain JSON.stringify (index.js), so route
 * response schemas do NOT filter fields: any route that returns a Project row (e.g. GET /api/tasks includes the
 * full project of every task) would send the WordPress plugin key. This preSerialization pass is the safety net:
 * - `wpApiKey` (any object): a non-null value becomes "[REDACTED]";
 * - CMS credential / pairing-code secrets (encrypted keys, verifier, signing key) are removed.
 * Routes should still select only what they need; this only guarantees these values never leave the API.
 */
const REDACT_KEYS = new Set(['wpApiKey']);
const DROP_KEYS = new Set([
  'inboundKeyEnc',
  'outboundKeyEnc',
  'inboundKeyPrevEnc',
  'outboundKeyPrevEnc',
  'inboundKeyPendingEnc',
  'outboundKeyPendingEnc',
  'signingKeyEnc',
  'verifier',
  // API token hashes (lib/apiTokens.js) never leave the API, not even to OWNER admin views.
  'tokenHash',
  // Agency Google refresh token (encrypted) never leaves the API either (SEO Engine OS-16 hardening).
  'refreshTokenEnc',
  // Agency Bing Webmaster credential (features/bing-webmaster.md): the encrypted API key and the Phase 3 OAuth token.
  'apiKeyEnc',
  'accessTokenEnc',
  // Remote MCP server: authorization-code and client-secret hashes (src/mcp/oauth/*).
  'codeHash',
  'clientSecretHash',
]);
export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 12;

function isPlainObject(v) {
  if (!v || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * The PM preview link is a token-only capability that can approve the PM stage: clients must never receive it. Dropped
 * from every response to a CLIENT user and from every /api/client/* response (also an OWNER acting through X-Client-Id).
 * `costUsd` (vendor cost of site-metrics snapshots, lib/backlinkSnapshots.js) is staff-only for the same audiences.
 */
// Health score v2: staff factor matrices, numeric security scores and security check ids never reach a client audience
// (the client views are allow-lists already; this is the second layer). Site metrics: per-call vendor cost (costUsd).
// Local SEO (features/local-seo.md): Google listing ids, competitor ids, match method, the pending vendor task id and
// sync error text are staff-only too.
export const CLIENT_DROP_KEYS = new Set([
  'pmPreviewUrl',
  'healthFactors',
  'securityScore',
  'checkId',
  'costUsd',
  'gmbCid',
  'gmbPlaceId',
  'gmbFeatureId',
  'gmbReviewsTaskId',
  'gmbSyncError',
  'competitorCid',
  'matchedBy',
  // Bing Webmaster (features/bing-webmaster.md): sync error text, raw crawl-issue flags and URL hashes are staff-only
  // (client views are allow-lists already; this is the second layer).
  'bingSyncError',
  'issuesRaw',
  'urlHash',
]);

/**
 * The agent flag (User.isAgent, SEO Engine OS-01) is server-side only: an agent must look exactly like a human
 * worker everywhere except OWNER admin views. It is dropped from every response except OWNER requests to /api/admin/*.
 */
export const AGENT_FLAG_KEYS = new Set(['isAgent']);
const CLIENT_AND_AGENT_DROP_KEYS = new Set([...CLIENT_DROP_KEYS, ...AGENT_FLAG_KEYS]);

/** True when the request may see the agent flag: an OWNER (not acting as a client) on an /api/admin/* route. */
export function isOwnerAdminAudience(request) {
  return request?.user?.role === 'OWNER' && String(request?.url || '').startsWith('/api/admin/');
}

/** Extra keys to drop for this request's audience (used by the global preSerialization hook). */
export function responseDropKeys(request) {
  if (isClientAudience(request)) return CLIENT_AND_AGENT_DROP_KEYS;
  return isOwnerAdminAudience(request) ? null : AGENT_FLAG_KEYS;
}

/** True when this response goes to a client audience. */
export function isClientAudience(request) {
  return request?.user?.role === 'CLIENT' || String(request?.url || '').startsWith('/api/client/');
}

/**
 * Returns the payload with secrets redacted. Copies only the branches that change; never mutates the input.
 * `extraDrop` (a Set of keys) is removed too, e.g. CLIENT_DROP_KEYS for client audiences.
 */
export function redactResponseSecrets(value, depth = 0, extraDrop = null) {
  if (depth > MAX_DEPTH || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let out = null;
    for (let i = 0; i < value.length; i += 1) {
      const next = redactResponseSecrets(value[i], depth + 1, extraDrop);
      if (next !== value[i]) {
        if (!out) out = value.slice();
        out[i] = next;
      }
    }
    return out || value;
  }
  if (!isPlainObject(value)) return value;
  let out = null;
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (DROP_KEYS.has(key) || extraDrop?.has(key)) {
      if (!out) out = { ...value };
      delete out[key];
      continue;
    }
    if (REDACT_KEYS.has(key)) {
      if (v != null && v !== REDACTED) {
        if (!out) out = { ...value };
        out[key] = REDACTED;
      }
      continue;
    }
    const next = redactResponseSecrets(v, depth + 1, extraDrop);
    if (next !== v) {
      if (!out) out = { ...value };
      out[key] = next;
    }
  }
  return out || value;
}
