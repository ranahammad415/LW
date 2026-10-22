/**
 * NAP (name, address / ZIP, phone, hours) normalisation and matching for the citations monitor (EmDash contract 1.8.0
 * §39; docs/ledger/features/local-seo.md §Citations). Pure, no I/O.
 *
 * - phone: E.164 (`+15551234567`). A 10-digit number (or 11 digits starting 1) is NANP (+1); a number with a leading
 *   `+` or `00` keeps its country code; anything else is null (not comparable).
 * - zip / address: case and punctuation insensitive, common US street abbreviations expanded (St → street, Ave →
 *   avenue, …), US ZIP compared on its first 5 digits.
 * - name: fuzzy. Tokens (lower case, accents and punctuation removed, "&" → "and", legal suffixes like LLC / Inc
 *   dropped) compared with a Dice coefficient on character bigrams; ≥ NAME_MATCH_MIN (0.85) is a match, or one
 *   token set containing the other when the shorter has ≥ 2 tokens.
 */

export const NAME_MATCH_MIN = 0.85;

const STREET_ABBR = Object.freeze({
  st: 'street', str: 'street', ave: 'avenue', av: 'avenue', blvd: 'boulevard', rd: 'road', dr: 'drive', ln: 'lane',
  ct: 'court', cir: 'circle', pl: 'place', pkwy: 'parkway', hwy: 'highway', trl: 'trail', ter: 'terrace', sq: 'square',
  n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
  ste: 'suite', apt: 'apartment', fl: 'floor', bldg: 'building', mt: 'mount', ft: 'fort',
});
const LEGAL_SUFFIXES = new Set(['llc', 'inc', 'ltd', 'co', 'corp', 'corporation', 'company', 'pllc', 'llp', 'lp']);

const fold = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Phone → E.164 or null. `defaultCountry` only 'US' / 'CA' (NANP) is applied to bare 10-digit numbers. */
export function normalizePhone(raw, { defaultCountry = 'US' } = {}) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const noExt = s.replace(/\s*(?:ext\.?|x|#)\s*\d+\s*$/i, '');
  const intl = /^\s*(\+|00)/.test(noExt);
  const digits = noExt.replace(/\D/g, '');
  if (intl) {
    const d = noExt.trim().startsWith('00') ? digits.slice(2) : digits;
    return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  }
  if (['US', 'CA'].includes(String(defaultCountry).toUpperCase())) {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  }
  return null;
}

/** ZIP / postal code → comparable form (US: 5 digits; otherwise letters and digits only, upper case) or null. */
export function normalizeZip(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  const us = s.match(/^(\d{5})(?:-?\d{4})?$/);
  if (us) return us[1];
  const compact = s.replace(/[^A-Z0-9]/g, '');
  return compact.length >= 3 && compact.length <= 10 ? compact : null;
}

/** First US ZIP (5 digits, optional +4) in a free-text address, or null. */
export function zipFromAddress(address) {
  const m = String(address ?? '').match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}(?:-\d{4})?\b)/);
  return m ? m[1] : null;
}

/** Address → lower-case tokens with abbreviations expanded and punctuation removed, joined by one space. */
export function normalizeAddress(raw) {
  const tokens = fold(raw)
    .replace(/#/g, ' suite ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => STREET_ABBR[t] || t);
  return tokens.join(' ') || null;
}

/** Business name → comparable tokens ("&" → and, legal suffixes and "the" dropped). */
export function nameTokens(raw) {
  return fold(raw)
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t && !LEGAL_SUFFIXES.has(t) && t !== 'the');
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/** Dice coefficient (0–1) on character bigrams of the joined name tokens. */
export function nameSimilarity(a, b) {
  const x = nameTokens(a).join(' ');
  const y = nameTokens(b).join(' ');
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ga = bigrams(x);
  const gb = bigrams(y);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) || 0);
  const total = [...ga.values()].reduce((t, n) => t + n, 0) + [...gb.values()].reduce((t, n) => t + n, 0);
  return total ? (2 * inter) / total : 0;
}

/** Fuzzy name match: similarity ≥ NAME_MATCH_MIN, or the shorter token set (≥ 2 tokens) inside the longer one. */
export function namesMatch(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  if (nameSimilarity(a, b) >= NAME_MATCH_MIN) return true;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return short.length >= 2 && short.every((t) => long.includes(t));
}

export const phonesMatch = (a, b) => {
  const x = normalizePhone(a);
  const y = normalizePhone(b);
  return !!x && x === y;
};

export const zipsMatch = (a, b) => {
  const x = normalizeZip(a);
  const y = normalizeZip(b);
  return !!x && x === y;
};

export const addressesMatch = (a, b) => {
  const x = normalizeAddress(a);
  const y = normalizeAddress(b);
  return !!x && x === y;
};

/** Hours text → comparable (lower case, punctuation and spaces folded; "–"/"to" → "-"). */
export function normalizeHours(raw) {
  const s = fold(raw)
    .replace(/[–—]|\bto\b/g, '-')
    .replace(/\s+/g, '')
    .replace(/[.,;]/g, '');
  return s || null;
}

/**
 * Compare what a listing shows with the canonical NAP. Each check is true / false, or null when either side is
 * unknown. → { checks: {name, phone, zip, hours, areas: null, site_link: null}, napStatus }
 * napStatus: `wrong` when any known check is false; `correct` when name AND phone are true and nothing is false;
 * `unknown` otherwise (not enough seen to tell). The caller decides `missing` (the business is not listed).
 */
export function compareNap(canonical, seen, { compareHours = false } = {}) {
  const c = canonical || {};
  const s = seen || {};
  const cmp = (cv, sv, fn) => (cv == null || cv === '' || sv == null || sv === '' ? null : fn(cv, sv));
  const checks = {
    name: cmp(c.name, s.name, namesMatch),
    phone: cmp(c.phone, s.phone, (a, b) => (normalizePhone(a) && normalizePhone(b) ? phonesMatch(a, b) : null)),
    zip: cmp(c.zip, s.zip, (a, b) => (normalizeZip(a) && normalizeZip(b) ? zipsMatch(a, b) : null)),
    // Hours are recorded (hours_seen) but only judged on request: free-text and vendor timetables rarely format alike,
    // so an automatic compare would mark correct listings `wrong`.
    hours: compareHours ? cmp(c.hours, s.hours, (a, b) => normalizeHours(a) === normalizeHours(b)) : null,
    areas: null,
    site_link: s.siteLink === true ? true : s.siteLink === false ? false : null,
  };
  const known = Object.values(checks).filter((v) => v !== null);
  let napStatus = 'unknown';
  if (known.includes(false)) napStatus = 'wrong';
  else if (checks.name === true && checks.phone === true) napStatus = 'correct';
  return { checks, napStatus };
}
