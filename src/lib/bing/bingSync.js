/**
 * Bing Webmaster sync (features/bing-webmaster.md). `runBingSync` is called by the 05:45 cron (leader only, the
 * caller checks isLeader()), by POST /api/admin/integrations/sync and by the per-project "Sync now" (background runs).
 *
 * 1. Skip when BING_WEBMASTER_ENABLED=false or no ACTIVE connection.
 * 2. One GetUserSites call: auth check for the whole run + the verified list (a project whose site is not listed as
 *    verified is marked BING_SiteNotVerified without spending calls).
 * 3. Projects with bingSiteUrl, client active, status ACTIVE/SETUP/PAUSED, least recently synced first,
 *    ≤ BING_SYNC_MAX_PER_RUN. Sequential. Per project:
 *    - daily: GetRankAndTrafficStats → BingDailyMetric, GetCrawlStats → BingCrawlDaily (write only new / changed days);
 *    - weekly (BingSiteState.lastQueriesAt older than 6 days, or `full`): GetQueryStats / GetPageStats (≤
 *      BING_QUERY_ROWS_MAX rows each by impressions; the returned weeks are replaced) and GetCrawlIssues (diff).
 *    A `site` error marks Project.bingSyncError and goes on with the next project; an `auth` error writes
 *    AgencyBingConnection.lastError and stops the run; a `throttle` error stops the run (`throttled: true`, the rest
 *    runs tomorrow). Nothing retries in a loop: the client retries a server error once.
 * 4. Retention purge (batches of ≤ 5000): daily / weekly 400 days, resolved crawl issues 90 days.
 */
import { prisma } from '../prisma.js';
import { getBingCredential, isBingEnabled, markBingError, markBingOk } from './bingAuth.js';
import { primeBingSitesCache } from './bingBinding.js';
import {
  getUserSites,
  getTrafficStats,
  getCrawlStats,
  getQueryStats,
  getPageStats,
  getCrawlIssues,
  decodeIssueFlags,
  urlHash,
  CRAWL_FIELDS,
  BingApiError,
} from './client.js';

const MS_DAY = 86_400_000;
export const WEEKLY_REFRESH_MS = 6 * MS_DAY;
export const RETENTION_DAYS = 400;
export const ISSUE_RETENTION_DAYS = 90;
export const PURGE_BATCH = 5000;
export const ISSUES_MAX = 1000;
const CHUNK = 500;

function intEnv(env, name, def, min, max) {
  const n = Number.parseInt(env?.[name] ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}
export const bingSyncMaxPerRun = (env = process.env) => intEnv(env, 'BING_SYNC_MAX_PER_RUN', 200, 1, 2000);
export const bingQueryRowsMax = (env = process.env) => intEnv(env, 'BING_QUERY_ROWS_MAX', 2000, 50, 20000);

export const BING_SYNC_STATUSES = ['ACTIVE', 'SETUP', 'PAUSED'];
export const BING_SYNC_SELECT = Object.freeze({ id: true, name: true, clientId: true, bingSiteUrl: true, bingLastSyncedAt: true });

const asDate = (iso) => new Date(`${iso}T00:00:00.000Z`);
const isoOf = (d) => new Date(d).toISOString().slice(0, 10);
const chunks = (arr, n = CHUNK) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/** Last row per date wins (Bing never sends duplicates, but be safe). Pure. */
function byDate(rows) {
  const m = new Map();
  for (const r of rows || []) if (r?.date) m.set(r.date, r);
  return m;
}

/**
 * Write daily rows (BingDailyMetric or BingCrawlDaily): one read of the range, createMany for new days, an update
 * only for days whose values changed. → { rows, created, updated }
 */
export async function storeDailyRows(kind, projectId, rows, { now = new Date() } = {}) {
  const map = byDate(rows);
  if (!map.size) return { rows: 0, created: 0, updated: 0 };
  const dates = [...map.keys()].sort();
  const delegate = kind === 'crawl' ? prisma.bingCrawlDaily : prisma.bingDailyMetric;
  const fields = kind === 'crawl' ? CRAWL_FIELDS.map(([, f]) => f) : ['clicks', 'impressions', 'ctr'];
  const existing = await delegate.findMany({
    where: { projectId, date: { gte: asDate(dates[0]), lte: asDate(dates[dates.length - 1]) } },
    select: { date: true, ...Object.fromEntries(fields.map((f) => [f, true])) },
  });
  const have = new Map((existing || []).map((e) => [isoOf(e.date), e]));
  const toCreate = [];
  const toUpdate = [];
  for (const [date, r] of map) {
    const data = {};
    for (const f of fields) {
      if (f === 'ctr') data.ctr = r.impressions > 0 ? Math.round((r.clicks / r.impressions) * 10000) / 10000 : 0;
      else data[f] = r[f] ?? (kind === 'crawl' ? null : 0);
    }
    if (kind === 'crawl') data.fetchedAt = now;
    const prev = have.get(date);
    if (!prev) toCreate.push({ projectId, date: asDate(date), ...data });
    else if (fields.some((f) => (prev[f] ?? null) !== (data[f] ?? null))) toUpdate.push({ date, data });
  }
  for (const part of chunks(toCreate)) await delegate.createMany({ data: part, skipDuplicates: true });
  for (const u of toUpdate) await delegate.update({ where: { projectId_date: { projectId, date: asDate(u.date) } }, data: u.data });
  return { rows: map.size, created: toCreate.length, updated: toUpdate.length };
}

/**
 * Weekly rows (queries or pages): keep the top `cap` rows by impressions, merge duplicates (case-insensitive for
 * queries, like the column collation), then replace the weeks this fetch returned. Older weeks are kept (history).
 */
export async function storeWeeklyRows(kind, projectId, rows, { cap = 2000, now = new Date() } = {}) {
  const isPage = kind === 'pages';
  const merged = new Map();
  for (const r of rows || []) {
    const key = isPage ? r.url : r.query;
    if (!key) continue;
    const k = `${r.weekStart}|${isPage ? urlHash(key) : String(key).toLowerCase().slice(0, 500)}`;
    const acc = merged.get(k);
    if (acc) {
      acc.clicks += r.clicks;
      acc.impressions += r.impressions;
    } else {
      merged.set(k, { ...r });
    }
  }
  const kept = [...merged.values()].sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks).slice(0, cap);
  if (!kept.length) return { rows: 0, weeks: 0, capped: false };
  const weeks = [...new Set(kept.map((r) => r.weekStart))];
  const delegate = isPage ? prisma.bingPageWeekly : prisma.bingQueryWeekly;
  const data = kept.map((r) => ({
    projectId,
    weekStart: asDate(r.weekStart),
    ...(isPage ? { urlHash: urlHash(r.url), url: String(r.url).slice(0, 1000) } : { query: String(r.query).slice(0, 500) }),
    clicks: r.clicks,
    impressions: r.impressions,
    avgClickPosition: r.avgClickPosition ?? null,
    avgImpressionPosition: r.avgImpressionPosition ?? null,
    fetchedAt: now,
  }));
  await delegate.deleteMany({ where: { projectId, weekStart: { in: weeks.map(asDate) } } });
  for (const part of chunks(data)) await delegate.createMany({ data: part, skipDuplicates: true });
  return { rows: data.length, weeks: weeks.length, capped: merged.size > cap };
}

/**
 * Crawl issues diff: a URL in this fetch is open (new → firstSeenAt; a resolved one comes back with resolvedAt
 * cleared); an open URL missing from the fetch gets resolvedAt = now. ≤ ISSUES_MAX URLs per fetch (most inbound links
 * first). → { open, created, reopened, resolved }
 */
export async function storeCrawlIssues(projectId, rows, { now = new Date(), cap = ISSUES_MAX } = {}) {
  const fetched = new Map();
  for (const r of [...(rows || [])].sort((a, b) => (b.inLinks || 0) - (a.inLinks || 0))) {
    const h = urlHash(r.url);
    if (!fetched.has(h) && fetched.size < cap) fetched.set(h, r);
  }
  const existing = await prisma.bingCrawlIssue.findMany({
    where: { projectId },
    select: { id: true, urlHash: true, httpCode: true, issuesRaw: true, inLinks: true, resolvedAt: true },
    take: 10_000,
  });
  const have = new Map((existing || []).map((e) => [e.urlHash, e]));
  const create = [];
  const touch = [];
  let reopened = 0;
  for (const [h, r] of fetched) {
    const prev = have.get(h);
    const issues = decodeIssueFlags(r.issuesRaw);
    if (!prev) {
      create.push({ projectId, urlHash: h, url: r.url, httpCode: r.httpCode, issuesRaw: r.issuesRaw, issues, inLinks: r.inLinks, firstSeenAt: now, lastSeenAt: now });
      continue;
    }
    if (prev.resolvedAt) reopened += 1;
    if (prev.httpCode !== r.httpCode || prev.issuesRaw !== r.issuesRaw || prev.inLinks !== r.inLinks || prev.resolvedAt) {
      await prisma.bingCrawlIssue.update({
        where: { id: prev.id },
        data: { httpCode: r.httpCode, issuesRaw: r.issuesRaw, issues, inLinks: r.inLinks, lastSeenAt: now, resolvedAt: null },
      });
    } else {
      touch.push(h);
    }
  }
  for (const part of chunks(create)) await prisma.bingCrawlIssue.createMany({ data: part, skipDuplicates: true });
  for (const part of chunks(touch)) await prisma.bingCrawlIssue.updateMany({ where: { projectId, urlHash: { in: part } }, data: { lastSeenAt: now } });
  const openMissing = (existing || []).filter((e) => !e.resolvedAt && !fetched.has(e.urlHash)).map((e) => e.id);
  for (const part of chunks(openMissing)) await prisma.bingCrawlIssue.updateMany({ where: { id: { in: part }, resolvedAt: null }, data: { resolvedAt: now } });
  return { open: fetched.size, created: create.length, reopened, resolved: openMissing.length };
}

async function saveState(projectId, data) {
  await prisma.bingSiteState.upsert({ where: { projectId }, create: { projectId, ...data }, update: data });
}

/** Sync one project (all steps). Throws BingApiError for the caller to classify. */
export async function syncBingProject(project, { credential, now = new Date(), full = false, env = process.env, fetchImpl, sleep, verified = true } = {}) {
  const stats = { calls: 0 };
  const opts = { credential, fetchImpl, sleep, env, stats };
  const site = project.bingSiteUrl;
  const steps = {};
  const state = await prisma.bingSiteState.findUnique({ where: { projectId: project.id }, select: { lastQueriesAt: true } });
  const result = () => ({ calls: stats.calls, steps });
  try {
    steps.traffic = await storeDailyRows('traffic', project.id, await getTrafficStats(site, opts), { now });
    steps.crawl = await storeDailyRows('crawl', project.id, await getCrawlStats(site, opts), { now });
    const stateData = { isVerified: verified, lastTrafficAt: now, lastCrawlAt: now, errorCode: null, errorAt: null };
    const weeklyDue = full || !state?.lastQueriesAt || now.getTime() - new Date(state.lastQueriesAt).getTime() >= WEEKLY_REFRESH_MS;
    if (weeklyDue) {
      const cap = bingQueryRowsMax(env);
      steps.queries = await storeWeeklyRows('queries', project.id, await getQueryStats(site, opts), { cap, now });
      steps.pages = await storeWeeklyRows('pages', project.id, await getPageStats(site, opts), { cap, now });
      steps.issues = await storeCrawlIssues(project.id, await getCrawlIssues(site, opts), { now });
      Object.assign(stateData, { lastQueriesAt: now, lastIssuesAt: now });
    } else {
      steps.queries = 'fresh';
    }
    await saveState(project.id, stateData);
    await prisma.project.update({ where: { id: project.id }, data: { bingLastSyncedAt: now, bingSyncError: null } });
    return result();
  } catch (err) {
    err.partial = result();
    throw err;
  }
}

/** Staff text for a project-level Bing error (no URL, no key). */
function projectErrorText(err) {
  if (err?.kind === 'site') return `Bing refused this site (${err.message}). Check it is verified in the agency Bing account.`;
  return `Bing sync failed (${err?.message || 'error'}).`;
}

async function markProjectError(project, err, now) {
  const code = err?.code || 'BING_ERROR';
  await prisma.project.update({ where: { id: project.id }, data: { bingSyncError: projectErrorText(err).slice(0, 500) } });
  await saveState(project.id, { errorCode: String(code).slice(0, 40), errorAt: now });
}

/** Delete old rows in batches of ≤ PURGE_BATCH (ids first, then deleteMany by id). → { model: deleted } */
export async function purgeOldBing({ now = new Date(), batch = PURGE_BATCH, maxBatches = 20 } = {}) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * MS_DAY);
  const issueCutoff = new Date(now.getTime() - ISSUE_RETENTION_DAYS * MS_DAY);
  const jobs = [
    ['bingDailyMetric', { date: { lt: cutoff } }],
    ['bingCrawlDaily', { date: { lt: cutoff } }],
    ['bingQueryWeekly', { weekStart: { lt: cutoff } }],
    ['bingPageWeekly', { weekStart: { lt: cutoff } }],
    ['bingCrawlIssue', { resolvedAt: { lt: issueCutoff } }],
  ];
  const out = {};
  for (const [model, where] of jobs) {
    out[model] = 0;
    for (let i = 0; i < maxBatches; i += 1) {
      const ids = await prisma[model].findMany({ where, select: { id: true }, take: batch });
      if (!ids?.length) break;
      const r = await prisma[model].deleteMany({ where: { id: { in: ids.map((x) => x.id) } } });
      out[model] += r?.count ?? ids.length;
      if (ids.length < batch) break;
    }
  }
  return out;
}

/**
 * The run. → { total, success, errors, throttled, stopped, calls, details: [{projectId, status, calls, steps, error}],
 * purge } or { skipped: 'DISABLED' | 'NOT_CONNECTED' }.
 */
export async function runBingSync({ log = console, projectIds = null, full = false, now = new Date(), env = process.env, fetchImpl, sleep, purge = true } = {}) {
  if (!isBingEnabled(env)) return { skipped: 'DISABLED' };
  let credential;
  try {
    credential = await getBingCredential();
  } catch {
    return { skipped: 'NOT_CONNECTED' };
  }
  const summary = { total: 0, success: 0, errors: 0, throttled: false, stopped: null, calls: 0, details: [] };
  const siteStats = { calls: 0 };
  let sites;
  try {
    sites = await getUserSites({ credential, fetchImpl, sleep, env, stats: siteStats });
    primeBingSitesCache(sites, now.getTime());
  } catch (err) {
    summary.calls += siteStats.calls;
    return stopRun(summary, err, log);
  }
  summary.calls += siteStats.calls;
  const verified = new Set(sites.filter((s) => s.verified).map((s) => s.siteUrl));

  const projects = await prisma.project.findMany({
    where: {
      bingSiteUrl: { not: null },
      status: { in: BING_SYNC_STATUSES },
      client: { isActive: true },
      ...(Array.isArray(projectIds) && projectIds.length ? { id: { in: projectIds.map(String) } } : {}),
    },
    select: BING_SYNC_SELECT,
    orderBy: { bingLastSyncedAt: 'asc' },
    take: bingSyncMaxPerRun(env),
  });
  summary.total = projects.length;

  for (const p of projects) {
    if (!verified.has(p.bingSiteUrl)) {
      const err = new BingApiError('SiteNotVerified', { kind: 'site' });
      await markProjectError(p, err, now);
      summary.errors += 1;
      summary.details.push({ projectId: p.id, status: 'error', calls: 0, steps: {}, error: err.code });
      continue;
    }
    try {
      const r = await syncBingProject(p, { credential, now, full, env, fetchImpl, sleep, verified: true });
      summary.calls += r.calls;
      summary.success += 1;
      summary.details.push({ projectId: p.id, status: 'ok', calls: r.calls, steps: r.steps, error: null });
    } catch (err) {
      const partial = err?.partial || { calls: 0, steps: {} };
      summary.calls += partial.calls;
      const kind = err?.kind || 'other';
      summary.details.push({ projectId: p.id, status: kind === 'throttle' ? 'throttled' : 'error', calls: partial.calls, steps: partial.steps, error: err?.code || 'BING_ERROR' });
      if (kind === 'auth' || kind === 'throttle') {
        if (kind === 'throttle') await saveState(p.id, { errorCode: String(err.code || 'BING_THROTTLE').slice(0, 40), errorAt: now });
        return finish(stopRun(summary, err, log), { now, purge, log });
      }
      summary.errors += 1;
      await markProjectError(p, err, now);
      log?.warn?.({ projectId: p.id, code: err?.code, kind }, 'Bing project sync failed');
    }
  }
  if (summary.success > 0) await markBingOk(now);
  return finish(summary, { now, purge, log });
}

async function finish(summary, { now, purge, log }) {
  if (purge) {
    try {
      summary.purge = await purgeOldBing({ now });
    } catch (err) {
      log?.warn?.({ err: err?.message }, 'Bing retention purge failed');
    }
  }
  return summary;
}

function stopRun(summary, err, log) {
  const kind = err?.kind || 'other';
  if (kind === 'throttle') {
    summary.throttled = true;
    summary.stopped = 'THROTTLED';
    log?.warn?.({ code: err?.code }, 'Bing throttled the sync; the rest runs tomorrow');
  } else if (kind === 'auth') {
    summary.stopped = 'AUTH';
    markBingError(`Bing rejected the API key (${err?.message || 'auth error'}). Generate a new key and connect it again.`).catch(() => null);
    log?.warn?.({ code: err?.code }, 'Bing sync stopped: the API key was rejected');
  } else {
    summary.stopped = err?.code || 'BING_ERROR';
    log?.warn?.({ code: err?.code, kind }, 'Bing sync stopped');
  }
  return summary;
}
