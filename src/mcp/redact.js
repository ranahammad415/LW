/**
 * MCP-layer redaction and result shaping (features/mcp-server.md §Audit, limits, redaction).
 * - maskSecretsDeep: second pass over every injected OS response (the global redactResponseSecrets hook already ran).
 * - summarizeArgs: what the audit row keeps of tool arguments (keys, short scalars; secrets and free text/PII masked).
 * - applyFieldsLimit / capResult: `fields` allow-list, `limit` on lists, and the byte cap.
 */
import { redactSensitiveUrl } from '../lib/logRedaction.js';

export const REDACTED = '[REDACTED]';
const SECRET_KEY_RE = /(^|_)(secret|password|passwordHash|token|apiKey|privateKey|clientSecret|refreshToken|accessToken|signature|cookie|tempPassword)$/i;
const SECRET_KEY_CAMEL_RE = /(Secret|Password|PasswordHash|Token|ApiKey|PrivateKey|ClientSecret|RefreshToken|AccessToken|Signature|Cookie)$/;
const KEEP_KEYS = new Set(['tokenPrefix', 'tokenNotice', 'prefix']);
const AUDIT_MASK_RE = /pass|secret|token|key|auth|cookie|email|phone|address|card|ssn|content|description|notes?/i;
const MAX_DEPTH = 14;

export function isSecretKey(key) {
  if (KEEP_KEYS.has(key)) return false;
  return SECRET_KEY_RE.test(key) || SECRET_KEY_CAMEL_RE.test(key);
}

/** Capability-link keys (one-click WordPress logins, staff previews) and one-time codes. */
const LINK_KEY_RE = /^(login|preview|pmPreview|clientPreview|magic)(Url|Link)$/i;
const CODE_KEY_RE = /^(code|pairingCode|pairing_code|oneTimeCode|otp)$/;
/** Error codes stay readable (`HUMAN_ONLY`, `MCP_PAUSED`, `HTTP_403`). */
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]*$/;

/** A string that carries a credential in its query (`?token=`, `agency_token=`, `?t=`, `_preview=`) or path. */
export function maskSensitiveString(s) {
  if (typeof s !== 'string' || !s) return s;
  if (/token=/i.test(s)) return REDACTED;
  return redactSensitiveUrl(s);
}

/**
 * Copy of `value` with every secret-looking key's value replaced by [REDACTED] (null/empty values kept as is), login /
 * preview links and one-time codes masked, and credential-bearing strings (token=, interview links) redacted.
 */
export function maskSecretsDeep(value, depth = 0) {
  if (typeof value === 'string') return maskSensitiveString(value);
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => maskSecretsDeep(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const present = v !== null && v !== undefined && v !== '';
    if (present && (isSecretKey(k) || LINK_KEY_RE.test(k))) out[k] = REDACTED;
    else if (present && CODE_KEY_RE.test(k) && typeof v === 'string' && !ERROR_CODE_RE.test(v)) out[k] = REDACTED;
    else out[k] = maskSecretsDeep(v, depth + 1);
  }
  return out;
}

/**
 * What the human sees in a confirm preview: every non-secret field in full (strings ≤ 500 chars), arrays as their
 * first 10 items + a count, depth ≤ 4; only secret keys / credential strings are masked.
 */
export function previewBody(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    const s = maskSensitiveString(value);
    return s.length > 500 ? `${s.slice(0, 500)}… (${s.length} chars)` : s;
  }
  if (typeof value !== 'object') return value;
  if (depth >= 4) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) {
    const items = value.slice(0, 10).map((v) => previewBody(v, depth + 1));
    if (value.length > 10) items.push(`… and ${value.length - 10} more (${value.length} total)`);
    return items;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = (isSecretKey(k) || LINK_KEY_RE.test(k)) && v !== null && v !== undefined && v !== '' ? REDACTED : previewBody(v, depth + 1);
  }
  return out;
}

/** Audit view of tool arguments: depth ≤ 2, scalars ≤ 80 chars, arrays as "[n items]", sensitive keys masked. */
export function summarizeArgs(args, depth = 0) {
  if (args === null || args === undefined) return null;
  if (typeof args !== 'object') {
    const s = String(args);
    return s.length > 80 ? `${s.slice(0, 80)}…` : typeof args === 'string' ? s : args;
  }
  if (Array.isArray(args)) return `[${args.length} items]`;
  if (depth >= 2) return '{…}';
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (AUDIT_MASK_RE.test(k)) {
      out[k] = v === undefined || v === null ? v : '[masked]';
      continue;
    }
    if (k === 'path' && typeof v === 'string') {
      out[k] = redactSensitiveUrl(v).slice(0, 200);
      continue;
    }
    out[k] = Array.isArray(v) ? `[${v.length} items]` : summarizeArgs(v, depth + 1);
  }
  return out;
}

const LIST_KEYS = ['data', 'items', 'tasks', 'clients', 'projects', 'rows'];

function pick(obj, fields) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const f of fields) if (Object.prototype.hasOwnProperty.call(obj, f)) out[f] = obj[f];
  return out;
}

/**
 * `fields`: allow-list per item for a top-level array or an array under data|items|tasks|clients|projects|rows
 * (a plain object gets its top-level keys picked). `limit` (default 50, max 200) cuts those arrays and adds
 * `truncated: true, total: n`.
 */
export function applyFieldsLimit(body, { fields = null, limit = 50 } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const sel = Array.isArray(fields) && fields.length ? fields.map(String) : null;
  const shapeList = (arr) => {
    const items = sel ? arr.map((x) => pick(x, sel)) : arr;
    return items.length > lim ? { items: items.slice(0, lim), truncated: true, total: items.length } : { items, truncated: false, total: items.length };
  };
  if (Array.isArray(body)) {
    const r = shapeList(body);
    return r.truncated ? { items: r.items, truncated: true, total: r.total } : { items: r.items, total: r.total };
  }
  if (body && typeof body === 'object') {
    const key = LIST_KEYS.find((k) => Array.isArray(body[k]));
    if (key) {
      const r = shapeList(body[key]);
      const out = { ...body, [key]: r.items };
      if (r.truncated) Object.assign(out, { truncated: true, total: r.total });
      return out;
    }
    return sel ? pick(body, sel) : body;
  }
  return body;
}

export const TRUNCATION_NOTE = '… [truncated: use fields/limit or a narrower route]';

/** Serializes `payload`; above maxBytes the text is cut and the note appended. */
export function capResult(payload, maxBytes) {
  const text = JSON.stringify(payload ?? null);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return { text, bytes, truncated: false };
  let cut = Buffer.from(text, 'utf8').subarray(0, Math.max(0, maxBytes - TRUNCATION_NOTE.length - 8)).toString('utf8');
  // Drop a possibly broken trailing multi-byte character.
  cut = cut.replace(/�+$/, '');
  return { text: cut + TRUNCATION_NOTE, bytes, truncated: true };
}
