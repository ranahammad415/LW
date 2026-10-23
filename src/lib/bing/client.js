/**
 * Bing Webmaster Tools API client (docs/ledger/features/bing-webmaster.md). No npm dependency: native fetch +
 * AbortController.
 *
 * - API-key mode (Phase 1): GET https://ssl.bing.com/webmaster/api.svc/json/<Method>?siteUrl=…&apikey=<key>.
 *   The key is only ever put in the request URL: never logged, never in an error message, never returned.
 * - Responses are wrapped in {"d": …}; dates are WCF JSON dates "/Date(1316156400000-0700)/".
 * - Errors are HTTP 400 {"ErrorCode": 3, "Message": "InvalidApiKey"} (no official enum page, so the kind is decided
 *   by message substring and the raw ErrorCode is kept). HTTP 429 or a message containing "Throttle" = throttle.
 * - Throttle: one shared slot clock per PM2 instance (only the leader syncs on a schedule): at most BING_MAX_RPS calls
 *   per second (default 2) and never closer than 300 ms. One retry after 2 s on a server / network error; none on 400.
 * - No method takes a date range: every call returns everything Bing holds (~6 months daily, ~25 weeks weekly).
 */
import crypto from 'crypto';

export const BING_API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json/';
export const MIN_SPACING_MS = 300;
export const RETRY_DELAY_MS = 2000;

function numEnv(env, name, def, min, max) {
  const n = Number(env?.[name]);
  return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, n)) : def;
}
export const bingMaxRps = (env = process.env) => numEnv(env, 'BING_MAX_RPS', 2, 0.1, 10);
export const bingTimeoutMs = (env = process.env) => Math.round(numEnv(env, 'BING_TIMEOUT_MS', 30_000, 1000, 120_000));
export const bingSpacingMs = (env = process.env) => Math.max(MIN_SPACING_MS, Math.ceil(1000 / bingMaxRps(env)));

// ── errors ──

const AUTH_RE = /InvalidApiKey|NotAuthorized|Unauthori[sz]ed|UserNotFound|UserBlocked|InvalidToken|ExpiredToken|AccessDenied/i;
const THROTTLE_RE = /Throttl/i;
const SITE_RE = /SiteNotVerified|NotVerified|SiteNotFound|NotFound|InvalidUrl|InvalidParameter|UrlNotAllowed|NotAllowed/i;

/** auth | throttle | site | server | other. Pure. */
export function classifyBingError({ httpStatus = null, message = '' } = {}) {
  const msg = String(message || '');
  if (httpStatus === 429 || THROTTLE_RE.test(msg)) return 'throttle';
  if (httpStatus === 401 || httpStatus === 403 || AUTH_RE.test(msg)) return 'auth';
  if (SITE_RE.test(msg)) return 'site';
  if (!httpStatus || httpStatus >= 500) return 'server';
  return 'other';
}

/** Short storable code: BING_<Message> (letters/digits only, ≤ 40 chars). Pure. */
export function bingErrorCode(message, kind = 'other') {
  const m = String(message || '').replace(/[^A-Za-z0-9]+/g, '').slice(0, 35);
  return m ? `BING_${m}` : `BING_${String(kind).toUpperCase()}`;
}

export class BingApiError extends Error {
  constructor(message, { httpStatus = null, errorCode = null, kind = null } = {}) {
    super(message);
    this.name = 'BingApiError';
    this.httpStatus = httpStatus;
    this.errorCode = errorCode; // Bing's raw ErrorCode int, when given
    this.kind = kind || classifyBingError({ httpStatus, message });
    this.code = bingErrorCode(message, this.kind);
  }
}

export class BingNotConnectedError extends Error {
  constructor(message = 'The agency Bing Webmaster account is not connected') {
    super(message);
    this.name = 'BingNotConnectedError';
    this.kind = 'auth';
    this.code = 'BING_NOT_CONNECTED';
  }
}

/** Bing error body → { errorCode, message }. Accepts the documented shape and the WCF fault shape. Pure. */
export function parseBingErrorBody(text) {
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = null;
  }
  const src = j?.d && typeof j.d === 'object' ? j.d : j;
  const message = src?.Message ?? src?.message ?? src?.ExceptionDetail?.Message ?? null;
  const errorCode = Number.isFinite(Number(src?.ErrorCode)) ? Number(src.ErrorCode) : null;
  return { errorCode, message: message ? String(message).slice(0, 200) : null };
}

// ── dates, numbers, hashes ──

const WCF_RE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/**
 * WCF JSON date → 'YYYY-MM-DD' (Bing's displayed wall date: epoch ms shifted by the given offset; the documented sample
 * "/Date(1316156400000-0700)/" → "2011-09-16"). Also accepts an ISO date string. null when unusable. Pure.
 */
export function bingDate(value) {
  if (value == null) return null;
  const s = String(value).trim();
  const m = WCF_RE.exec(s);
  if (m) {
    let offsetMs = 0;
    if (m[2]) {
      const sign = m[2][0] === '-' ? -1 : 1;
      offsetMs = sign * (Number(m[2].slice(1, 3)) * 60 + Number(m[2].slice(3, 5))) * 60_000;
    }
    const d = new Date(Number(m[1]) + offsetMs);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : s.slice(0, 10);
  }
  return null;
}

export const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};
/** Bing reports -1 / 0 average positions for "no clicks"; those are null. */
export const toPos = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

/** Normalised URL (trimmed, no #fragment) for hashing. Pure. */
export function normalizeUrl(url) {
  return String(url || '').trim().split('#')[0];
}
export function urlHash(url) {
  return crypto.createHash('sha256').update(normalizeUrl(url)).digest('hex');
}

/**
 * Crawl-issue bit flags. The official CrawlIssues enum page is not reachable (404); these are the community labels
 * (best effort). The raw int is stored so labels can be corrected later without a re-sync.
 */
export const CRAWL_ISSUE_FLAGS = Object.freeze([
  [1, 'code301', 'Redirect (301)'],
  [2, 'code302', 'Redirect (302)'],
  [4, 'code4xx', 'Client error (4xx)'],
  [8, 'code5xx', 'Server error (5xx)'],
  [16, 'blockedByRobotsTxt', 'Blocked by robots.txt'],
  [32, 'containsMalware', 'Malware'],
  [64, 'importantUrlBlockedByRobotsTxt', 'Important URL blocked by robots.txt'],
  [128, 'dnsErrors', 'DNS error'],
  [256, 'timeOutErrors', 'Time-out'],
]);
/** int → [{key,label}] (unknown bits → {key:'other'}). Pure. */
export function decodeIssueFlags(raw) {
  const n = Number(raw) >>> 0;
  const out = [];
  let known = 0;
  for (const [bit, key, label] of CRAWL_ISSUE_FLAGS) {
    known |= bit;
    if (n & bit) out.push({ key, label });
  }
  if (n & ~known) out.push({ key: 'other', label: 'Other issue' });
  return out;
}

// ── transport ──

let nextSlotAt = 0;
/** Test hook: forget the slot clock. */
export function resetBingThrottle() {
  nextSlotAt = 0;
}
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTurn({ env, sleep, now }) {
  const t = now();
  const at = Math.max(t, nextSlotAt);
  nextSlotAt = at + bingSpacingMs(env);
  if (at > t) await sleep(at - t);
}

/** Request URL for a method (API-key mode). Exported for tests only; the result contains the key: never log it. */
export function buildBingUrl(method, params, credential) {
  if (!/^[A-Za-z]+$/.test(String(method))) throw new Error('Invalid Bing method');
  const u = new URL(String(method), BING_API_BASE);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null) u.searchParams.set(k, String(v));
  }
  if (credential?.mode === 'api_key') u.searchParams.set('apikey', String(credential.apiKey || ''));
  return u.toString();
}

/**
 * One Bing call → `json.d` (or the whole JSON when there is no `d`). Throws BingApiError (never containing the URL or
 * the key). `stats.calls` is incremented per HTTP attempt.
 */
export async function bingCall(method, { params = {}, credential, fetchImpl, sleep = realSleep, env = process.env, now = Date.now, stats = null, retryDelayMs = RETRY_DELAY_MS } = {}) {
  if (!credential || credential.mode !== 'api_key' || !credential.apiKey) throw new BingNotConnectedError();
  const url = buildBingUrl(method, params, credential);
  const doFetch = fetchImpl || globalThis.fetch;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(retryDelayMs);
    await waitTurn({ env, sleep, now });
    if (stats) stats.calls = (stats.calls || 0) + 1;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), bingTimeoutMs(env));
    let res;
    try {
      res = await doFetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: ctrl.signal });
    } catch (err) {
      clearTimeout(timer);
      lastErr = new BingApiError(err?.name === 'AbortError' ? 'Timeout' : 'NetworkError', { kind: 'server' });
      continue;
    }
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const parsed = parseBingErrorBody(text);
      const err = new BingApiError(parsed.message || `HTTP${res.status}`, { httpStatus: res.status, errorCode: parsed.errorCode });
      if (err.kind === 'server') {
        lastErr = err;
        continue;
      }
      throw err;
    }
    let json;
    try {
      json = await res.json();
    } catch {
      throw new BingApiError('InvalidJson', { httpStatus: res.status, kind: 'other' });
    }
    return json && typeof json === 'object' && 'd' in json ? json.d : json;
  }
  throw lastErr || new BingApiError('Failed', { kind: 'server' });
}

// ── typed methods (shapes from the IWebmasterApi reference samples) ──

const list = (d) => (Array.isArray(d) ? d : []);

/** GetUserSites → [{ siteUrl, verified }]. Verification codes are dropped (never stored or returned). */
export async function getUserSites(opts) {
  return list(await bingCall('GetUserSites', opts))
    .filter((s) => s && s.Url)
    .map((s) => ({ siteUrl: String(s.Url).slice(0, 500), verified: s.IsVerified === true }));
}

/** GetRankAndTrafficStats → [{ date, clicks, impressions }] (daily). */
export async function getTrafficStats(siteUrl, opts) {
  return list(await bingCall('GetRankAndTrafficStats', { ...opts, params: { siteUrl } }))
    .map((r) => ({ date: bingDate(r?.Date), clicks: Math.max(0, toInt(r?.Clicks) ?? 0), impressions: Math.max(0, toInt(r?.Impressions) ?? 0) }))
    .filter((r) => r.date);
}

export const CRAWL_FIELDS = Object.freeze([
  ['CrawledPages', 'crawledPages'], ['InIndex', 'inIndex'], ['InLinks', 'inLinks'], ['Code2xx', 'code2xx'],
  ['Code301', 'code301'], ['Code302', 'code302'], ['Code4xx', 'code4xx'], ['Code5xx', 'code5xx'],
  ['AllOtherCodes', 'allOtherCodes'], ['BlockedByRobotsTxt', 'blockedByRobotsTxt'], ['ContainsMalware', 'containsMalware'],
  ['CrawlErrors', 'crawlErrors'],
]);

/** GetCrawlStats → [{ date, crawledPages, inIndex, … }] (daily). */
export async function getCrawlStats(siteUrl, opts) {
  return list(await bingCall('GetCrawlStats', { ...opts, params: { siteUrl } }))
    .map((r) => {
      const out = { date: bingDate(r?.Date) };
      for (const [src, dst] of CRAWL_FIELDS) out[dst] = toInt(r?.[src]);
      return out;
    })
    .filter((r) => r.date);
}

function weeklyRows(d, key) {
  return list(d)
    .map((r) => ({
      weekStart: bingDate(r?.Date),
      [key]: r?.Query != null ? String(r.Query).trim() : '',
      clicks: Math.max(0, toInt(r?.Clicks) ?? 0),
      impressions: Math.max(0, toInt(r?.Impressions) ?? 0),
      avgClickPosition: toPos(r?.AvgClickPosition),
      avgImpressionPosition: toPos(r?.AvgImpressionPosition),
    }))
    .filter((r) => r.weekStart && r[key]);
}

/** GetQueryStats → [{ weekStart, query, clicks, impressions, avgClickPosition, avgImpressionPosition }] (weekly). */
export async function getQueryStats(siteUrl, opts) {
  return weeklyRows(await bingCall('GetQueryStats', { ...opts, params: { siteUrl } }), 'query');
}

/** GetPageStats → same shape with `url` (Bing puts the page URL in `Query`). */
export async function getPageStats(siteUrl, opts) {
  return weeklyRows(await bingCall('GetPageStats', { ...opts, params: { siteUrl } }), 'url');
}

/** GetCrawlIssues → [{ url, httpCode, issuesRaw, inLinks }] (current snapshot). */
export async function getCrawlIssues(siteUrl, opts) {
  return list(await bingCall('GetCrawlIssues', { ...opts, params: { siteUrl } }))
    .filter((r) => r && r.Url)
    .map((r) => ({ url: normalizeUrl(r.Url).slice(0, 1000), httpCode: toInt(r.HttpCode), issuesRaw: Math.max(0, toInt(r.Issues) ?? 0), inLinks: toInt(r.InLinks) }));
}
