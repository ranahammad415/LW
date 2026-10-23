/**
 * Contract v1.7.0 §38 (first-party visit signals): strict validation, clamping and redaction of everything the site
 * sends, BEFORE anything is stored.
 *
 * MySQL `createMany({ skipDuplicates: true })` is `INSERT IGNORE`, which silently truncates over-long strings and clamps
 * out-of-range numbers: the database is never the validator. Rules (§38.4 / §38.8):
 *   1. structure: every required key present, ids / enums / patterns / date-times valid, the type's non-null groups
 *      present → otherwise the signal is DROPPED (counted as `rejectedInvalid`);
 *   2. bounds: over-long free text is cut to its SIGNAL_LIMITS length, list items beyond their cap (bot reasons,
 *      pagesBefore) are dropped, an invalid optional scalar becomes null (counted as `clamped`); the rest is kept;
 *   3. the shared redaction pass (siteAdapters/redact.js, port of the contract's redact.mjs) on every string, after
 *      which the ids are checked again (a redacted id drops the signal).
 * Plain text everywhere: the OS renders site strings as text only.
 */
import { redact, redactString } from '../siteAdapters/redact.js';
import { isoOrNull, sanitizeSiteActor } from '../siteAdapters/security.js';

export const SIGNALS_EVENT_TYPES = Object.freeze(['signals.batch', 'signals.erased', 'signals.config_changed']);
/** v1.9.0 §40.3 appended `form_submit` (tier B: an embedded third-party form's submit, browser-reported). */
export const SIGNAL_TYPES = Object.freeze(['visit', 'pageview', 'engagement', 'cta_click', 'form_start', 'vitals', 'lead_submitted', 'lead_attributed', 'form_submit']);
/** v1.9.0 §40.3: signalEvent.lead.provider (optional; absent = the site's own form) and form_submit's heuristic. */
export const LEAD_PROVIDERS = Object.freeze(['emdash', 'ghl']);
export const FORM_SUBMIT_HEURISTICS = Object.freeze(['sticky', 'height']);
/** Stable within contract 1 (never renamed or removed): Health v2 reads it. */
export const REF_CLASSES = Object.freeze(['ai', 'search', 'social', 'referral', 'direct', 'email', 'ads', 'internal', 'unknown']);
export const SIGNAL_CONSENT_SOURCES = Object.freeze(['default-us', 'optout-link', 'gpc', 'config-optin']);
export const SIGNAL_CONSENT_MODES = Object.freeze(['default-on-us', 'optin']);
export const SIGNAL_GEO_DETAILS = Object.freeze(['country', 'region', 'city']);
export const SIGNAL_ATTRIBUTION_MODELS = Object.freeze(['site-snapshot', 'cookie-only', 'os-derived']);
export const SIGNAL_CTA_KINDS = Object.freeze(['phone', 'email', 'directions', 'quote', 'other']);
export const SIGNAL_BOT_REASONS = Object.freeze(['ua_bot', 'webdriver', 'no_accept_language', 'rate', 'verified_bot', 'headless', 'no_cookie']);
export const SIGNAL_UA_FAMILIES = Object.freeze(['chrome-desktop', 'chrome-mobile', 'safari-desktop', 'safari-mobile', 'firefox-desktop', 'firefox-mobile', 'edge-desktop', 'edge-mobile', 'samsung-mobile', 'opera', 'in-app-facebook', 'in-app-instagram', 'in-app-other', 'bot', 'other']);
export const SIGNAL_OS_FAMILIES = Object.freeze(['ios', 'android', 'windows', 'macos', 'linux', 'chromeos', 'other']);
export const SIGNAL_FORM_FACTORS = Object.freeze(['phone', 'tablet', 'desktop', 'other']);
export const SIGNAL_QUERY_KEYS = Object.freeze(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'srsltid', 'ref', 'page', 's']);
export const SIGNAL_CLICK_IDS = Object.freeze(['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid']);
export const SIGNALS_CONFIG_FIELDS = Object.freeze(['enabled', 'consentMode', 'events.engagement', 'events.cta_click', 'events.form_start', 'events.vitals', 'sampling.pageview', 'sampling.engagement', 'geoDetail', 'bufferDays']);
export const SIGNALS_CONFIG_SOURCES = Object.freeze(['os', 'site-admin']);
export const SIGNALS_CONFIG_ROLES = Object.freeze(['OWNER', 'PM']);
export const SIGNALS_ERASE_REASONS = Object.freeze(['subject_request', 'retention', 'other']);
export const SIGNALS_ERASED_REASONS = Object.freeze([...SIGNALS_ERASE_REASONS, 'visitor_reset']);
export const SIGNALS_SUMMARY_REJECTED = Object.freeze(['invalid', 'too_large', 'rate_limited', 'not_ready', 'editor', 'disabled']);
export const SIGNALS_SUMMARY_DROPPED = Object.freeze(['cap', 'age', 'sampled']);
/** Aggregates and explorers exclude sessions at or above this bot score (§38.2). */
export const BOT_THRESHOLD = 70;

/** Contract SIGNAL_LIMITS (§38.8), the parts the OS enforces. */
export const SIGNAL_LIMITS = Object.freeze({
  batchSignals: 100,
  batchBytes: 256 * 1024,
  path: 2048,
  canonical: 2048,
  referrerUrl: 512,
  title: 200,
  queryValue: 200,
  utm: 200,
  tz: 64,
  language: 16,
  country: 2,
  region: 8,
  city: 80,
  cfRay: 40,
  host: 253,
  source: 64,
  campaign: 200,
  botReasons: 8,
  landing: 2048,
  pagesBefore: 20,
  formId: 40,
  placement: 40,
  ctaHref: 512,
  routesPerKeyPerMin: 60,
});

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION_RE = /^s_[0-9A-HJKMNP-TV-Z]{26}$/;
const VISITOR_RE = /^v_[0-9A-HJKMNP-TV-Z]{26}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SITE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const TS_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const IP_HASH_RE = /^[0-9a-f]{16}$/;
const IP_PREFIX_RE = /^(?:\d{1,3}\.\d{1,3}\.\d{1,3}|[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4})$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const REGION_RE = /^[A-Za-z0-9-]{1,8}$/;
const CF_RAY_RE = /^[A-Za-z0-9-]{1,40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const oneOf = (v, list) => (typeof v === 'string' && list.includes(v) ? v : null);
export const isUlid = (v) => typeof v === 'string' && ULID_RE.test(v);
export const isSessionId = (v) => typeof v === 'string' && SESSION_RE.test(v);
export const isVisitorId = (v) => typeof v === 'string' && VISITOR_RE.test(v);
export const isLeadId = (v) => typeof v === 'string' && ID_RE.test(v);
const isDateTime = (v) => typeof v === 'string' && v.length <= 40 && DATE_TIME_RE.test(v) && Number.isFinite(Date.parse(v));
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/**
 * Per-signal bookkeeping: `clamped` counts the fields cut or nulled. Never holds signal content.
 * @typedef {{ clamped: number }} Ctx
 */

/** Free text: strings only, control characters removed, cut to `max`. Non-strings → null (+1 clamp when not null). */
function text(v, max, ctx) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') {
    ctx.clamped += 1;
    return null;
  }
  const s = v.replace(CONTROL_RE, '');
  if (s.length > max) {
    ctx.clamped += 1;
    return s.slice(0, max);
  }
  return s;
}

/** A pattern-checked optional scalar: invalid → null (+1 clamp). */
function pat(v, re, ctx, max = 2048) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.length <= max && re.test(v)) return v;
  ctx.clamped += 1;
  return null;
}

function nullableInt(v, min, max, ctx) {
  if (v === null || v === undefined) return null;
  if (intIn(v, min, max)) return v;
  ctx.clamped += 1;
  return null;
}

/** Site-relative path: required "/" prefix, no fragment; cut to the limit. null when not a path. */
function sitePath(v, max, ctx) {
  if (typeof v !== 'string' || !v.startsWith('/')) return null;
  const s = v.replace(CONTROL_RE, '').split('#')[0];
  if (s.length > max) {
    ctx.clamped += 1;
    return s.slice(0, max);
  }
  return s;
}

function source(v, ctx) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.length <= SIGNAL_LIMITS.source && SOURCE_RE.test(v)) return v;
  ctx.clamped += 1;
  return null;
}

/** signalTouch. null when unusable (missing at/class/source). */
export function sanitizeTouch(t, ctx = { clamped: 0 }) {
  if (!isObj(t)) return null;
  const at = isDateTime(t.at) ? new Date(t.at).toISOString() : null;
  const cls = oneOf(t.class, REF_CLASSES);
  const src = typeof t.source === 'string' && t.source.length <= SIGNAL_LIMITS.source && SOURCE_RE.test(t.source) ? t.source : null;
  if (!at || !cls || !src) return null;
  return {
    at,
    class: cls,
    source: src,
    campaign: text(t.campaign, SIGNAL_LIMITS.campaign, ctx),
    medium: text(t.medium, SIGNAL_LIMITS.utm, ctx),
    landing: t.landing == null ? null : sitePath(t.landing, SIGNAL_LIMITS.landing, ctx),
  };
}

/** leadAttribution (§38.5). null when unusable. */
export function sanitizeLeadAttribution(a, ctx = { clamped: 0 }) {
  if (!isObj(a)) return null;
  const model = oneOf(a.model, SIGNAL_ATTRIBUTION_MODELS);
  if (!model) return null;
  return {
    model,
    firstTouch: sanitizeTouch(a.firstTouch, ctx),
    lastTouch: sanitizeTouch(a.lastTouch, ctx),
    sessionId: isSessionId(a.sessionId) ? a.sessionId : null,
    visitorId: isVisitorId(a.visitorId) ? a.visitorId : null,
    landing: a.landing == null ? null : sitePath(a.landing, SIGNAL_LIMITS.landing, ctx),
    formId: text(a.formId, SIGNAL_LIMITS.formId, ctx),
    placement: text(a.placement, SIGNAL_LIMITS.placement, ctx),
  };
}

/** path { pagesBefore ≤ 20, sessionsBefore, timeToLeadSec, sessionToLeadSec }. */
export function sanitizeLeadPath(p, ctx = { clamped: 0 }) {
  if (!isObj(p)) return null;
  const list = Array.isArray(p.pagesBefore) ? p.pagesBefore : [];
  const pages = [];
  for (const x of list) {
    if (pages.length >= SIGNAL_LIMITS.pagesBefore) {
      ctx.clamped += 1;
      break;
    }
    const path = isObj(x) ? sitePath(x.path, SIGNAL_LIMITS.path, ctx) : null;
    const at = isObj(x) && isDateTime(x.at) ? new Date(x.at).toISOString() : null;
    if (path && at) pages.push({ path, at });
    else ctx.clamped += 1;
  }
  return {
    pagesBefore: pages,
    sessionsBefore: nullableInt(p.sessionsBefore, 0, 1_000_000, ctx),
    timeToLeadSec: nullableInt(p.timeToLeadSec, 0, 2_000_000_000, ctx),
    sessionToLeadSec: nullableInt(p.sessionToLeadSec, 0, 2_000_000_000, ctx),
  };
}

const REQUIRED = ['v', 'siteId', 'eventId', 'type', 'sessionId', 'visitorId', 'ts', 'tsLocal', 'tzOffset', 'tz', 'page', 'referrer', 'utm', 'clickIds', 'attribution', 'device', 'network', 'consent', 'bot', 'lead', 'engagement', 'cta', 'vitals', 'path', 'collector'];
/** Groups that must be objects for a type (schema allOf). */
const NON_NULL = Object.freeze({
  visit: ['page', 'referrer', 'utm', 'clickIds', 'attribution', 'device', 'network'],
  pageview: ['page', 'referrer'],
  engagement: ['page', 'engagement'],
  cta_click: ['page', 'cta'],
  form_start: ['page', 'lead'],
  vitals: ['page', 'vitals'],
  lead_submitted: ['lead'],
  lead_attributed: ['lead', 'attribution', 'path'],
  form_submit: ['page', 'lead'],
});

/**
 * One signalEvent → `{ signal }` (sanitized, redacted, every key present) or `{ error }` (dropped). Pure.
 * `ctx.clamped` counts the fields cut or nulled on the way.
 */
export function sanitizeSignal(e, { siteId = null, ctx = { clamped: 0 } } = {}) {
  if (!isObj(e)) return { error: 'signal must be an object' };
  for (const k of REQUIRED) if (!has(e, k)) return { error: `signal.${k} is required` };
  if (e.v !== 1) return { error: 'signal.v must be 1' };
  if (typeof e.siteId !== 'string' || !SITE_ID_RE.test(e.siteId)) return { error: 'signal.siteId is invalid' };
  if (siteId && e.siteId !== siteId) return { error: 'signal belongs to another siteId' };
  if (!isUlid(e.eventId)) return { error: 'signal.eventId is invalid' };
  const type = oneOf(e.type, SIGNAL_TYPES);
  if (!type) return { error: 'signal.type is invalid' };
  if (!isSessionId(e.sessionId)) return { error: 'signal.sessionId is invalid' };
  if (e.visitorId !== null && !isVisitorId(e.visitorId)) return { error: 'signal.visitorId is invalid' };
  if (!isDateTime(e.ts)) return { error: 'signal.ts is invalid' };
  for (const g of NON_NULL[type]) if (!isObj(e[g])) return { error: `signal.${g} is required for ${type}` };
  // consent / bot / collector are always objects
  if (!isObj(e.consent) || typeof e.consent.analytics !== 'boolean' || !oneOf(e.consent.source, SIGNAL_CONSENT_SOURCES)) return { error: 'signal.consent is invalid' };
  if (!isObj(e.bot) || !intIn(e.bot.score, 0, 100) || !Array.isArray(e.bot.reason)) return { error: 'signal.bot is invalid' };
  if (!isObj(e.collector) || typeof e.collector.server !== 'string' || !SEMVER_RE.test(e.collector.server)) return { error: 'signal.collector is invalid' };
  // session-only rule (§38.6): no analytics consent ⇒ no visitor id, no ip hash
  if (e.consent.analytics === false && e.visitorId !== null) return { error: 'session-only signal carries a visitorId' };
  if (e.consent.analytics === false && isObj(e.network) && e.network.ipHash != null) return { error: 'session-only signal carries an ipHash' };

  const page = isObj(e.page) ? sanitizePage(e.page, ctx) : null;
  if (e.page !== null && !page) return { error: 'signal.page is invalid' };
  const referrer = isObj(e.referrer) ? sanitizeReferrer(e.referrer, ctx) : null;
  if (e.referrer !== null && !referrer) return { error: 'signal.referrer is invalid' };
  let attribution = null;
  if (isObj(e.attribution)) {
    const model = oneOf(e.attribution.model, SIGNAL_ATTRIBUTION_MODELS);
    if (!model) return { error: 'signal.attribution.model is invalid' };
    attribution = { firstTouch: sanitizeTouch(e.attribution.firstTouch, ctx), lastTouch: sanitizeTouch(e.attribution.lastTouch, ctx), model };
  }
  let lead = null;
  if (isObj(e.lead)) {
    const leadId = e.lead.leadId === null || e.lead.leadId === undefined ? null : isLeadId(e.lead.leadId) ? e.lead.leadId : undefined;
    if (leadId === undefined) return { error: 'signal.lead.leadId is invalid' };
    if ((type === 'lead_submitted' || type === 'lead_attributed') && !leadId) return { error: 'signal.lead.leadId is required' };
    lead = { leadId, formId: text(e.lead.formId, SIGNAL_LIMITS.formId, ctx), placement: text(e.lead.placement, SIGNAL_LIMITS.placement, ctx) };
    // v1.9.0 §40.3: optional keys, kept only when valid (an unknown value is dropped, never the signal)
    if (e.lead.provider !== undefined && e.lead.provider !== null) {
      if (LEAD_PROVIDERS.includes(e.lead.provider)) lead.provider = e.lead.provider;
      else ctx.clamped += 1;
    }
    if (type === 'form_submit' && e.lead.heuristic !== undefined && e.lead.heuristic !== null) {
      if (FORM_SUBMIT_HEURISTICS.includes(e.lead.heuristic)) lead.heuristic = e.lead.heuristic;
      else ctx.clamped += 1;
    }
  }
  let engagement = null;
  if (isObj(e.engagement)) {
    if (!intIn(e.engagement.scrollPct, 0, 100) || !intIn(e.engagement.visibleSec, 0, 86400)) return { error: 'signal.engagement is invalid' };
    engagement = { scrollPct: e.engagement.scrollPct, visibleSec: e.engagement.visibleSec };
  }
  let cta = null;
  if (isObj(e.cta)) {
    const kind = oneOf(e.cta.kind, SIGNAL_CTA_KINDS);
    if (!kind) return { error: 'signal.cta.kind is invalid' };
    cta = { kind, placement: text(e.cta.placement, SIGNAL_LIMITS.placement, ctx), href: text(e.cta.href, SIGNAL_LIMITS.ctaHref, ctx) };
  }
  let vitals = null;
  if (isObj(e.vitals)) {
    vitals = {
      lcpMs: nullableInt(e.vitals.lcpMs, 0, 600000, ctx),
      inpMs: nullableInt(e.vitals.inpMs, 0, 600000, ctx),
      cls: typeof e.vitals.cls === 'number' && Number.isFinite(e.vitals.cls) && e.vitals.cls >= 0 && e.vitals.cls <= 100 ? Math.round(e.vitals.cls * 1000) / 1000 : nullCount(e.vitals.cls, ctx),
    };
  }
  const path = isObj(e.path) ? sanitizeLeadPath(e.path, ctx) : null;
  const reasons = e.bot.reason.filter((r) => SIGNAL_BOT_REASONS.includes(r));
  const uniq = [...new Set(reasons)];
  if (uniq.length !== e.bot.reason.length || uniq.length > SIGNAL_LIMITS.botReasons) ctx.clamped += 1;

  const signal = {
    v: 1,
    siteId: e.siteId,
    eventId: e.eventId,
    type,
    sessionId: e.sessionId,
    visitorId: e.visitorId,
    ts: new Date(e.ts).toISOString(),
    tsLocal: pat(e.tsLocal, TS_LOCAL_RE, ctx, 19),
    tzOffset: nullableInt(e.tzOffset, -840, 840, ctx),
    tz: text(e.tz, SIGNAL_LIMITS.tz, ctx),
    page,
    referrer,
    utm: isObj(e.utm) ? sanitizeUtm(e.utm, ctx) : null,
    clickIds: isObj(e.clickIds) ? sanitizeClickIds(e.clickIds, ctx) : null,
    attribution,
    device: isObj(e.device) ? sanitizeDevice(e.device, ctx) : null,
    network: isObj(e.network) ? sanitizeNetwork(e.network, ctx) : null,
    consent: { analytics: e.consent.analytics, source: e.consent.source },
    bot: { score: e.bot.score, reason: uniq.slice(0, SIGNAL_LIMITS.botReasons) },
    lead,
    engagement,
    cta,
    vitals,
    path,
    collector: { js: pat(e.collector.js, SEMVER_RE, ctx, 32), server: e.collector.server },
  };
  // Redaction pass on every string (§38.6); ids must survive it unchanged.
  const red = redact(signal);
  if (red.eventId !== signal.eventId || red.sessionId !== signal.sessionId || red.visitorId !== signal.visitorId || red.lead?.leadId !== signal.lead?.leadId) {
    return { error: 'signal ids did not survive redaction' };
  }
  if (red.page && !String(red.page.path).startsWith('/')) red.page.path = '/';
  return { signal: red };
}

function nullCount(v, ctx) {
  if (v !== null && v !== undefined) ctx.clamped += 1;
  return null;
}

function sanitizePage(p, ctx) {
  const path = sitePath(p.path, SIGNAL_LIMITS.path, ctx);
  if (!path) return null;
  const query = {};
  if (isObj(p.query)) {
    for (const [k, v] of Object.entries(p.query)) {
      if (!SIGNAL_QUERY_KEYS.includes(k) || typeof v !== 'string') {
        ctx.clamped += 1; // not on the allow-list: dropped (§38.2)
        continue;
      }
      query[k] = text(v, SIGNAL_LIMITS.queryValue, ctx);
    }
  }
  return { path, title: text(p.title, SIGNAL_LIMITS.title, ctx), canonical: text(p.canonical, SIGNAL_LIMITS.canonical, ctx), query };
}

function sanitizeReferrer(r, ctx) {
  const cls = oneOf(r.class, REF_CLASSES);
  if (!cls) return null;
  let url = text(r.url, SIGNAL_LIMITS.referrerUrl, ctx);
  if (url && url.includes('?')) url = url.split('?')[0]; // §38.2: referrer.url keeps no query
  return {
    url,
    host: text(r.host, SIGNAL_LIMITS.host, ctx),
    class: cls,
    source: source(r.source, ctx),
    table: typeof r.table === 'string' && SEMVER_RE.test(r.table) ? r.table : '0.0.0',
  };
}

function sanitizeUtm(u, ctx) {
  const out = {};
  for (const k of ['source', 'medium', 'campaign', 'term', 'content']) out[k] = text(u[k], SIGNAL_LIMITS.utm, ctx);
  return out;
}

function sanitizeClickIds(c, ctx) {
  const out = {};
  for (const k of SIGNAL_CLICK_IDS) out[k] = text(c[k], SIGNAL_LIMITS.queryValue, ctx);
  return out;
}

function sanitizeDevice(d, ctx) {
  const vp = Array.isArray(d.viewport) && d.viewport.length === 2 && d.viewport.every((n) => intIn(n, 0, 20000)) ? [d.viewport[0], d.viewport[1]] : nullCount(d.viewport, ctx);
  return {
    ua: oneOf(d.ua, SIGNAL_UA_FAMILIES) || 'other',
    os: oneOf(d.os, SIGNAL_OS_FAMILIES) || 'other',
    formFactor: oneOf(d.formFactor, SIGNAL_FORM_FACTORS) || 'other',
    viewport: vp,
    language: text(d.language, SIGNAL_LIMITS.language, ctx),
  };
}

function sanitizeNetwork(n, ctx) {
  return {
    ipHash: pat(n.ipHash, IP_HASH_RE, ctx, 16),
    ipPrefix: pat(n.ipPrefix, IP_PREFIX_RE, ctx, 20),
    country: pat(n.country, COUNTRY_RE, ctx, 2),
    region: pat(n.region, REGION_RE, ctx, 8),
    city: text(n.city, SIGNAL_LIMITS.city, ctx),
    asn: nullableInt(n.asn, 0, 4294967295, ctx),
    cfRay: pat(n.cfRay, CF_RAY_RE, ctx, 40),
  };
}

/**
 * signals.batch `data` → `{ batchId, table, count, compacted, signals: [sanitized], invalid, clamped }` or
 * `{ error }` when the batch itself is unusable (VALIDATION, final).
 */
export function sanitizeSignalsBatch(data, { siteId = null } = {}) {
  if (!isObj(data)) return { error: 'data is required on signals.batch' };
  if (!isUlid(data.batchId)) return { error: 'data.batchId is invalid' };
  if (!Array.isArray(data.events)) return { error: 'data.events must be an array' };
  if (data.events.length > SIGNAL_LIMITS.batchSignals) return { error: `data.events holds at most ${SIGNAL_LIMITS.batchSignals} signals` };
  const signals = [];
  let invalid = 0;
  const ctx = { clamped: 0 };
  for (const e of data.events) {
    const r = sanitizeSignal(e, { siteId, ctx });
    if (r.signal) signals.push(r.signal);
    else invalid += 1;
  }
  return {
    batchId: data.batchId,
    table: typeof data.table === 'string' && SEMVER_RE.test(data.table) ? data.table : null,
    count: Number.isInteger(data.count) ? data.count : signals.length,
    compacted: data.compacted === true,
    signals,
    invalid,
    clamped: ctx.clamped,
  };
}

/** Scalars held in indexed columns: `payload` stores the envelope MINUS these (plan §5.1). */
export const SCALAR_KEYS = Object.freeze(['type', 'ts', 'sessionId', 'visitorId', 'country', 'pagePath', 'leadId', 'botScore', 'refClass', 'refSource', 'eventId']);

/** The class / source a signal is counted under (referrer group; lead_attributed → its last touch). */
export function signalRef(s) {
  if (s.referrer) return { refClass: s.referrer.class, refSource: s.referrer.source };
  const lt = s.attribution?.lastTouch;
  if (lt) return { refClass: lt.class, refSource: lt.source };
  return { refClass: 'unknown', refSource: null };
}

/**
 * Sanitized signal → SignalEvent row data. The payload drops what the scalars hold (re-assembled by `rowToSignal`):
 * eventId, type, ts→at, sessionId, visitorId, botScore (bot.score), country (network.country), pagePath (page.path),
 * leadId (lead.leadId), refClass / refSource (referrer.class / referrer.source).
 */
export function signalToRow(projectId, s) {
  const { refClass, refSource } = signalRef(s);
  const payload = { ...s };
  for (const k of ['eventId', 'type', 'ts', 'sessionId', 'visitorId', 'siteId']) delete payload[k];
  payload.bot = { reason: s.bot.reason };
  if (s.network) {
    payload.network = { ...s.network };
    delete payload.network.country;
  }
  if (s.page) {
    payload.page = { ...s.page };
    delete payload.page.path;
  }
  if (s.lead) {
    payload.lead = { ...s.lead };
    delete payload.lead.leadId;
  }
  if (s.referrer) {
    payload.referrer = { ...s.referrer };
    delete payload.referrer.class;
    delete payload.referrer.source;
  }
  return {
    projectId,
    eventId: s.eventId,
    type: s.type,
    at: new Date(s.ts),
    sessionId: s.sessionId,
    visitorId: s.visitorId,
    refClass,
    refSource: refSource ? refSource.slice(0, SIGNAL_LIMITS.source) : null,
    country: s.network?.country || null,
    pagePath: (s.page?.path || '/').slice(0, SIGNAL_LIMITS.path),
    leadId: s.lead?.leadId || null,
    botScore: s.bot.score,
    payload,
  };
}

/** SignalEvent row → envelope (payload + scalars). Never includes the internal BIGINT id. */
export function rowToSignal(row) {
  const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const out = {
    ...p,
    eventId: row.eventId,
    type: row.type,
    ts: new Date(row.at).toISOString(),
    sessionId: row.sessionId,
    visitorId: row.visitorId ?? null,
    bot: { score: row.botScore, reason: Array.isArray(p.bot?.reason) ? p.bot.reason : [] },
    compacted: !row.payload,
  };
  out.page = p.page ? { ...p.page, path: row.pagePath } : row.pagePath ? { path: row.pagePath } : null;
  out.network = p.network ? { ...p.network, country: row.country ?? null } : row.country ? { country: row.country } : null;
  out.lead = p.lead || row.leadId ? { ...(p.lead || {}), leadId: row.leadId ?? null } : null;
  out.referrer = p.referrer ? { ...p.referrer, class: row.refClass, source: row.refSource ?? null } : { class: row.refClass, source: row.refSource ?? null };
  return out;
}

/** lead.attributed data → `{ data }` or `{ error }`. */
export function sanitizeLeadAttributedData(d) {
  if (!isObj(d)) return { error: 'data is required on lead.attributed' };
  if (!isLeadId(d.leadId)) return { error: 'data.leadId is invalid' };
  const ctx = { clamped: 0 };
  const attribution = sanitizeLeadAttribution(d.attribution, ctx);
  if (!attribution) return { error: 'data.attribution is invalid' };
  const path = sanitizeLeadPath(d.path, ctx);
  if (!path) return { error: 'data.path is invalid' };
  return { data: redact({ leadId: d.leadId, attribution, path }) };
}

/** signals.erased data → `{ data }` or `{ error }` (holds a hash, never the id). */
export function sanitizeSignalsErasedData(d) {
  if (!isObj(d)) return { error: 'data is required on signals.erased' };
  if (d.kind !== 'visitorId' && d.kind !== 'leadId') return { error: 'data.kind is invalid' };
  if (typeof d.subjectHash !== 'string' || !SHA256_RE.test(d.subjectHash)) return { error: 'data.subjectHash is invalid' };
  if (!Number.isInteger(d.rows) || d.rows < 0) return { error: 'data.rows is invalid' };
  return { data: { kind: d.kind, subjectHash: d.subjectHash, rows: d.rows, reason: oneOf(d.reason, SIGNALS_ERASED_REASONS), at: isoOrNull(d.at) } };
}

/** signalsConfig → sanitized copy (null when unusable). */
export function sanitizeSignalsConfig(c) {
  if (!isObj(c) || !Number.isInteger(c.rev) || c.rev < 0 || typeof c.enabled !== 'boolean') return null;
  const ev = isObj(c.events) ? c.events : {};
  const sm = isObj(c.sampling) ? c.sampling : {};
  const rate = (v) => (typeof v === 'number' && v >= 0.1 && v <= 1 ? v : 1);
  const lc = isObj(c.lastChange) && Number.isInteger(c.lastChange.rev)
    ? { rev: c.lastChange.rev, at: isoOrNull(c.lastChange.at), source: oneOf(c.lastChange.source, SIGNALS_CONFIG_SOURCES), by: sanitizeSiteActor(c.lastChange.by) }
    : null;
  return {
    schemaVersion: 1,
    rev: c.rev,
    generatedAt: isoOrNull(c.generatedAt),
    enabled: c.enabled,
    consentMode: oneOf(c.consentMode, SIGNAL_CONSENT_MODES) || 'default-on-us',
    events: {
      visit: true,
      pageview: true,
      engagement: ev.engagement !== false,
      cta_click: ev.cta_click !== false,
      form_start: ev.form_start !== false,
      vitals: ev.vitals !== false,
      lead_submitted: true,
      lead_attributed: true,
    },
    sampling: { pageview: rate(sm.pageview), engagement: rate(sm.engagement) },
    geoDetail: oneOf(c.geoDetail, SIGNAL_GEO_DETAILS) || 'city',
    bufferDays: intIn(c.bufferDays, 1, 30) ? c.bufferDays : 30,
    table: typeof c.table === 'string' && SEMVER_RE.test(c.table) ? c.table : null,
    lastChange: lc,
  };
}

/** site-info.signals buffer counts. */
export function sanitizeSignalsBuffer(b) {
  if (!isObj(b)) return null;
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  return { buffered: n(b.buffered), packed: n(b.packed), droppedLast24h: n(b.droppedLast24h), oldestBufferedAt: isoOrNull(b.oldestBufferedAt) };
}

/** signals.config_changed data → `{ data }` or `{ error }`. */
export function sanitizeSignalsConfigChanged(d) {
  if (!isObj(d)) return { error: 'data is required on signals.config_changed' };
  if (!Number.isInteger(d.rev) || d.rev < 1) return { error: 'data.rev is invalid' };
  if (!Array.isArray(d.changes) || d.changes.length < 1) return { error: 'data.changes is required' };
  const changes = d.changes
    .slice(0, 10)
    .filter((c) => isObj(c) && SIGNALS_CONFIG_FIELDS.includes(c.field))
    .map((c) => ({ field: c.field, from: scalar(c.from), to: scalar(c.to) }));
  return {
    data: {
      rev: d.rev,
      at: isoOrNull(d.at) || new Date().toISOString(),
      source: oneOf(d.source, SIGNALS_CONFIG_SOURCES),
      by: sanitizeSiteActor(d.by),
      changes,
      osRequest: isObj(d.osRequest) && typeof d.osRequest.route === 'string' ? { route: d.osRequest.route.slice(0, 64), idempotencyKey: typeof d.osRequest.idempotencyKey === 'string' ? d.osRequest.idempotencyKey.slice(0, 128) : null } : null,
    },
  };
}

function scalar(v) {
  if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
  if (typeof v === 'string') return redactString(v).slice(0, 32);
  return null;
}

/** signals-summary response → counts only (null when unusable). */
export function sanitizeSignalsSummary(r) {
  if (!isObj(r)) return null;
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  const share = (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null);
  const rej = isObj(r.rejected) ? r.rejected : {};
  const drop = isObj(r.dropped) ? r.dropped : {};
  return {
    hours: intIn(r.hours, 1, 168) ? r.hours : 24,
    enabled: r.enabled === true,
    accepted: n(r.accepted),
    rejected: Object.fromEntries(SIGNALS_SUMMARY_REJECTED.map((k) => [k, n(rej[k])])),
    dropped: Object.fromEntries(SIGNALS_SUMMARY_DROPPED.map((k) => [k, n(drop[k])])),
    packed: n(r.packed),
    buffered: n(r.buffered),
    pendingBatches: n(r.pendingBatches),
    visits: n(r.visits),
    sessionOnlyVisits: n(r.sessionOnlyVisits),
    botVisits: n(r.botVisits),
    botShare: share(r.botShare),
    consentShare: share(r.consentShare),
    lastBeaconAt: isoOrNull(r.lastBeaconAt),
    oldestBufferedAt: isoOrNull(r.oldestBufferedAt),
  };
}

/** Envelope check for signals.* events (called from validateEvent). Messages never echo signal content. */
export function validateSignalsEvent(ev) {
  if (ev.snapshotText !== undefined) return 'snapshotText is not allowed on signals events';
  if (ev.lead !== undefined) return 'lead is not allowed on signals events';
  if (ev.type === 'signals.batch') {
    const d = ev.data;
    if (!isObj(d) || !isUlid(d.batchId)) return 'data.batchId is required on signals.batch';
    if (!Array.isArray(d.events) || d.events.length > SIGNAL_LIMITS.batchSignals) return `data.events must hold at most ${SIGNAL_LIMITS.batchSignals} signals`;
    return null;
  }
  if (ev.type === 'signals.erased') return sanitizeSignalsErasedData(ev.data).error || null;
  if (ev.type === 'signals.config_changed') return sanitizeSignalsConfigChanged(ev.data).error || null;
  return null; // other signals.* types are stored only
}

export const isSignalsEventType = (t) => typeof t === 'string' && t.startsWith('signals.');
