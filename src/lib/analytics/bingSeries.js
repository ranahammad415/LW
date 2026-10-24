/**
 * Bing Webmaster series and aggregations for analytics (features/bing-webmaster.md). Reads the stored tables only
 * (no live heal: Bing has no date-range query). Mirrors gscSeries.js: daily series densified over [start, end],
 * totals, `hasActivity` so deltas are computed only against real prior data.
 */
import { prisma } from '../prisma.js';

const MS_DAY = 86_400_000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const r2 = (n) => Math.round(n * 100) / 100;

/** CTR in % (2 decimals) from clicks / impressions. Pure. */
export const ctrPct = (clicks, impressions) => (impressions > 0 ? r2((clicks / impressions) * 100) : 0);

/** Densified daily Bing series + totals across `projectIds` over [start, end] (UTC dates). */
export async function getBingSeries(projectIds, { start, end }) {
  const empty = { series: [], totals: { clicks: 0, impressions: 0, ctr: 0 }, hasActivity: false, days: 0 };
  if (!projectIds?.length) return empty;
  const rows = await prisma.bingDailyMetric.findMany({
    where: { projectId: { in: projectIds }, date: { gte: start, lte: end } },
    select: { date: true, clicks: true, impressions: true },
    orderBy: { date: 'asc' },
  });
  const byDate = new Map();
  for (const r of rows || []) {
    const k = iso(r.date);
    const acc = byDate.get(k) || { clicks: 0, impressions: 0 };
    acc.clicks += r.clicks || 0;
    acc.impressions += r.impressions || 0;
    byDate.set(k, acc);
  }
  const series = [];
  for (let t = new Date(start).getTime(); t <= new Date(end).getTime(); t += MS_DAY) {
    const date = iso(t);
    const a = byDate.get(date);
    series.push({ date, clicks: a?.clicks || 0, impressions: a?.impressions || 0, ctr: a ? ctrPct(a.clicks, a.impressions) : 0 });
  }
  let clicks = 0;
  let impressions = 0;
  for (const a of byDate.values()) {
    clicks += a.clicks;
    impressions += a.impressions;
  }
  return { series, totals: { clicks, impressions, ctr: ctrPct(clicks, impressions) }, hasActivity: clicks > 0 || impressions > 0, days: byDate.size };
}

/** Projects of a client with a Bing binding. */
export async function clientBingProjectIds(clientId) {
  const rows = await prisma.project.findMany({ where: { clientId, bingSiteUrl: { not: null } }, select: { id: true } });
  return (rows || []).map((p) => p.id);
}

/** Share of Bing in (Google + Bing), %, 1 decimal; null when both are 0. Pure. */
export function bingShare(bing, google) {
  const total = (Number(bing) || 0) + (Number(google) || 0);
  return total > 0 ? Math.round(((Number(bing) || 0) / total) * 1000) / 10 : null;
}

/**
 * Weekly rows (queries or pages) whose weekStart falls in [start, end], aggregated per key: clicks, impressions, ctr %,
 * impression-weighted avgImpressionPosition (rows without a position are left out of the average). Sorted by
 * impressions. Pure.
 */
export function aggregateWeekly(rows, key) {
  const m = new Map();
  for (const r of rows || []) {
    const k = r[key];
    if (!k) continue;
    const acc = m.get(k) || { [key]: k, clicks: 0, impressions: 0, posW: 0, posImpr: 0, weeks: new Set() };
    acc.clicks += r.clicks || 0;
    acc.impressions += r.impressions || 0;
    if (typeof r.avgImpressionPosition === 'number' && r.avgImpressionPosition > 0) {
      acc.posW += r.avgImpressionPosition * (r.impressions || 0);
      acc.posImpr += r.impressions || 0;
    }
    acc.weeks.add(iso(r.weekStart));
    m.set(k, acc);
  }
  return [...m.values()]
    .map((a) => ({
      [key]: a[key],
      clicks: a.clicks,
      impressions: a.impressions,
      ctr: ctrPct(a.clicks, a.impressions),
      position: a.posImpr > 0 ? Math.round((a.posW / a.posImpr) * 10) / 10 : null,
      weeks: a.weeks.size,
    }))
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
}

/** Load weekly query rows for projects in [start, end] (≤ 20k rows). */
export async function loadWeeklyQueries(projectIds, { start, end }, take = 20_000) {
  if (!projectIds?.length) return [];
  return prisma.bingQueryWeekly.findMany({
    where: { projectId: { in: projectIds }, weekStart: { gte: start, lte: end } },
    select: { weekStart: true, query: true, clicks: true, impressions: true, avgImpressionPosition: true },
    orderBy: { impressions: 'desc' },
    take,
  });
}

export async function loadWeeklyPages(projectIds, { start, end }, take = 20_000) {
  if (!projectIds?.length) return [];
  return prisma.bingPageWeekly.findMany({
    where: { projectId: { in: projectIds }, weekStart: { gte: start, lte: end } },
    select: { weekStart: true, url: true, clicks: true, impressions: true, avgImpressionPosition: true },
    orderBy: { impressions: 'desc' },
    take,
  });
}

/** Copilot referrals (GA4 LlmReferralDaily platform 'copilot') in [start, end]: the honest "Copilot" number we have. */
export async function copilotReferrals(projectIds, { start, end }) {
  if (!projectIds?.length) return 0;
  const rows = await prisma.llmReferralDaily.findMany({
    where: { projectId: { in: projectIds }, platform: 'copilot', date: { gte: start, lte: end } },
    select: { sessions: true },
  });
  return (rows || []).reduce((s, r) => s + (r.sessions || 0), 0);
}

/** Crawl error count of a BingCrawlDaily row (4xx + 5xx + crawl errors). Pure. */
export const crawlErrors = (r) => (r?.code4xx || 0) + (r?.code5xx || 0) + (r?.crawlErrors || 0);

/** Open crawl issues grouped by label + resolved in the last 30 days, for projects. */
export async function crawlIssueSummary(projectIds, { now = new Date(), listTake = 0 } = {}) {
  if (!projectIds?.length) return { open: 0, byLabel: [], resolved30d: 0, list: [] };
  const [open, resolved30d] = await Promise.all([
    prisma.bingCrawlIssue.findMany({
      where: { projectId: { in: projectIds }, resolvedAt: null },
      select: { url: true, httpCode: true, issues: true, inLinks: true, firstSeenAt: true },
      orderBy: { inLinks: 'desc' },
      take: 5000,
    }),
    prisma.bingCrawlIssue.count({ where: { projectId: { in: projectIds }, resolvedAt: { gte: new Date(now.getTime() - 30 * MS_DAY) } } }),
  ]);
  const counts = new Map();
  for (const r of open || []) {
    const labels = Array.isArray(r.issues) && r.issues.length ? r.issues : [{ key: 'other', label: 'Other issue' }];
    for (const l of labels) counts.set(l.label, (counts.get(l.label) || 0) + 1);
  }
  return {
    open: (open || []).length,
    byLabel: [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    resolved30d: resolved30d || 0,
    list: listTake
      ? (open || []).slice(0, listTake).map((r) => ({
          url: r.url,
          httpCode: r.httpCode,
          labels: Array.isArray(r.issues) ? r.issues.map((l) => l.label) : [],
          inLinks: r.inLinks,
          firstSeenAt: r.firstSeenAt,
        }))
      : [],
  };
}
