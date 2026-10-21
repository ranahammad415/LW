/**
 * HMAC signing for the EmDash bridge, contract `agency-os-bridge/v1` §3
 * (source of truth: oasis-astro packages/os-bridge-contract/contract.md + src/sign.mjs).
 * Node crypto port of the contract's Web Crypto reference; the test vectors in
 * tests/unit/siteAdapters/signing.test.js must keep passing byte for byte.
 *
 * Canonical request string (UTF-8, "\n" joined, no trailing newline):
 *   v1\n<METHOD>\n<path>\n<timestamp>\n<nonce>\n<sha256hex(rawBody)>
 * Canonical response string (handshake responses):
 *   v1-response\n<HTTP status>\n<request path>\n<request nonce>\n<response timestamp>\n<sha256hex(rawBody)>
 * <path> is exactly what the sender put on the request line: no query string, no
 * normalisation. <rawBody> is the exact bytes on the wire, hashed BEFORE JSON parsing.
 * The HMAC key is the UTF-8 bytes of the secret string as issued ("aosk1_…").
 */
import crypto from 'node:crypto';

export const CONTRACT_NAME = 'agency-os-bridge';
export const CONTRACT_VERSION = 1;
/** Errata level implemented by this OS (informational; X-AOS-Contract stays 1). */
export const CONTRACT_REVISION = '1.5.9';

/**
 * True when the site's reported errata level (site-info / handshake `contractRevision`, e.g. "1.5.4") is at least
 * `min`. Numeric per part (1.10 > 1.9); a missing or malformed revision is below everything.
 */
export function revisionAtLeast(revision, min) {
  const parse = (v) => (typeof v === 'string' && /^\d+(\.\d+){0,3}$/.test(v) ? v.split('.').map(Number) : null);
  const a = parse(revision);
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}
export const SUPPORTED_CONTRACTS = Object.freeze([1]);
export const PLUGIN_ID = 'agency-os-bridge';
export const SITE_ROUTE_PREFIX = '/_emdash/api/plugins/agency-os-bridge/';
export const OS_ENDPOINTS = Object.freeze({
  handshake: '/api/webhooks/emdash/handshake',
  events: '/api/webhooks/emdash/events',
});

export const HEADERS = Object.freeze({
  contract: 'x-aos-contract',
  site: 'x-aos-site',
  keyId: 'x-aos-key-id',
  timestamp: 'x-aos-timestamp',
  nonce: 'x-aos-nonce',
  signature: 'x-aos-signature',
  idempotencyKey: 'x-aos-idempotency-key',
  idempotentReplay: 'x-aos-idempotent-replay',
  responseKeyId: 'x-aos-response-key-id',
  responseTimestamp: 'x-aos-response-timestamp',
  responseSignature: 'x-aos-response-signature',
});

export const MAX_SKEW_SEC = 300;
export const NONCE_TTL_SEC = 600;
export const KEY_ROTATION_OVERLAP_SEC = 86_400;
export const PAIRING_CODE_TTL_SEC = 900;
export const PAIRING_MAX_FAILED_ATTEMPTS = 5;
export const MAX_EVENTS_BODY_BYTES = 1024 * 1024;
export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_SNAPSHOT_CHARS = 100_000;
export const PAIRING_KEY_ID = 'pairing';
export const PAIR_SIGN_LABEL = 'aos-pair-sign-v1:';
export const PAIR_STORE_LABEL = 'aos-pair-store-v1:';

const SITE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const SIG_RE = /^v1=([0-9a-f]{64})$/;
const TS_RE = /^[0-9]{1,12}$/;

function toBuffer(data) {
  if (data == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new TypeError('body must be a string or bytes (sign the raw bytes, never re-serialised JSON)');
}

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(toBuffer(data)).digest('hex');
}

export function hmacHex(secret, message) {
  return crypto.createHmac('sha256', toBuffer(secret)).update(toBuffer(message)).digest('hex');
}

/** Constant-time string compare (length leak only). */
export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** New HMAC key: "aosk1_" + base64url(32 random bytes) (49 chars). */
export function generateKey() {
  return `aosk1_${base64url(crypto.randomBytes(32))}`;
}

export function generateNonce() {
  return crypto.randomUUID();
}

/** OS-issued site id: "site_" + 16 base64url chars (matches [A-Za-z0-9_-]{8,64}). */
export function generateSiteId() {
  return `site_${base64url(crypto.randomBytes(12))}`;
}

export function isValidSiteId(siteId) {
  return typeof siteId === 'string' && SITE_ID_RE.test(siteId);
}

/** One-time pairing code: "aos1.<siteId>.<base64url(32 random bytes)>". */
export function createPairingCode(siteId) {
  if (!isValidSiteId(siteId)) throw new Error('siteId must match [A-Za-z0-9_-]{8,64}');
  return `aos1.${siteId}.${base64url(crypto.randomBytes(32))}`;
}

export function parsePairingCode(code) {
  const m = /^aos1\.([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{43})$/.exec(String(code ?? '').trim());
  return m ? { siteId: m[1], code: m[0] } : null;
}

/** hex(HMAC-SHA256(key = UTF-8(code), msg = "aos-pair-sign-v1:" + siteId)), used as a string key. */
export function pairingSigningKey(code) {
  const parsed = parsePairingCode(code);
  if (!parsed) throw new Error('Malformed pairing code');
  return hmacHex(parsed.code, PAIR_SIGN_LABEL + parsed.siteId);
}

/** hex(SHA-256("aos-pair-store-v1:" + code)): stored for single-use bookkeeping; never an HMAC key. */
export function pairingVerifier(code) {
  return sha256Hex(PAIR_STORE_LABEL + String(code).trim());
}

export function canonicalString({ method, path, timestamp, nonce, body }) {
  if (!method || !path || timestamp == null || !nonce) throw new Error('method, path, timestamp and nonce are required');
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new Error('path must start with / and carry no query string');
  }
  return ['v1', String(method).toUpperCase(), path, String(timestamp), nonce, sha256Hex(body)].join('\n');
}

export function computeSignature(secret, canonical) {
  // An empty/missing key would still produce an HMAC; refuse it (review S7).
  if (secret == null || (typeof secret === 'string' && secret.length === 0) || (Buffer.isBuffer(secret) && secret.length === 0)) {
    throw new Error('Refusing to sign with a missing or empty key');
  }
  return hmacHex(secret, canonical);
}

/** Signed headers (lower-case names) for one request. */
export function signRequest({
  secret,
  keyId,
  siteId,
  method = 'POST',
  path,
  body = '',
  timestamp = Math.floor(Date.now() / 1000),
  nonce = generateNonce(),
  contract = CONTRACT_VERSION,
  idempotencyKey,
}) {
  if (!secret) throw new Error('secret is required');
  const canonical = canonicalString({ method, path, timestamp, nonce, body });
  const headers = {
    'content-type': 'application/json',
    [HEADERS.contract]: String(contract),
    [HEADERS.site]: String(siteId),
    [HEADERS.keyId]: String(keyId),
    [HEADERS.timestamp]: String(timestamp),
    [HEADERS.nonce]: nonce,
    [HEADERS.signature]: `v1=${computeSignature(secret, canonical)}`,
  };
  if (idempotencyKey) headers[HEADERS.idempotencyKey] = idempotencyKey;
  return headers;
}

/** Path as signed for an absolute URL: pathname verbatim (WHATWG keeps percent-encoding). Throws on a query. */
export function signedPathFor(url) {
  const u = new URL(url);
  if (u.search || u.hash) throw new Error('Signed requests must not carry a query string or fragment');
  return u.pathname;
}

// ---------------------------------------------------------------- keyrings

/**
 * Secret for a key id from a decrypted ring { current: {id, secret}, prev?: {id, secret, expiresAt(ms)} }.
 * Returns null for an unknown or expired id.
 */
export function resolveKey(ring, keyId, now = Date.now()) {
  if (!ring) return null;
  const id = String(keyId);
  if (ring.current && String(ring.current.id) === id) return ring.current.secret;
  if (ring.prev && String(ring.prev.id) === id && (ring.prev.expiresAt == null || now < ring.prev.expiresAt)) {
    return ring.prev.secret;
  }
  return null;
}

// ---------------------------------------------------------------- verify

function header(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (v !== undefined) return Array.isArray(v) ? v[0] : v;
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) return headers[k];
  return undefined;
}

function fail(status, code, message, details) {
  return { ok: false, status, code, message, ...(details ? { details } : {}) };
}

export const NOT_PAIRED = Symbol('NOT_PAIRED');

/**
 * Verify a signed request (contract §3.2 order):
 * headers → no query → contract → formats → site/key → skew → signature → nonce.
 * The nonce is stored only after the signature verified, so forged requests cannot burn nonces.
 *
 * resolveSecret(siteId, keyId, nowMs) → string (secret) | null (unknown/expired key)
 *   | undefined (unknown site) | NOT_PAIRED (site known, no keys yet → 503).
 * nonceCache.checkAndStore(key, expiresAtMs) → Promise<boolean> (true = fresh).
 */
export async function verifyRequest({
  method,
  path,
  body,
  headers,
  resolveSecret,
  nonceCache,
  now = Date.now(),
  maxSkewSec = MAX_SKEW_SEC,
  nonceTtlSec = NONCE_TTL_SEC,
  supportedContracts = SUPPORTED_CONTRACTS,
}) {
  const h = (n) => header(headers, n);
  const contractRaw = h(HEADERS.contract);
  const siteId = h(HEADERS.site);
  const keyId = h(HEADERS.keyId);
  const ts = h(HEADERS.timestamp);
  const nonce = h(HEADERS.nonce);
  const sig = h(HEADERS.signature);
  const missing = [
    [HEADERS.contract, contractRaw],
    [HEADERS.site, siteId],
    [HEADERS.keyId, keyId],
    [HEADERS.timestamp, ts],
    [HEADERS.nonce, nonce],
    [HEADERS.signature, sig],
  ]
    .filter(([, v]) => v === undefined || v === '')
    .map(([k]) => k);
  if (missing.length) return fail(401, 'BAD_SIGNATURE', 'Missing signature headers', { missing });

  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('?')) {
    return fail(400, 'VALIDATION', 'Signed requests must not carry a query string');
  }

  const contract = Number(contractRaw);
  if (!supportedContracts.includes(contract)) {
    return fail(426, 'CONTRACT_UNSUPPORTED', `Contract ${contractRaw} is not supported`, {
      supported: [...supportedContracts],
    });
  }

  if (!TS_RE.test(ts)) return fail(401, 'STALE_TIMESTAMP', 'Timestamp must be integer unix seconds');
  if (!NONCE_RE.test(nonce)) return fail(401, 'BAD_SIGNATURE', 'Nonce must match [A-Za-z0-9_-]{16,128}');
  const m = SIG_RE.exec(sig);
  if (!m) return fail(401, 'BAD_SIGNATURE', 'Signature header must be v1=<64 lowercase hex>');
  if (!SITE_ID_RE.test(siteId)) return fail(401, 'UNKNOWN_SITE', 'Unknown site');

  const secret = await resolveSecret(siteId, String(keyId), now);
  if (secret === NOT_PAIRED) return fail(503, 'NOT_PAIRED', 'Site is registered but not paired yet');
  if (secret === undefined) return fail(401, 'UNKNOWN_SITE', 'Unknown site');
  if (!secret) return fail(401, 'UNKNOWN_KEY', `Unknown or expired key id ${keyId}`);

  const skew = Math.abs(Math.floor(now / 1000) - Number(ts));
  if (skew > maxSkewSec) {
    return fail(401, 'STALE_TIMESTAMP', `Clock skew ${skew}s exceeds ${maxSkewSec}s`, {
      serverTime: Math.floor(now / 1000),
    });
  }

  const expected = computeSignature(secret, canonicalString({ method, path, timestamp: ts, nonce, body }));
  if (!timingSafeEqualStr(expected, m[1])) {
    // signatureMismatch: well-formed, fresh request whose signature is wrong (pairing burn rule, errata v1.0.1).
    // details.stage "mismatch" (contract v1.0.1 O4): a well-formed, fresh request whose signature is wrong.
    return { ...fail(401, 'BAD_SIGNATURE', 'Signature mismatch', { stage: 'mismatch' }), signatureMismatch: true, siteId, nonceKey: siteId + ':' + nonce };
  }

  const fresh = await nonceCache.checkAndStore(`${siteId}:${nonce}`, now + nonceTtlSec * 1000);
  if (!fresh) return fail(409, 'REPLAY', 'Nonce already used');

  const idempotencyKey = h(HEADERS.idempotencyKey);
  return {
    ok: true,
    siteId,
    keyId: String(keyId),
    contract,
    timestamp: Number(ts),
    nonce,
    secret,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

/** Highest common contract, or null. */
export function negotiateContract(theirs, ours = SUPPORTED_CONTRACTS) {
  const common = (Array.isArray(theirs) ? theirs : []).filter((v) => ours.includes(v));
  return common.length ? Math.max(...common) : null;
}

// ---------------------------------------------------------------- response signing

export function responseCanonicalString({ status, path, requestNonce, timestamp, body }) {
  return ['v1-response', String(status), path, requestNonce, String(timestamp), sha256Hex(body)].join('\n');
}

export function signResponse({ secret, keyId, status, path, requestNonce, body = '', timestamp = Math.floor(Date.now() / 1000) }) {
  const canonical = responseCanonicalString({ status, path, requestNonce, timestamp, body });
  return {
    [HEADERS.responseKeyId]: String(keyId),
    [HEADERS.responseTimestamp]: String(timestamp),
    [HEADERS.responseSignature]: `v1=${computeSignature(secret, canonical)}`,
  };
}

/** Verify a signed response; resolveSecret(keyId) → secret | null. */
export function verifyResponse({ status, path, requestNonce, body, headers, resolveSecret, now = Date.now(), maxSkewSec = MAX_SKEW_SEC }) {
  const keyId = header(headers, HEADERS.responseKeyId);
  const ts = header(headers, HEADERS.responseTimestamp);
  const sig = header(headers, HEADERS.responseSignature);
  if (!keyId || !ts || !sig) return { ok: false, code: 'BAD_SIGNATURE', message: 'Response is not signed' };
  const m = SIG_RE.exec(sig);
  if (!m || !TS_RE.test(ts)) return { ok: false, code: 'BAD_SIGNATURE', message: 'Malformed response signature' };
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > maxSkewSec) {
    return { ok: false, code: 'STALE_TIMESTAMP', message: 'Response timestamp outside skew' };
  }
  const secret = resolveSecret(keyId);
  if (!secret) return { ok: false, code: 'UNKNOWN_KEY', message: `Unknown response key id ${keyId}` };
  const expected = computeSignature(secret, responseCanonicalString({ status, path, requestNonce, timestamp: ts, body }));
  if (!timingSafeEqualStr(expected, m[1])) return { ok: false, code: 'BAD_SIGNATURE', message: 'Response signature mismatch' };
  return { ok: true, keyId };
}

// ---------------------------------------------------------------- errors

/** Error codes → HTTP status and default retryability (contract §9). */
export const ERROR_CODES = Object.freeze({
  VALIDATION: { status: 400, retryable: false },
  BAD_SIGNATURE: { status: 401, retryable: false },
  STALE_TIMESTAMP: { status: 401, retryable: false },
  UNKNOWN_SITE: { status: 401, retryable: false },
  UNKNOWN_KEY: { status: 401, retryable: false },
  PAIRING_CODE_INVALID: { status: 401, retryable: false },
  FORBIDDEN: { status: 403, retryable: false },
  PUBLISH_NOT_ALLOWED: { status: 403, retryable: false },
  HUMAN_ONLY: { status: 403, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  REPLAY: { status: 409, retryable: false },
  /** v1.0.5 §18(a): the review belongs to another siteId (a previous pairing). */
  SITE_MISMATCH: { status: 409, retryable: false },
  /** v1.0.2 C1: the site's counters went backwards (lost storage): re-pair as a new siteId. */
  COUNTER_REGRESSION: { status: 409, retryable: false },
  IDEMPOTENCY_MISMATCH: { status: 409, retryable: false },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, retryable: true },
  CONFLICT_REV: { status: 409, retryable: false },
  INVALID_TRANSITION: { status: 409, retryable: false },
  SLUG_MISMATCH: { status: 409, retryable: false },
  SLUG_CHANGE_FORBIDDEN: { status: 409, retryable: false },
  ALREADY_EXISTS: { status: 409, retryable: false },
  /** v1.2.0 §22 draft push (slug, parent, bylines, locked SEO contract, editor lock). */
  SLUG_TAKEN: { status: 409, retryable: false },
  CONTRACT_LOCKED: { status: 409, retryable: false },
  /** v1.2.1 §23(7): never auto-retried; details.lockedUntil (+ lockedBy when allowed). */
  ENTRY_LOCKED: { status: 409, retryable: false },
  PAYLOAD_TOO_LARGE: { status: 413, retryable: false },
  /** v1.1.0 §21.2: more than 200 client suggestions on one review (all rounds). */
  SUGGESTION_LIMIT: { status: 422, retryable: false },
  UNKNOWN_BLOCK: { status: 422, retryable: false },
  SCHEMA_INVALID: { status: 422, retryable: false },
  PARENT_NOT_FOUND: { status: 422, retryable: false },
  BYLINE_NOT_ALLOWED: { status: 422, retryable: false },
  /** v1.3.0 §24: 409 (was 422 in v1). */
  PUBLISH_BLOCKED: { status: 409, retryable: false },
  CONTRACT_UNSUPPORTED: { status: 426, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  INTERNAL: { status: 500, retryable: true },
  NOT_IMPLEMENTED: { status: 501, retryable: false },
  NOT_PAIRED: { status: 503, retryable: true },
  /** v1.2.0 §22.1: the site's service token is missing or rejected (site admin action). */
  SERVICE_TOKEN_UNAVAILABLE: { status: 503, retryable: false },
  /** v1.5.4 §30.1: EmDash refused the service user's role for this write (token still usable; not retryable). */
  SERVICE_ROLE_INSUFFICIENT: { status: 403, retryable: false },
  /** v1.5.7 §33.1: the site's agent guard refused an operation of an agent (MCP / listed agent user). Never retried. */
  AGENT_NOT_ALLOWED: { status: 403, retryable: false },
  UPSTREAM_UNAVAILABLE: { status: 503, retryable: true },
});

/** Contract error envelope { status, body: { ok:false, error:{code,message,retryable,details?} } }. */
export function errorBody(code, message, details) {
  const def = ERROR_CODES[code] ?? ERROR_CODES.INTERNAL;
  const error = { code: ERROR_CODES[code] ? code : 'INTERNAL', message: message ?? code, retryable: def.retryable };
  if (details !== undefined) error.details = details;
  return { status: def.status, body: { ok: false, error } };
}
