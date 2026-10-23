/**
 * Bing Webmaster views (features/bing-webmaster.md).
 * - staffBingView: the staff Bing tab of a project (OWNER / PM with access).
 * - clientBingSummary: the client tile, an ALLOW-LIST (numbers and plain words only: no URLs, no ids, no errors, no
 *   vendor cost, no quota).
 * - bingFleet: the OWNER admin table (one row per bound project, errors first).
 */
import { prisma } from '../prisma.js';
import { getBingSeries, bingShare, aggregateWeekly, loadWeeklyQueries, loadWeeklyPages, crawlErrors, crawlIssueSummary } from '../analytics/bingSeries.js';
import { getBingConnectionStatus, isBingEnabled } from './bingAuth.js';
import { staffBingRankView } from './bingRank.js';

const MS_DAY = 86_400_000;
export const STAFF_DAYS = 28;
export const SERIES_DAYS = 90;

const day = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

/** [start, end] of the last `n` complete days ending yesterday (Bing has no same-day data), plus the window before. */
export function staffWindows(now = new Date(), n = STAFF_DAYS) {
  const end = new Date(day(now).getTime() - MS_DAY);
  const start = new Date(end.getTime() - (n - 1) * MS_DAY);
  const prevEnd = new Date(start.getTime() - MS_DAY);
  const prevStart = new Date(prevEnd.getTime() - (n - 1) * MS_DAY);
  return { cur: { start, end }, prev: { start: prevStart, end: prevEnd } };
}

async function googleTotals(projectId, { start, end }) {
  const rows = await prisma.gscDailyMetric.findMany({ where: { projectId, date: { gte: start, lte: end } }, select: { clicks: true, impressions: true } });
  return (rows || []).reduce((a, r) => ({ clicks: a.clicks + (r.clicks || 0), impressions: a.impressions + (r.impressions || 0) }), { clicks: 0, impressions: 0 });
}

/** Staff Bing tab. */
export async function staffBingView(project, { now = new Date() } = {}) {
  const status = await getBingConnectionStatus();
  const binding = {
    siteUrl: project.bingSiteUrl || null,
    lastSyncedAt: project.bingLastSyncedAt || null,
    error: project.bingSyncError || null,
  };
  const base = { enabled: isBingEnabled(), connected: status.connected, connectionError: status.connection?.lastError || null, binding };
  const ranks = await staffBingRankView(project, { now });
  if (!project.bingSiteUrl) return { ...base, linked: false, state: null, traffic: null, queries: [], pages: [], crawl: null, ranks };

  const w = staffWindows(now);
  const seriesStart = new Date(w.cur.end.getTime() - (SERIES_DAYS - 1) * MS_DAY);
  const weeklyFrom = new Date(w.cur.end.getTime() - 34 * MS_DAY); // the last ~4 weekly buckets
  const ids = [project.id];
  const [state, cur, prev, series, gCur, gSeries, qRows, pRows, crawlRows, issues] = await Promise.all([
    prisma.bingSiteState.findUnique({
      where: { projectId: project.id },
      select: { isVerified: true, lastTrafficAt: true, lastCrawlAt: true, lastQueriesAt: true, lastIssuesAt: true, errorCode: true, errorAt: true },
    }),
    getBingSeries(ids, w.cur),
    getBingSeries(ids, w.prev),
    getBingSeries(ids, { start: seriesStart, end: w.cur.end }),
    project.gscSiteUrl ? googleTotals(project.id, w.cur) : Promise.resolve(null),
    project.gscSiteUrl
      ? prisma.gscDailyMetric.findMany({ where: { projectId: project.id, date: { gte: seriesStart, lte: w.cur.end } }, select: { date: true, clicks: true } })
      : Promise.resolve([]),
    loadWeeklyQueries(ids, { start: weeklyFrom, end: w.cur.end }, 5000),
    loadWeeklyPages(ids, { start: weeklyFrom, end: w.cur.end }, 5000),
    prisma.bingCrawlDaily.findMany({ where: { projectId: project.id, date: { gte: seriesStart } }, orderBy: { date: 'asc' } }),
    crawlIssueSummary(ids, { now, listTake: 100 }),
  ]);
  const gBy = new Map((gSeries || []).map((r) => [new Date(r.date).toISOString().slice(0, 10), r.clicks || 0]));
  const latest = (crawlRows || []).length ? crawlRows[crawlRows.length - 1] : null;
  return {
    ...base,
    linked: true,
    state: state || null,
    traffic: {
      days: STAFF_DAYS,
      from: w.cur.start.toISOString().slice(0, 10),
      to: w.cur.end.toISOString().slice(0, 10),
      clicks: cur.totals.clicks,
      impressions: cur.totals.impressions,
      ctr: cur.totals.ctr,
      clicksDelta: prev.hasActivity ? pct(cur.totals.clicks, prev.totals.clicks) : null,
      impressionsDelta: prev.hasActivity ? pct(cur.totals.impressions, prev.totals.impressions) : null,
      google: gCur,
      bingShareClicks: gCur ? bingShare(cur.totals.clicks, gCur.clicks) : null,
      series: series.series.map((r) => ({ date: r.date, clicks: r.clicks, impressions: r.impressions, googleClicks: gBy.get(r.date) ?? 0 })),
    },
    queries: aggregateWeekly(qRows, 'query').slice(0, 50),
    pages: aggregateWeekly(pRows, 'url').slice(0, 50),
    crawl: {
      latest: latest
        ? {
            date: new Date(latest.date).toISOString().slice(0, 10),
            crawledPages: latest.crawledPages,
            inIndex: latest.inIndex,
            inLinks: latest.inLinks,
            code2xx: latest.code2xx,
            code301: latest.code301,
            code302: latest.code302,
            code4xx: latest.code4xx,
            code5xx: latest.code5xx,
            blockedByRobotsTxt: latest.blockedByRobotsTxt,
            containsMalware: latest.containsMalware,
            crawlErrors: latest.crawlErrors,
          }
        : null,
      series: (crawlRows || []).map((r) => ({ date: new Date(r.date).toISOString().slice(0, 10), crawledPages: r.crawledPages || 0, inIndex: r.inIndex || 0, errors: crawlErrors(r) })),
      issues: { open: issues.open, byLabel: issues.byLabel, resolved30d: issues.resolved30d, list: issues.list },
    },
    ranks,
  };
}

/** One plain-language sentence for the client tile. Pure. */
export function clientBingSentence({ clicks, clicksChangePct, sharePct }) {
  if (!clicks) return 'Bing has not sent visits from search yet this month. We keep your site in good shape for Bing too.';
  const visits = `${clicks} visit${clicks === 1 ? '' : 's'}`;
  let s = `Bing search brought ${visits} in the last 4 weeks`;
  if (clicksChangePct != null && Math.abs(clicksChangePct) >= 5) s += `, ${clicksChangePct > 0 ? 'up' : 'down'} ${Math.round(Math.abs(clicksChangePct))}% on the 4 weeks before`;
  s += '.';
  if (sharePct != null) s += ` That is about ${Math.round(sharePct)}% of your search visits from Google and Bing together.`;
  return s;
}

/**
 * Client tile (allow-list). → { linked: false } | { linked, clicks28, impressions28, clicksChangePct,
 * shareOfSearchClicksPct, trend: [{date, clicks}], sentence, updatedAt }
 */
export async function clientBingSummary(project, { now = new Date() } = {}) {
  if (!project?.bingSiteUrl) return { linked: false };
  const w = staffWindows(now);
  const ids = [project.id];
  const [cur, prev, g] = await Promise.all([
    getBingSeries(ids, w.cur),
    getBingSeries(ids, w.prev),
    project.gscSiteUrl ? googleTotals(project.id, w.cur) : Promise.resolve(null),
  ]);
  const clicksChangePct = prev.hasActivity ? pct(cur.totals.clicks, prev.totals.clicks) : null;
  const share = g ? bingShare(cur.totals.clicks, g.clicks) : null;
  return {
    linked: true,
    clicks28: cur.totals.clicks,
    impressions28: cur.totals.impressions,
    clicksChangePct,
    shareOfSearchClicksPct: share,
    trend: cur.series.map((r) => ({ date: r.date, clicks: r.clicks })),
    sentence: clientBingSentence({ clicks: cur.totals.clicks, clicksChangePct, sharePct: share }),
    updatedAt: project.bingLastSyncedAt ? new Date(project.bingLastSyncedAt).toISOString().slice(0, 10) : null,
  };
}

/** OWNER fleet table: one row per project with a Bing site (active clients), errors first. */
export async function bingFleet({ now = new Date(), sites = null } = {}) {
  const projects = await prisma.project.findMany({
    where: { bingSiteUrl: { not: null }, client: { isActive: true } },
    select: { id: true, name: true, clientId: true, bingSiteUrl: true, bingLastSyncedAt: true, bingSyncError: true, client: { select: { agencyName: true } } },
    take: 1000,
  });
  if (!projects.length) return { projects: [] };
  const ids = projects.map((p) => p.id);
  const w = staffWindows(now);
  const [clicks, issues, states] = await Promise.all([
    prisma.bingDailyMetric.groupBy({ by: ['projectId'], where: { projectId: { in: ids }, date: { gte: w.cur.start, lte: w.cur.end } }, _sum: { clicks: true } }),
    prisma.bingCrawlIssue.groupBy({ by: ['projectId'], where: { projectId: { in: ids }, resolvedAt: null }, _count: { _all: true } }),
    prisma.bingSiteState.findMany({ where: { projectId: { in: ids } }, select: { projectId: true, isVerified: true, errorCode: true } }),
  ]);
  const clickBy = new Map((clicks || []).map((r) => [r.projectId, r._sum?.clicks ?? 0]));
  const issueBy = new Map((issues || []).map((r) => [r.projectId, r._count?._all ?? 0]));
  const stateBy = new Map((states || []).map((s) => [s.projectId, s]));
  const verifiedSet = Array.isArray(sites) ? new Set(sites.filter((s) => s.verified).map((s) => s.siteUrl)) : null;
  const rows = projects.map((p) => ({
    projectId: p.id,
    name: p.name,
    clientId: p.clientId,
    client: p.client?.agencyName || null,
    bingSiteUrl: p.bingSiteUrl,
    verified: verifiedSet ? verifiedSet.has(p.bingSiteUrl) : stateBy.get(p.id)?.isVerified ?? null,
    lastSyncedAt: p.bingLastSyncedAt,
    clicks28: clickBy.get(p.id) ?? 0,
    openIssues: issueBy.get(p.id) ?? 0,
    error: p.bingSyncError || null,
    errorCode: stateBy.get(p.id)?.errorCode || null,
  }));
  rows.sort((a, b) => (b.error ? 1 : 0) - (a.error ? 1 : 0) || String(a.client).localeCompare(String(b.client)) || String(a.name).localeCompare(String(b.name)));
  return { projects: rows };
}
