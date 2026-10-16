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
]);
export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 12;

function isPlainObject(v) {
  if (!v || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Returns the payload with secrets redacted. Copies only the branches that change; never mutates the input. */
export function redactResponseSecrets(value, depth = 0) {
  if (depth > MAX_DEPTH || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let out = null;
    for (let i = 0; i < value.length; i += 1) {
      const next = redactResponseSecrets(value[i], depth + 1);
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
    if (DROP_KEYS.has(key)) {
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
    const next = redactResponseSecrets(v, depth + 1);
    if (next !== v) {
      if (!out) out = { ...value };
      out[key] = next;
    }
  }
  return out || value;
}
