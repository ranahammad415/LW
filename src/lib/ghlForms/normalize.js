/**
 * GoHighLevel (LeadConnector) form webhook → one normalised lead (pure; no I/O).
 * Source of truth: oasis-astro docs/leads/embedded-form-architecture.md §4.3 and contract.md §40.6 (the body the site
 * team pins in the GHL workflow, `v: 1`), plus GHL's default "Webhook" action payload (contact fields at the root,
 * custom fields by name at the root or under `customData`).
 *
 * Rules:
 * - A value that is still a merge tag (`{{contact.x}}`, GHL leaves unresolved fields as the literal) is empty.
 * - `oa_sid` / `oa_vid` count only with the server-minted shapes; `ref_class` only from REF_CLASSES; `landing` / `page`
 *   only as site paths (query string and fragment dropped: they may hold personal data).
 * - Every non-PII string goes through redact(); the PII block (`fields`) is kept as typed (it is the lead) and lives only
 *   in CmsLead.fields. Nothing here logs, and error reasons never contain a value.
 * - Bounds as lead.created (contract §26.1) / LEAD_IMPORT_LIMITS (§40.5).
 */
import crypto from 'node:crypto';
import { redactString } from '../siteAdapters/redact.js';
import { REF_CLASSES, isSessionId, isVisitorId } from '../signals/validate.js';

export const GHL_PROVIDER = 'ghl';
/** The site's id of the embedded GoHighLevel form when site-info does not name one (contract §40.1 example). */
export const DEFAULT_GHL_SITE_FORM_ID = 'ghl-contact';
export const GHL_PLACEMENT = 'embedded_form';
export const GHL_LIMITS = Object.freeze({ name: 200, phone: 40, email: 254, town: 100, postalCode: 20, message: 2000, extraKeys: 20, extraValue: 500, heardFrom: 100, formName: 200, id: 64, path: 500, utm: 200, source: 64, campaign: 200 });

const MERGE_TAG_RE = /^\{\{[\s\S]*\}\}$/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9._-]*$/;
const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A form value as text: trimmed, control characters removed; an unresolved merge tag or a non-scalar is ''. */
export function val(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return '';
  const s = v.replace(CONTROL_RE, '').trim();
  return MERGE_TAG_RE.test(s) ? '' : s;
}
const cut = (s, max) => (s ? s.slice(0, max) : null);
const id = (v) => {
  const s = val(v);
  return ID_RE.test(s) ? s : null;
};

/** Site path only: "/x/y/" (no scheme, no "//host", query and fragment dropped). */
export function sitePath(v) {
  const s = val(v);
  if (!s.startsWith('/') || s.startsWith('//')) return null;
  const p = s.split('#')[0].split('?')[0];
  return p ? redactString(p).slice(0, GHL_LIMITS.path) : null;
}

function sourceKey(v) {
  const s = val(v).toLowerCase();
  if (!s || s === 'none' || s.length > GHL_LIMITS.source || !SOURCE_RE.test(s)) return null;
  return s;
}

const keyNorm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** A custom field of the default payload: by exact key at the root / under customData, else by normalised label. */
function custom(body, keys) {
  const pools = [body, isObj(body.customData) ? body.customData : null, isObj(body.custom_data) ? body.custom_data : null].filter(Boolean);
  for (const pool of pools) for (const k of keys) if (val(pool[k])) return val(pool[k]);
  const wanted = new Set(keys.map(keyNorm));
  for (const pool of pools) for (const [k, v] of Object.entries(pool)) if (wanted.has(keyNorm(k)) && val(v)) return val(v);
  return '';
}

function date(v) {
  const s = val(v);
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  // GHL sends real dates; anything outside a sane window is ignored (receivedAt is used instead)
  if (t < Date.UTC(2015, 0, 1) || t > Date.now() + 86_400_000) return null;
  return new Date(t);
}

/** Stable JSON (sorted keys) for hashing. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Which shape the body has: 'pinned' (our v: 1 body), 'default' (GHL's Webhook action) or null. */
export function ghlShape(body) {
  if (!isObj(body)) return null;
  if ((body.v === 1 || body.v === '1') && (isObj(body.fields) || isObj(body.contact) || isObj(body.attribution))) return 'pinned';
  const rootKeys = ['first_name', 'last_name', 'full_name', 'name', 'email', 'phone', 'contact_id'];
  if (rootKeys.some((k) => k in body) || isObj(body.customData) || isObj(body.custom_data)) return 'default';
  return null;
}

function pinnedRaw(body) {
  const f = isObj(body.fields) ? body.fields : {};
  const a = isObj(body.attribution) ? body.attribution : {};
  const u = isObj(a.utm) ? a.utm : {};
  return {
    formId: body.form?.id,
    formName: body.form?.name,
    contactId: body.contact?.id,
    createdAt: body.contact?.createdAt,
    locationId: body.location?.id,
    name: val(f.name) || [val(f.firstName), val(f.lastName)].filter(Boolean).join(' '),
    email: val(f.email),
    phone: val(f.phone),
    city: val(f.city),
    state: val(f.state),
    postalCode: val(f.postalCode),
    message: val(f.message),
    source: val(f.source),
    heardFrom: val(f.heardFrom) || val(f.heard_from),
    sid: a.oa_sid,
    vid: a.oa_vid,
    refClass: a.ref_class,
    aiSource: a.ai_source,
    refSource: a.source,
    campaign: a.campaign,
    landing: a.landing,
    page: a.page,
    utm: Object.fromEntries(UTM_KEYS.map((k) => [k, u[k]])),
  };
}

function defaultRaw(body) {
  const c = (...keys) => custom(body, keys);
  return {
    formId: c('form_id', 'formId') || (isObj(body.form) ? val(body.form.id) : ''),
    formName: c('form_name', 'formName') || (isObj(body.form) ? val(body.form.name) : ''),
    contactId: val(body.contact_id) || val(body.contactId) || c('contact_id'),
    createdAt: val(body.date_created) || val(body.dateAdded),
    locationId: isObj(body.location) ? val(body.location.id) : val(body.location_id),
    name: val(body.full_name) || val(body.name) || [val(body.first_name), val(body.last_name)].filter(Boolean).join(' '),
    email: val(body.email),
    phone: val(body.phone),
    city: val(body.city),
    state: val(body.state),
    postalCode: val(body.postal_code) || val(body.postalCode),
    message: c('message', 'your_message', 'comments'),
    source: val(body.contact_source) || val(body.source),
    heardFrom: c('heard_from', 'heardFrom', 'How did you hear about us?'),
    sid: c('oa_sid'),
    vid: c('oa_vid'),
    refClass: c('oa_ref_class'),
    aiSource: c('oa_ai_source'),
    refSource: c('oa_source'),
    campaign: c('oa_campaign'),
    landing: c('oa_landing'),
    page: c('oa_page'),
    utm: Object.fromEntries(UTM_KEYS.map((k) => [k, c(`utm_${k}`)])),
  };
}

/**
 * body → `{ lead }` or `{ error }` (a fixed, non-PII reason: unknown_shape | empty).
 * lead = { shape, form: { id, name }, contactId, locationId, createdAt, fields, heardFrom, attribution, payloadHash }.
 */
export function normalizeGhlForm(body) {
  const shape = ghlShape(body);
  if (!shape) return { error: 'unknown_shape' };
  const r = shape === 'pinned' ? pinnedRaw(body) : defaultRaw(body);

  const town = [r.city, r.state].filter(Boolean).join(', ');
  const heardFrom = cut(r.heardFrom, GHL_LIMITS.heardFrom);
  const page = sitePath(r.page);
  const extra = {};
  if (r.source) extra.source = r.source.slice(0, GHL_LIMITS.extraValue);
  if (page) extra.oa_page = page;
  if (heardFrom) extra.heard_from = heardFrom;
  const fields = {
    name: cut(r.name, GHL_LIMITS.name),
    phone: cut(r.phone, GHL_LIMITS.phone),
    email: cut(r.email, GHL_LIMITS.email),
    town: cut(town, GHL_LIMITS.town),
    postalCode: cut(r.postalCode, GHL_LIMITS.postalCode),
    message: cut(r.message, GHL_LIMITS.message),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
  if (!fields.name && !fields.email && !fields.phone && !fields.message) return { error: 'empty' };

  const refClassRaw = val(r.refClass).toLowerCase();
  const refClass = REF_CLASSES.includes(refClassRaw) && refClassRaw !== 'internal' ? refClassRaw : null;
  const utm = {};
  for (const k of UTM_KEYS) {
    const v = val(r.utm?.[k]);
    utm[k] = v ? redactString(v).slice(0, GHL_LIMITS.utm) : null;
  }
  const sid = val(r.sid);
  const vid = val(r.vid);
  const attribution = {
    sessionId: isSessionId(sid) ? sid : null,
    visitorId: isVisitorId(vid) ? vid : null,
    refClass,
    aiSource: refClass === 'ai' ? sourceKey(r.aiSource) : null,
    source: sourceKey(r.refSource),
    campaign: val(r.campaign) ? redactString(val(r.campaign)).slice(0, GHL_LIMITS.campaign) : null,
    landing: sitePath(r.landing),
    page,
    utm: UTM_KEYS.some((k) => utm[k]) ? utm : null,
  };
  const form = { id: id(r.formId), name: val(r.formName) ? redactString(val(r.formName)).slice(0, GHL_LIMITS.formName) : null };
  const contactId = id(r.contactId);
  const payloadHash = sha256(canonical({ formId: form.id, contactId, fields, attribution }));
  return {
    lead: { shape, form, contactId, locationId: id(r.locationId), createdAt: date(r.createdAt), fields, heardFrom, attribution, payloadHash },
  };
}

/**
 * The lastTouch of the "GHL fields" fallback (stored as cookie-only, siteSnapshot.origin = "ghl-fields"): class from
 * oa_ref_class, else from utm like the site's cookie-only rule (cpc / ppc / paid → ads, email, social, other utm →
 * referral), source = oa_ai_source (AI) / oa_source / utm_source. null when nothing is known.
 */
export function touchFromGhlFields(a, at) {
  if (!a) return null;
  const medium = (a.utm?.medium || '').toLowerCase();
  let cls = a.refClass;
  if (!cls && a.utm) {
    if (/(^|[^a-z])(cpc|ppc|paid|paidsearch|paid_social|display)([^a-z]|$)/.test(medium)) cls = 'ads';
    else if (medium === 'email') cls = 'email';
    else if (medium === 'social' || medium === 'social-media') cls = 'social';
    else cls = 'referral';
  }
  if (!cls) return null;
  const source = a.aiSource || a.source || sourceKey(a.utm?.source) || (cls === 'direct' ? 'none' : 'unknown');
  return {
    at: new Date(at).toISOString(),
    class: cls,
    source,
    campaign: a.campaign || a.utm?.campaign || null,
    medium: a.utm?.medium || null,
    landing: a.landing || null,
  };
}

/**
 * Staff deep link to the contact (contract §40 example: https://<white-label host>/v2/location/<id>/contacts/detail/<id>).
 * Host from GHL_APP_HOST (validated host name), default app.gohighlevel.com. null without both ids.
 */
export function ghlContactUrl(locationId, contactId, env = process.env) {
  if (!locationId || !contactId || !ID_RE.test(locationId) || !ID_RE.test(contactId)) return null;
  const raw = String(env.GHL_APP_HOST || '').trim().toLowerCase();
  const host = /^[a-z0-9.-]{3,253}$/.test(raw) && raw.includes('.') ? raw : 'app.gohighlevel.com';
  return `https://${host}/v2/location/${locationId}/contacts/detail/${contactId}`.slice(0, 500);
}
