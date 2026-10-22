/**
 * EmDash contract 1.8.0 §39: pure constants and sanitizers for citations (no I/O, safe to import from the webhook
 * validator). Bounds: SEO_CITATION_LIMITS (contract src/constants.mjs).
 */
/** Business listing text (public NAP data, not personal data): control characters stripped and bounded, NOT redacted
 * (redact() would turn the listing's phone number into [phone] and defeat the comparison). */
export function plainText(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return s.length > max ? s.slice(0, max) : s;
}

export const SEO_CITATION_KINDS = Object.freeze(['directory', 'social', 'maps', 'review-site', 'industry-list']);
export const SEO_NAP_STATUSES = Object.freeze(['missing', 'wrong', 'correct', 'unknown']);
export const SEO_CITATION_OS_FIELDS = Object.freeze(['listed', 'nap_status', 'name_seen', 'phone_seen', 'zip_seen', 'hours_seen', 'checks', 'last_checked']);
export const SEO_CITATION_SITE_FIELDS = Object.freeze(['name', 'url', 'kind', 'note', 'utm', 'rank']);
export const SEO_CITATION_CHECK_KEYS = Object.freeze(['name', 'phone', 'zip', 'hours', 'areas', 'site_link']);
export const SEO_CITATION_LIMITS = Object.freeze({ rows: 200, upsertItems: 50, id: 100, name: 120, url: 2048, note: 1000, seen: 200, utm: 300, eventChanges: 20 });
export const CITATION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
/** The scheduled listing monitor (contract osActor kind "system"; osUserId must be a uuid: a fixed one). */
export const SYSTEM_ACTOR = Object.freeze({ kind: 'system', osUserId: '7d3f2c1a-5b8e-4f60-9a1d-c17a7104e0a5', name: 'Agency OS listing monitor' });

export const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// ── sanitizing (contract shapes → bounded values) ──

const seenStr = (v) => (v == null ? null : typeof v === 'string' ? plainText(v, SEO_CITATION_LIMITS.seen) : null);
export const dateOrNull = (v) => (typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

export function httpsUrl(v) {
  if (typeof v !== 'string' || v.length > SEO_CITATION_LIMITS.url) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function sanitizeChecks(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const k of SEO_CITATION_CHECK_KEYS) out[k] = typeof v[k] === 'boolean' ? v[k] : null;
  return out;
}

/** One seoCitation (contract §39.2) → bounded object, or null when it is not usable (no valid id / name / enums). */
export function sanitizeCitation(raw) {
  if (!isObj(raw)) return null;
  if (typeof raw.id !== 'string' || !CITATION_ID_RE.test(raw.id)) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? plainText(raw.name, SEO_CITATION_LIMITS.name) : null;
  if (!name) return null;
  if (!SEO_CITATION_KINDS.includes(raw.kind) || !SEO_NAP_STATUSES.includes(raw.nap_status)) return null;
  return {
    id: raw.id,
    name,
    url: raw.url == null ? null : httpsUrl(raw.url),
    kind: raw.kind,
    listed: raw.listed === true,
    nap_status: raw.nap_status,
    name_seen: seenStr(raw.name_seen),
    phone_seen: seenStr(raw.phone_seen),
    zip_seen: seenStr(raw.zip_seen),
    hours_seen: seenStr(raw.hours_seen),
    checks: sanitizeChecks(raw.checks),
    last_checked: dateOrNull(raw.last_checked),
    checked_by: raw.checked_by === 'os' ? 'os' : 'human',
    note: typeof raw.note === 'string' ? plainText(raw.note, SEO_CITATION_LIMITS.note) : null,
    utm: typeof raw.utm === 'string' ? plainText(raw.utm, SEO_CITATION_LIMITS.utm) : null,
    rank: Number.isInteger(raw.rank) ? raw.rank : null,
    updated_at: dateOrNull(raw.updated_at),
  };
}

/** A list body ({rev, items}) → { rev, items } (items deduplicated by id, ≤ 200) or null. */
export function sanitizeCitationList(body) {
  if (!isObj(body) || !Number.isInteger(body.rev) || body.rev < 0 || !Array.isArray(body.items)) return null;
  const seen = new Set();
  const items = [];
  for (const raw of body.items.slice(0, SEO_CITATION_LIMITS.rows)) {
    const c = sanitizeCitation(raw);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    items.push(c);
  }
  return { rev: body.rev, items };
}

/** seo.citation_changed data (§39.4) → { data } or { error }. */
export function sanitizeCitationChanged(data) {
  if (!isObj(data)) return { error: 'data is required on seo.citation_changed' };
  if (!Number.isInteger(data.rev) || data.rev < 1) return { error: 'data.rev must be an integer >= 1' };
  if (!['os', 'site-admin'].includes(data.source)) return { error: 'data.source must be os or site-admin' };
  const citation = sanitizeCitation(data.citation);
  if (!citation) return { error: 'data.citation is invalid' };
  if (!Array.isArray(data.changes) || data.changes.length < 1) return { error: 'data.changes must have at least one change' };
  const changes = data.changes
    .slice(0, SEO_CITATION_LIMITS.eventChanges)
    .filter((c) => isObj(c) && typeof c.field === 'string')
    .map((c) => ({ field: c.field.slice(0, 32) }));
  const by = isObj(data.by)
    ? { kind: typeof data.by.kind === 'string' ? data.by.kind.slice(0, 16) : null, osUserId: typeof data.by.osUserId === 'string' ? data.by.osUserId.slice(0, 64) : null, role: typeof data.by.role === 'string' ? data.by.role.slice(0, 32) : null, source: typeof data.by.source === 'string' ? data.by.source.slice(0, 32) : null }
    : null;
  return { data: { rev: data.rev, at: dateOrNull(data.at), source: data.source, by, citation, changes } };
}

/** Envelope check used by the /events validator (returns an error message or null). */
export function validateCitationEvent(ev) {
  if (ev?.type !== 'seo.citation_changed') return null;
  if (ev.snapshotText !== undefined) return 'snapshotText is not allowed on seo.citation_changed';
  if (ev.lead !== undefined) return 'lead is not allowed on seo.citation_changed';
  const r = sanitizeCitationChanged(ev.data);
  return r.error || null;
}
