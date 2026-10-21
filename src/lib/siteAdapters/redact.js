/**
 * Exact port of the contract's src/redact.mjs (oasis-astro packages/os-bridge-contract, v1.6.0 §36.5): the ONE
 * redaction function for security status, backup status, security/backup events and (later) log rows. The OS runs it
 * on ingest after the schema/limit checks (lib/siteAdapters/security.js). Vectors: tests/fixtures/cms-contract/
 * vectors/redact.json (tests/unit/siteAdapters/securityV160.test.js). Keep it byte-for-byte equivalent in behaviour:
 * the site and the OS must produce the same output for the same input.
 */
export const REDACTED = Object.freeze({
  secret: "[secret]",
  email: "[email]",
  phone: "[phone]",
  ip: "[ip]",
  hex: "[hex]",
  value: "[redacted]",
});

/** Ordered rules: secrets first (so a token that contains an e-mail-like part is removed whole), then PII, then paths. */
const RULES = [
  // Header lines: "Authorization: Bearer …", "Cookie: a=b", "Set-Cookie: …"
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-aos-signature)\s*[:=]\s*[^\n\r]*/gi, (_m, h) => `${h}: ${REDACTED.value}`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/g, (_m, s) => `${s} ${REDACTED.secret}`],
  // Bridge keys, EmDash encryption keys, EmDash API tokens, Resend keys, JWTs
  [/\baosk1_[A-Za-z0-9_-]{8,}/g, REDACTED.secret],
  [/\bemdash_enc_v1_[A-Za-z0-9_-]{8,}/g, REDACTED.secret],
  [/\bec_pat_[A-Za-z0-9_-]{1,}/g, REDACTED.secret],
  [/\bre_[A-Za-z0-9_]{16,}/g, REDACTED.secret],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, REDACTED.secret],
  // Secret query parameters (preview tokens, review links, generic token/key)
  [/([?&](?:_preview|t|agency_review|token|key|sig|signature)=)[^&#\s"']+/gi, (_m, p) => `${p}${REDACTED.value}`],
  // PII
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, REDACTED.email],
  [/(?<![\w.:/-])\+\d{8,15}(?![\w.])/g, REDACTED.phone],
  [/(?<![\w.:/-])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}(?![\w.])/g, REDACTED.phone],
  [/(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])/g, REDACTED.ip],
  [/(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])/gi, REDACTED.ip],
  [/(?<![\w:])(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?(?![\w:])/gi, REDACTED.ip],
  [/(?<![\w:])::(?:[0-9a-f]{1,4})(?::[0-9a-f]{1,4}){0,6}(?![\w:])/gi, REDACTED.ip],
  // Long hex (tokens, session ids, hashes of secrets). Keys listed in HEX_SAFE_KEYS keep their value.
  [/\b[0-9a-f]{32,}\b/gi, REDACTED.hex],
  // Absolute home paths → ~ (the username never leaves the host)
  [/(?<![\w~])\/[a-z]\/Users\/[^/\s"']+(?=\/|$|[\s"'])/gi, "~"],
  [/\/(?:home|Users|usr\/home)\/[^/\s"']+(?=\/|$|[\s"'])/g, "~"],
  [/\b[A-Za-z]:\\Users\\[^\\\s"']+(?=\\|$|[\s"'])/g, "~"],
];

/** Hex rule only (other rules still apply): values under these keys are content hashes, not secrets. */
export const HEX_SAFE_KEYS = Object.freeze(["sha256", "hash", "prevHash", "lockSha", "commit", "digest", "integrity", "draftHash", "contentHash"]);
/** Values under these keys are replaced whole, whatever they contain. */
export const SECRET_KEY_PATTERN = /^(?:password|passphrase|pass|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|secret[_-]?key|authorization|cookie|set-cookie|session|signature|credentials?|email|phone|ip|ip[_-]?address|remote[_-]?addr)$/i;

/** @param {string} s @param {{ keepHex?: boolean }} [opts] */
export function redactString(s, { keepHex = false } = {}) {
  let out = String(s);
  for (const [re, rep] of RULES) {
    if (keepHex && rep === REDACTED.hex) continue;
    out = out.replace(re, /** @type {any} */ (rep));
  }
  return out;
}

/**
 * Deep copy with every string redacted. Numbers, booleans and null pass unchanged. Depth > 12 and non-plain values
 * (functions, symbols, class instances other than Date) become "[redacted]".
 * @template T @param {T} value @param {{ keepHexKeys?: readonly string[] }} [opts] @returns {T}
 */
export function redact(value, { keepHexKeys = HEX_SAFE_KEYS } = {}) {
  const keep = new Set(keepHexKeys);
  const walk = (v, key, depth) => {
    if (v === null || typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "string") return redactString(v, { keepHex: key !== null && keep.has(key) });
    if (v instanceof Date) return v.toISOString();
    if (depth > 12) return REDACTED.value;
    if (Array.isArray(v)) return v.map((x) => walk(x, null, depth + 1));
    if (typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (SECRET_KEY_PATTERN.test(k)) out[k] = x === null || x === "" ? x : REDACTED.value;
        else out[k] = walk(x, k, depth + 1);
      }
      return out;
    }
    return v === undefined ? undefined : REDACTED.value;
  };
  return /** @type {any} */ (walk(value, null, 0));
}

const UTF8 = new TextEncoder();
export const jsonBytes = (v) => UTF8.encode(JSON.stringify(v ?? null)).byteLength;

/**
 * Redacted evidence within `maxBytes` (UTF-8 JSON, default 8 KiB, §36.5): long strings are cut first, then arrays,
 * and as a last resort the evidence becomes `{ truncated: true, bytes }`. Always a plain object.
 * @param {unknown} evidence @param {number} [maxBytes]
 */
export function boundEvidence(evidence, maxBytes = 8192) {
  let ev = redact(evidence ?? {});
  if (ev === null || typeof ev !== "object" || Array.isArray(ev)) ev = { value: ev };
  if (jsonBytes(ev) <= maxBytes) return ev;
  const cut = (v, strMax, arrMax) => {
    if (typeof v === "string") return v.length > strMax ? `${v.slice(0, strMax)}…` : v;
    if (Array.isArray(v)) return v.slice(0, arrMax).map((x) => cut(x, strMax, arrMax));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x, strMax, arrMax)]));
    return v;
  };
  for (const [s, a] of [[500, 50], [200, 20], [80, 8]]) {
    const c = { ...cut(ev, s, a), truncated: true };
    if (jsonBytes(c) <= maxBytes) return c;
  }
  return { truncated: true, bytes: jsonBytes(ev) };
}
