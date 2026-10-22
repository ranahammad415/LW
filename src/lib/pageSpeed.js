/**
 * Site metrics: Core Web Vitals / page speed through the PageSpeed Insights API v5 (docs/ledger/features/site-metrics.md).
 *
 * - One row per project, UTC day and strategy (PageSpeedDaily). Lab values from Lighthouse, field values from CrUX
 *   (`loadingExperience`, falling back to `originLoadingExperience`).
 * - The nightly job (index.js, leader only) runs mobile then desktop per eligible project, sequentially, capped by
 *   PAGESPEED_MAX_PER_RUN. A 429 stops the run (no retry). Each call times out after PSI_TIMEOUT_MS.
 * - The target is the site's home URL (Project.wpUrl, used by both WordPress and EmDash). https only and the host must
 *   resolve to public addresses (lib/siteAdapters/netGuard.js validateSiteUrl in strict mode), even in development.
 * - Health v2 (factor S5) reads rows through the pure pageSpeedStatus(row).
 * The optional PAGESPEED_API_KEY is sent as a query parameter to Google only; it is never logged or stored.
 */
import { prisma } from './prisma.js';
import { validateSiteUrl } from './siteAdapters/netGuard.js';

export const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
export const PSI_TIMEOUT_MS = 60_000;
export const PAGESPEED_RETENTION_DAYS = 400;
export const PAGESPEED_HISTORY_DAYS = 90;
export const STRATEGIES = ['mobile', 'desktop'];
/** Manual refresh: a project fetched less than this long ago is refused (cluster-safe, the DB is the clock). */
export const REFRESH_COOLDOWN_MS = 5 * 60_000;

/** Google's Core Web Vitals thresholds (p75): good ≤ first value, poor > second value. */
export const CWV = {
  lcpMs: { good: 2500, poor: 4000 },
  inpMs: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
};

export function isPageSpeedEnabled(env = process.env) {
  return String(env.PAGESPEED_ENABLED ?? 'true').toLowerCase() !== 'false';
}

export function pageSpeedMaxPerRun(env = process.env) {
  const n = Number.parseInt(env.PAGESPEED_MAX_PER_RUN ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 100;
}

/** UTC midnight of `now` (the PageSpeedDaily.date value). */
export function utcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const intOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const numOrNull = (v, digits = 4) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(digits)) : null);
const FIELD_CATEGORIES = new Set(['FAST', 'AVERAGE', 'SLOW']);

function fieldFrom(exp) {
  const m = exp && typeof exp === 'object' ? exp.metrics : null;
  if (!m || typeof m !== 'object') return null;
  const lcp = intOrNull(m.LARGEST_CONTENTFUL_PAINT_MS?.percentile);
  const inp = intOrNull(m.INTERACTION_TO_NEXT_PAINT?.percentile);
  // CrUX reports CLS p75 multiplied by 100 (e.g. 5 = 0.05).
  const clsRaw = m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile;
  const cls = typeof clsRaw === 'number' && Number.isFinite(clsRaw) ? numOrNull(clsRaw / 100) : null;
  if (lcp == null && inp == null && cls == null) return null;
  const cat = String(exp.overall_category || '').toUpperCase();
  return { fieldLcpP75: lcp, fieldInpP75: inp, fieldClsP75: cls, fieldCategory: FIELD_CATEGORIES.has(cat) ? cat : null };
}

/**
 * Parse a PSI v5 response into PageSpeedDaily columns. Returns { ok: true, data } or { ok: false, errorCode } when
 * Lighthouse reported a runtime error (e.g. NO_FCP) or the performance category is missing.
 */
export function parsePsiResponse(json) {
  const lh = json?.lighthouseResult;
  if (!lh || typeof lh !== 'object') return { ok: false, errorCode: 'NO_LIGHTHOUSE_RESULT' };
  if (lh.runtimeError?.code && lh.runtimeError.code !== 'NO_ERROR') {
    return { ok: false, errorCode: String(lh.runtimeError.code).slice(0, 40) };
  }
  const score = lh.categories?.performance?.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) return { ok: false, errorCode: 'NO_PERFORMANCE_SCORE' };
  const audit = (id) => lh.audits?.[id]?.numericValue;
  const field = fieldFrom(json.loadingExperience) || fieldFrom(json.originLoadingExperience);
  return {
    ok: true,
    data: {
      performanceScore: Math.max(0, Math.min(100, Math.round(score * 100))),
      lcpMs: intOrNull(audit('largest-contentful-paint')),
      cls: numOrNull(audit('cumulative-layout-shift')),
      tbtMs: intOrNull(audit('total-blocking-time')),
      fcpMs: intOrNull(audit('first-contentful-paint')),
      speedIndexMs: intOrNull(audit('speed-index')),
      fieldLcpP75: field?.fieldLcpP75 ?? null,
      fieldInpP75: field?.fieldInpP75 ?? null,
      fieldClsP75: field?.fieldClsP75 ?? null,
      fieldCategory: field?.fieldCategory ?? null,
    },
  };
}

function rate(value, t) {
  if (value == null) return null;
  if (value <= t.good) return 'good';
  if (value > t.poor) return 'poor';
  return 'needs_improvement';
}

/**
 * Pure status rule for one PageSpeedDaily row (Health v2 factor S5).
 * Field data wins when present: every available CrUX p75 metric within Google's "good" threshold → good, any metric
 * past the "poor" threshold → poor, otherwise needs_improvement. Without field data the lab performance score decides
 * (≥ 90 good, 50–89 needs_improvement, < 50 poor). Error rows and rows without data → unknown.
 * @returns {{ status: 'good'|'needs_improvement'|'poor'|'unknown', source: 'field'|'lab'|null }}
 */
export function pageSpeedStatus(row) {
  if (!row || (row.status && row.status !== 'ok')) return { status: 'unknown', source: null };
  const ratings = [
    rate(row.fieldLcpP75 ?? null, CWV.lcpMs),
    rate(row.fieldInpP75 ?? null, CWV.inpMs),
    rate(row.fieldClsP75 ?? null, CWV.cls),
  ].filter(Boolean);
  if (ratings.length) {
    if (ratings.includes('poor')) return { status: 'poor', source: 'field' };
    if (ratings.includes('needs_improvement')) return { status: 'needs_improvement', source: 'field' };
    return { status: 'good', source: 'field' };
  }
  const s = row.performanceScore;
  if (typeof s !== 'number' || !Number.isFinite(s)) return { status: 'unknown', source: null };
  if (s >= 90) return { status: 'good', source: 'lab' };
  if (s >= 50) return { status: 'needs_improvement', source: 'lab' };
  return { status: 'poor', source: 'lab' };
}

const ORDER = { poor: 0, needs_improvement: 1, good: 2 };
/** Worst known status of several rows (e.g. latest mobile + desktop); unknown when none is known. */
export function worstPageSpeedStatus(rows) {
  let worst = 'unknown';
  for (const r of rows || []) {
    const { status } = pageSpeedStatus(r);
    if (status === 'unknown') continue;
    if (worst === 'unknown' || ORDER[status] < ORDER[worst]) worst = status;
  }
  return worst;
}

/**
 * The URL PSI should test: the site home URL (origin + "/") of Project.wpUrl. https only, no private/loopback host
 * or IP literal, and the host must resolve to public addresses (strict netGuard rules even outside production).
 * @returns {Promise<{ ok: true, url: string } | { ok: false, reason: string }>}
 */
export async function pageSpeedTargetUrl(project, { lookup } = {}) {
  const raw = String(project?.wpUrl || '').trim();
  if (!raw) return { ok: false, reason: 'NO_URL' };
  let origin;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return { ok: false, reason: 'NOT_HTTPS' };
    origin = u.origin;
  } catch {
    return { ok: false, reason: 'BAD_URL' };
  }
  const opts = { env: { NODE_ENV: 'production' } };
  if (lookup) opts.lookup = lookup;
  const v = await validateSiteUrl(origin, opts);
  if (!v.ok) return { ok: false, reason: 'URL_REJECTED' };
  return { ok: true, url: `${origin}/` };
}

function errorCodeFromBody(body, status) {
  const msg = String(body?.error?.message || '');
  const m = msg.match(/\b([A-Z][A-Z0-9_]{3,})\b/);
  return (m ? m[1] : `HTTP_${status}`).slice(0, 40);
}

/**
 * One PSI call (no retry). Resolves to { ok: true, data } | { ok: false, errorCode, rateLimited? }.
 * `fetchImpl` and `env` are injectable for tests.
 */
export async function fetchPageSpeed(url, strategy, { fetchImpl = fetch, env = process.env, timeoutMs = PSI_TIMEOUT_MS } = {}) {
  const qs = new URLSearchParams({ url, strategy, category: 'performance' });
  if (env.PAGESPEED_API_KEY) qs.set('key', env.PAGESPEED_API_KEY);
  let res;
  try {
    res = await fetchImpl(`${PSI_ENDPOINT}?${qs.toString()}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, errorCode: timeout ? 'TIMEOUT' : 'NETWORK' };
  }
  if (res.status === 429) return { ok: false, errorCode: 'RATE_LIMITED', rateLimited: true };
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    // Google also reports a spent quota as 403 RESOURCE_EXHAUSTED / rateLimitExceeded on some keys.
    const reason = JSON.stringify(body?.error?.errors || body?.error?.status || '');
    if (/RESOURCE_EXHAUSTED|rateLimitExceeded|dailyLimitExceeded/i.test(reason)) {
      return { ok: false, errorCode: 'RATE_LIMITED', rateLimited: true };
    }
    return { ok: false, errorCode: errorCodeFromBody(body, res.status) };
  }
  return parsePsiResponse(body);
}

/**
 * Store one strategy result. An error never overwrites an ok row of the same day (a failed manual refresh keeps the
 * nightly data).
 */
async function storeResult(projectId, date, strategy, url, result, now) {
  const where = { projectId_date_strategy: { projectId, date, strategy } };
  if (result.ok) {
    const data = { url, ...result.data, status: 'ok', errorCode: null, fetchedAt: now };
    await prisma.pageSpeedDaily.upsert({ where, create: { projectId, date, strategy, ...data }, update: data });
    return;
  }
  const existing = await prisma.pageSpeedDaily.findUnique({ where, select: { status: true } });
  if (existing?.status === 'ok') return;
  const data = { url, status: 'error', errorCode: result.errorCode, fetchedAt: now };
  await prisma.pageSpeedDaily.upsert({ where, create: { projectId, date, strategy, ...data }, update: data });
}

/**
 * Run PSI for one project. `parallel` (manual refresh) runs both strategies at once; the nightly job is sequential.
 * A rate-limited strategy writes nothing. Returns { url, results: { mobile, desktop }, rateLimited }.
 */
export async function runPageSpeedForProject(project, { now = new Date(), fetchImpl, env = process.env, lookup, parallel = false } = {}) {
  const target = await pageSpeedTargetUrl(project, { lookup });
  if (!target.ok) return { skipped: target.reason };
  const date = utcDay(now);
  const results = {};
  let rateLimited = false;
  const one = async (strategy) => {
    if (rateLimited) return;
    const r = await fetchPageSpeed(target.url, strategy, { fetchImpl, env });
    results[strategy] = r.ok ? 'ok' : r.errorCode;
    if (r.rateLimited) {
      rateLimited = true;
      return;
    }
    await storeResult(project.id, date, strategy, target.url, r, now);
  };
  if (parallel) await Promise.all(STRATEGIES.map(one));
  else for (const s of STRATEGIES) await one(s);
  return { url: target.url, results, rateLimited };
}

/** Projects the nightly job may test: active or in setup, with a site URL. */
async function eligibleProjects() {
  return prisma.project.findMany({
    where: { status: { in: ['ACTIVE', 'SETUP'] }, wpUrl: { not: null }, client: { isActive: true } },
    select: { id: true, wpUrl: true },
    orderBy: { id: 'asc' },
  });
}

/** Delete rows older than PAGESPEED_RETENTION_DAYS. */
export async function purgeOldPageSpeed(now = new Date()) {
  const cutoff = new Date(utcDay(now).getTime() - PAGESPEED_RETENTION_DAYS * 86_400_000);
  const out = await prisma.pageSpeedDaily.deleteMany({ where: { date: { lt: cutoff } } });
  return out?.count ?? 0;
}

/**
 * Nightly job. Projects already measured today (both strategies) are skipped, so a second run the same day is a no-op;
 * the rest are ordered least-recently-fetched first, then capped. Stops at the first 429.
 */
export async function runPageSpeedJob({ log, now = new Date(), fetchImpl, env = process.env, lookup } = {}) {
  if (!isPageSpeedEnabled(env)) return { skipped: 'disabled' };
  const cap = pageSpeedMaxPerRun(env);
  const projects = await eligibleProjects();
  const ids = projects.map((p) => p.id);
  const today = utcDay(now);
  const doneToday = ids.length
    ? await prisma.pageSpeedDaily.groupBy({ by: ['projectId'], where: { projectId: { in: ids }, date: today }, _count: { _all: true } })
    : [];
  const done = new Set(doneToday.filter((g) => (g._count?._all ?? 0) >= STRATEGIES.length).map((g) => g.projectId));
  const lastFetched = ids.length
    ? await prisma.pageSpeedDaily.groupBy({ by: ['projectId'], where: { projectId: { in: ids } }, _max: { fetchedAt: true } })
    : [];
  const lastAt = new Map(lastFetched.map((g) => [g.projectId, g._max?.fetchedAt ? new Date(g._max.fetchedAt).getTime() : 0]));
  const queue = projects
    .filter((p) => !done.has(p.id))
    .sort((a, b) => (lastAt.get(a.id) || 0) - (lastAt.get(b.id) || 0))
    .slice(0, cap);

  const summary = { eligible: projects.length, alreadyDone: done.size, attempted: 0, ok: 0, errors: 0, skipped: 0, stopped: null, purged: 0 };
  for (const p of queue) {
    summary.attempted += 1;
    let out;
    try {
      out = await runPageSpeedForProject(p, { now, fetchImpl, env, lookup });
    } catch (err) {
      summary.errors += 1;
      log?.warn?.({ projectId: p.id, message: err?.message }, 'PageSpeed project failed');
      continue;
    }
    if (out.skipped) {
      summary.skipped += 1;
      continue;
    }
    const vals = Object.values(out.results);
    summary.ok += vals.filter((v) => v === 'ok').length;
    summary.errors += vals.filter((v) => v !== 'ok' && v !== 'RATE_LIMITED').length;
    if (out.rateLimited) {
      summary.stopped = 'RATE_LIMITED';
      break;
    }
  }
  try {
    summary.purged = await purgeOldPageSpeed(now);
  } catch (err) {
    log?.warn?.({ message: err?.message }, 'PageSpeed retention purge failed');
  }
  return summary;
}

// ── Views ───────────────────────────────────────────────────────────────────

const STAFF_SELECT = {
  date: true, strategy: true, url: true, performanceScore: true, lcpMs: true, cls: true, tbtMs: true, fcpMs: true,
  speedIndexMs: true, fieldLcpP75: true, fieldInpP75: true, fieldClsP75: true, fieldCategory: true, status: true,
  errorCode: true, fetchedAt: true,
};

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

function historySince(now, days) {
  return new Date(utcDay(now).getTime() - days * 86_400_000);
}

/** Staff view: latest ok row per strategy (+ its status), the latest error, and 90 days of history. */
export async function staffPageSpeedView(project, { now = new Date(), env = process.env } = {}) {
  const rows = await prisma.pageSpeedDaily.findMany({
    where: { projectId: project.id, date: { gte: historySince(now, PAGESPEED_HISTORY_DAYS) } },
    select: STAFF_SELECT,
    orderBy: [{ date: 'asc' }, { strategy: 'asc' }],
  });
  const latest = {};
  const latestRows = [];
  for (const s of STRATEGIES) {
    const ok = rows.filter((r) => r.strategy === s && r.status === 'ok');
    const row = ok[ok.length - 1] || null;
    if (row) latestRows.push(row);
    const st = pageSpeedStatus(row);
    latest[s] = row ? { ...row, date: dayKey(row.date), rating: st.status, ratingSource: st.source } : null;
  }
  const lastRow = rows.length ? rows.reduce((a, b) => (new Date(b.fetchedAt) > new Date(a.fetchedAt) ? b : a)) : null;
  const target = String(project.wpUrl || '').trim();
  return {
    enabled: isPageSpeedEnabled(env),
    hasUrl: Boolean(target),
    latest,
    overall: worstPageSpeedStatus(latestRows),
    lastError: lastRow && lastRow.status !== 'ok' ? { strategy: lastRow.strategy, errorCode: lastRow.errorCode, at: lastRow.fetchedAt } : null,
    lastFetchedAt: lastRow?.fetchedAt || null,
    history: rows.map((r) => ({ ...r, date: dayKey(r.date), status: r.status, rating: pageSpeedStatus(r).status })),
  };
}

export const CLIENT_LABELS = { good: 'Fast', needs_improvement: 'Needs work', poor: 'Slow' };

function clientSentence(mobile, desktop) {
  const worst = worstPageSpeedStatus([mobile, desktop].filter(Boolean));
  const m = mobile ? pageSpeedStatus(mobile).status : 'unknown';
  const d = desktop ? pageSpeedStatus(desktop).status : 'unknown';
  const phonesWorse = m !== 'unknown' && d !== 'unknown' && ORDER[m] < ORDER[d];
  if (worst === 'good') return 'Your website loads quickly for visitors on phones and computers.';
  if (worst === 'needs_improvement') {
    return phonesWorse
      ? 'Your website loads at an okay speed, a little slower on phones. We are looking at ways to make it faster.'
      : 'Your website loads at an okay speed. We are looking at ways to make it faster.';
  }
  return phonesWorse
    ? 'Your website is slow to load on phones. We are working on making it faster.'
    : 'Your website is slow to load for some visitors. We are working on making it faster.';
}

/**
 * Client view (allow-list): a label per device, a plain sentence and a 90-day trend of the performance score.
 * No URL, no raw metrics, no Lighthouse data, no error codes.
 */
export async function clientPageSpeedView(project, { now = new Date() } = {}) {
  const rows = await prisma.pageSpeedDaily.findMany({
    where: { projectId: project.id, status: 'ok', date: { gte: historySince(now, PAGESPEED_HISTORY_DAYS) } },
    select: { date: true, strategy: true, performanceScore: true, fieldLcpP75: true, fieldInpP75: true, fieldClsP75: true, status: true },
    orderBy: [{ date: 'asc' }, { strategy: 'asc' }],
  });
  if (!rows.length) return { available: false };
  const last = (s) => {
    const list = rows.filter((r) => r.strategy === s);
    return list[list.length - 1] || null;
  };
  const mobile = last('mobile');
  const desktop = last('desktop');
  const device = (row) => {
    if (!row) return null;
    const { status } = pageSpeedStatus(row);
    return status === 'unknown' ? null : { label: CLIENT_LABELS[status], score: row.performanceScore ?? null };
  };
  const byDay = new Map();
  for (const r of rows) {
    const k = dayKey(r.date);
    if (!byDay.has(k)) byDay.set(k, { date: k, mobile: null, desktop: null });
    byDay.get(k)[r.strategy === 'desktop' ? 'desktop' : 'mobile'] = r.performanceScore ?? null;
  }
  const lastDate = [mobile, desktop].filter(Boolean).map((r) => dayKey(r.date)).sort().pop() || null;
  return {
    available: true,
    mobile: device(mobile),
    desktop: device(desktop),
    sentence: clientSentence(mobile, desktop),
    trend: [...byDay.values()],
    updatedAt: lastDate,
  };
}
