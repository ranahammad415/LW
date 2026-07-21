/**
 * Section builders for cycle-aware analytics views (GSC / GA4 / GMB / SEO / LLM).
 */
import { prisma } from '../prisma.js';
import { resolveCycle } from '../workCycle.js';
import { buildClientAnalytics } from './freezeSnapshot.js';
import { getClientTrafficSeries } from './gscSeries.js';

function cycleRange(cycle) {
  const start = new Date(Date.UTC(cycle.year, cycle.month - 1, 1));
  const end = new Date(Date.UTC(cycle.year, cycle.month, 0));
  return { start, end };
}

function pctDelta(curr, prev) {
  if (prev === 0) return curr === 0 ? 0 : 100;
  return Number((((curr - prev) / prev) * 100).toFixed(1));
}

/** First/last day (UTC) of the calendar month before a cycle. */
function previousCycleRange(cycle) {
  const start = new Date(Date.UTC(cycle.year, cycle.month - 2, 1));
  const end = new Date(Date.UTC(cycle.year, cycle.month - 1, 0));
  return { start, end };
}

const MS_DAY = 86400000;

/** Equal-length window immediately preceding [start, end] (GSC-style compare). */
function previousWindow(start, end) {
  const lengthDays = Math.round((end.getTime() - start.getTime()) / MS_DAY) + 1;
  const prevEnd = new Date(start.getTime() - MS_DAY);
  const prevStart = new Date(prevEnd.getTime() - (lengthDays - 1) * MS_DAY);
  return { start: prevStart, end: prevEnd };
}

/** Parse a YYYY-MM-DD query param into a UTC Date, or null when invalid. */
function parseRangeDate(value) {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Human label for an explicit date range, e.g. "Jul 1 – Jul 18, 2026". */
function humanRange(start, end) {
  const fmt = (d) => d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `${fmt(start)} – ${fmt(end)}`;
}

/** Response `cycle` meta, overriding the label with the range label when set. */
function metaCycle(ctx) {
  const c = ctx.cycle;
  return { id: c.id, month: c.month, year: c.year, label: ctx.rangeLabel ?? c.label, status: c.status };
}

/** Response `range` meta echoing the resolved window. */
function metaRange(ctx) {
  const toISO = (d) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
  return {
    start: toISO(ctx.range.start),
    end: toISO(ctx.range.end),
    label: ctx.rangeLabel ?? ctx.cycle?.label ?? null,
  };
}

/**
 * Merge a previous-period series into the current one by day-of-month index,
 * adding `<key>Prev` fields so charts can overlay the prior period. Returns a
 * new array; leaves rows untouched where no matching previous day exists.
 */
function attachPrevSeries(series, prevSeries, keys) {
  const prevByDom = new Map();
  for (const r of prevSeries) {
    const dom = Number(String(r.date).slice(8, 10));
    if (!Number.isNaN(dom)) prevByDom.set(dom, r);
  }
  return series.map((r) => {
    const dom = Number(String(r.date).slice(8, 10));
    const prev = prevByDom.get(dom);
    if (!prev) return { ...r };
    const out = { ...r };
    for (const k of keys) out[`${k}Prev`] = prev[k] ?? 0;
    return out;
  });
}

/** Roll GA4 daily rows up into a per-day series + period totals. */
function aggregateGa4Rows(rows) {
  const seriesMap = new Map();
  for (const r of rows) {
    const key = r.date.toISOString().slice(0, 10);
    const acc = seriesMap.get(key) || {
      date: key,
      sessions: 0,
      totalUsers: 0,
      conversions: 0,
      pageViews: 0,
      bounceRate: 0,
      avgEngagementSec: 0,
      _n: 0,
    };
    acc.sessions += r.sessions;
    acc.totalUsers += r.totalUsers;
    acc.conversions += r.conversions;
    acc.pageViews += r.pageViews;
    acc.bounceRate += r.bounceRate;
    acc.avgEngagementSec += r.avgEngagementSec;
    acc._n += 1;
    seriesMap.set(key, acc);
  }
  const series = [...seriesMap.values()].map((r) => ({
    date: r.date,
    sessions: r.sessions,
    totalUsers: r.totalUsers,
    conversions: r.conversions,
    pageViews: r.pageViews,
    bounceRate: r._n ? Number((r.bounceRate / r._n).toFixed(2)) : 0,
    avgEngagementSec: r._n ? Number((r.avgEngagementSec / r._n).toFixed(1)) : 0,
  }));
  const totals = series.reduce(
    (a, r) => ({
      sessions: a.sessions + r.sessions,
      users: a.users + r.totalUsers,
      conversions: a.conversions + r.conversions,
      pageViews: a.pageViews + r.pageViews,
    }),
    { sessions: 0, users: 0, conversions: 0, pageViews: 0 }
  );
  const bounceRate = series.length
    ? Number((series.reduce((s, r) => s + r.bounceRate, 0) / series.length).toFixed(2))
    : 0;
  return { series, totals, bounceRate };
}

function isBrandQuery(query, brandTokens) {
  const q = String(query || '').toLowerCase();
  return brandTokens.some((t) => t && q.includes(t));
}

async function clientProjects(clientId) {
  return prisma.project.findMany({
    where: { clientId },
    select: {
      id: true,
      name: true,
      gscSiteUrl: true,
      ga4PropertyId: true,
      gmbLocationId: true,
      gmbCid: true,
      dataforseoDomain: true,
      client: { select: { agencyName: true, websiteUrl: true } },
    },
  });
}

async function resolveAnalyticsContext(clientIds, query) {
  const clientId = clientIds[0];
  const cycle = await resolveCycle({
    cycleId: query?.cycle,
    month: query?.month,
    year: query?.year,
  });
  if (!cycle) return { error: { status: 404, message: 'Work cycle not found' } };
  const projects = await clientProjects(clientId);
  const projectIds = projects.map((p) => p.id);
  const links = {
    gsc: projects.some((p) => !!p.gscSiteUrl),
    ga4: projects.some((p) => !!p.ga4PropertyId),
    gmb: projects.some((p) => !!p.gmbLocationId || !!p.gmbCid),
    seo: projects.some((p) => !!p.dataforseoDomain),
  };

  // Compare-to-previous is on unless explicitly disabled (?compare=0).
  const compare = !(query?.compare === '0' || query?.compare === false || query?.compare === 'false');

  // Explicit date range (GSC-style period selector) overrides the cycle month.
  const rangeStart = parseRangeDate(query?.start);
  const rangeEnd = parseRangeDate(query?.end);
  let range;
  let prevRange;
  let rangeLabel = null;
  let mode;
  if (rangeStart && rangeEnd) {
    const s = rangeStart <= rangeEnd ? rangeStart : rangeEnd;
    const e = rangeStart <= rangeEnd ? rangeEnd : rangeStart;
    range = { start: s, end: e };
    prevRange = compare ? previousWindow(s, e) : null;
    rangeLabel = humanRange(s, e);
    mode = 'range';
  } else {
    range = cycleRange(cycle);
    prevRange = compare ? previousCycleRange(cycle) : null;
    mode = 'cycle';
  }

  // Frozen snapshots only apply in cycle mode for a CLOSED month.
  let frozen = null;
  if (mode === 'cycle' && cycle.status === 'CLOSED') {
    const snap = await prisma.workCycleAnalyticsSnapshot.findUnique({
      where: { workCycleId_clientId: { workCycleId: cycle.id, clientId } },
    });
    frozen = snap?.data || null;
  }

  return {
    clientId,
    cycle,
    projects,
    projectIds,
    links,
    range,
    prevRange,
    rangeLabel,
    mode,
    compare,
    frozen,
    source:
      mode === 'cycle' && cycle.status === 'CLOSED' ? (frozen ? 'frozen' : 'computed') : 'live',
  };
}

function empty(linked, reason, cycle, source) {
  return {
    linked,
    emptyReason: linked ? null : reason,
    cycle: cycle
      ? { id: cycle.id, month: cycle.month, year: cycle.year, label: cycle.label, status: cycle.status }
      : null,
    source: source || 'none',
    data: null,
  };
}

export async function buildOverview(clientIds, query) {
  const ctx = await resolveAnalyticsContext(clientIds, query);
  if (ctx.error) return ctx.error;
  const data =
    ctx.frozen ||
    (await buildClientAnalytics(ctx.clientId, ctx.cycle, { range: ctx.range, prevRange: ctx.prevRange }));
  return {
    linked: !!(ctx.links.gsc || ctx.links.ga4 || ctx.links.gmb),
    emptyReason:
      ctx.links.gsc || ctx.links.ga4 || ctx.links.gmb
        ? null
        : 'Connect GSC, GA4, or Business Profile in Admin → Integrations',
    cycle: metaCycle(ctx),
    range: metaRange(ctx),
    source: ctx.source,
    data,
    links: ctx.links,
  };
}

export async function buildGscView(clientIds, view, query) {
  const ctx = await resolveAnalyticsContext(clientIds, query);
  if (ctx.error) return ctx.error;
  if (!ctx.links.gsc) {
    return empty(false, 'Connect a Search Console property in Admin → Integrations', ctx.cycle, ctx.source);
  }

  const { start, end } = ctx.range;
  const traffic = await getClientTrafficSeries(ctx.clientId, { start, end });

  // Previous comparable period for deltas (skipped when compare is off).
  const prevTraffic = ctx.prevRange
    ? await getClientTrafficSeries(ctx.clientId, { start: ctx.prevRange.start, end: ctx.prevRange.end })
    : null;

  const brandTokens = [
    ...new Set(
      ctx.projects
        .flatMap((p) => [p.client?.agencyName, p.client?.websiteUrl, p.gscSiteUrl])
        .filter(Boolean)
        .map((s) =>
          String(s)
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/^sc-domain:/, '')
            .split(/[./\s-]+/)[0]
        )
        .filter((t) => t && t.length > 2)
    ),
  ];

  const queryRows = ctx.projectIds.length
    ? await prisma.gscQueryMetric.findMany({
        where: { projectId: { in: ctx.projectIds }, date: { gte: start, lte: end } },
        orderBy: { impressions: 'desc' },
        take: 500,
      })
    : [];

  // Aggregate queries across days
  const byQuery = new Map();
  for (const r of queryRows) {
    const acc = byQuery.get(r.query) || { query: r.query, clicks: 0, impressions: 0, posWeight: 0 };
    acc.clicks += r.clicks;
    acc.impressions += r.impressions;
    acc.posWeight += r.position * (r.impressions || 1);
    byQuery.set(r.query, acc);
  }
  const queries = [...byQuery.values()]
    .map((q) => ({
      query: q.query,
      clicks: q.clicks,
      impressions: q.impressions,
      ctr: q.impressions > 0 ? Number(((q.clicks / q.impressions) * 100).toFixed(2)) : 0,
      position: q.impressions > 0 ? Number((q.posWeight / q.impressions).toFixed(1)) : 0,
      brand: isBrandQuery(q.query, brandTokens) ? 'Brand' : 'Generic',
      wordCount: String(q.query).trim().split(/\s+/).filter(Boolean).length,
    }))
    .sort((a, b) => b.impressions - a.impressions);

  const brand = queries.filter((q) => q.brand === 'Brand');
  const generic = queries.filter((q) => q.brand === 'Generic');
  const sum = (arr, key) => arr.reduce((s, x) => s + x[key], 0);

  const rankings = {
    top3: queries.filter((q) => q.position > 0 && q.position <= 3).length,
    top10: queries.filter((q) => q.position > 0 && q.position <= 10).length,
    top20: queries.filter((q) => q.position > 0 && q.position <= 20).length,
    rest: queries.filter((q) => q.position > 20 || q.position === 0).length,
  };

  const shortTail = queries.filter((q) => q.wordCount <= 2);
  const longTail = queries.filter((q) => q.wordCount >= 3);
  const lengthBuckets = Array.from({ length: 10 }, (_, i) => {
    const len = i + 1;
    const bucket = queries.filter((q) => (len === 10 ? q.wordCount >= 10 : q.wordCount === len));
    return { length: len === 10 ? '10+' : String(len), keywords: bucket.length, clicks: sum(bucket, 'clicks') };
  });

  const totals = traffic.totals;
  const prev = prevTraffic?.totals ?? null;

  const data = {
    kpis: {
      clicks: totals.clicks,
      impressions: totals.impressions,
      ctr: totals.ctr,
      position: totals.position,
      uniqueQueries: queries.length,
      clicksDelta: prev ? pctDelta(totals.clicks, prev.clicks) : null,
      impressionsDelta: prev ? pctDelta(totals.impressions, prev.impressions) : null,
      ctrDelta: prev ? pctDelta(totals.ctr, prev.ctr) : null,
      positionDelta: prev ? pctDelta(totals.position, prev.position) : null,
    },
    series: traffic.series,
    brandGeneric: {
      brand: { keywords: brand.length, clicks: sum(brand, 'clicks'), impressions: sum(brand, 'impressions') },
      generic: { keywords: generic.length, clicks: sum(generic, 'clicks'), impressions: sum(generic, 'impressions') },
      queries: queries.slice(0, 100),
    },
    keywordAnalysis: {
      shortTail: { keywords: shortTail.length, clicks: sum(shortTail, 'clicks') },
      longTail: { keywords: longTail.length, clicks: sum(longTail, 'clicks') },
      lengthBuckets,
      queries: queries.slice(0, 100),
    },
    rankings: {
      ...rankings,
      improved: queries.filter((q) => q.position > 0 && q.position <= 10).slice(0, 25),
      declined: queries.filter((q) => q.position > 10).slice(0, 25),
    },
    queries: queries.slice(0, 200),
  };

  // View-specific trim
  const viewData =
    view === 'organic'
      ? { kpis: data.kpis, series: data.series, rankings: data.rankings }
      : view === 'brand-generic'
        ? { brandGeneric: data.brandGeneric, kpis: data.kpis }
        : view === 'keywords'
          ? { keywordAnalysis: data.keywordAnalysis }
          : view === 'rankings'
            ? { rankings: data.rankings, queries: data.queries }
            : view === 'time'
              ? { series: data.series, kpis: data.kpis }
              : data;

  return {
    linked: true,
    emptyReason: null,
    cycle: metaCycle(ctx),
    range: metaRange(ctx),
    source: ctx.source,
    data: viewData,
  };
}

export async function buildGa4View(clientIds, view, query) {
  const ctx = await resolveAnalyticsContext(clientIds, query);
  if (ctx.error) return ctx.error;
  if (!ctx.links.ga4) {
    return empty(false, 'Connect a GA4 property in Admin → Integrations', ctx.cycle, ctx.source);
  }

  const { start, end } = ctx.range;
  const prevRange = ctx.prevRange;
  const [rows, prevRows] = await Promise.all([
    prisma.ga4DailyMetric.findMany({
      where: { projectId: { in: ctx.projectIds }, date: { gte: start, lte: end } },
      orderBy: { date: 'asc' },
    }),
    prevRange
      ? prisma.ga4DailyMetric.findMany({
          where: { projectId: { in: ctx.projectIds }, date: { gte: prevRange.start, lte: prevRange.end } },
          orderBy: { date: 'asc' },
        })
      : Promise.resolve([]),
  ]);

  const curr = aggregateGa4Rows(rows);
  const prevAgg = aggregateGa4Rows(prevRows);
  const hasPrev = prevRows.length > 0;
  const series = attachPrevSeries(curr.series, prevAgg.series, [
    'sessions',
    'totalUsers',
    'conversions',
    'pageViews',
  ]);
  const totals = curr.totals;
  const conversionRate = totals.sessions > 0 ? Number(((totals.conversions / totals.sessions) * 100).toFixed(2)) : 0;
  const prevConversionRate =
    prevAgg.totals.sessions > 0
      ? Number(((prevAgg.totals.conversions / prevAgg.totals.sessions) * 100).toFixed(2))
      : 0;

  // Latest breakdowns from most recent row that has them
  let breakdowns = {};
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].breakdowns) {
      breakdowns = rows[i].breakdowns;
      break;
    }
  }

  const data = {
    kpis: {
      ...totals,
      bounceRate: curr.bounceRate,
      conversionRate,
      sessionsDelta: hasPrev ? pctDelta(totals.sessions, prevAgg.totals.sessions) : null,
      usersDelta: hasPrev ? pctDelta(totals.users, prevAgg.totals.users) : null,
      conversionsDelta: hasPrev ? pctDelta(totals.conversions, prevAgg.totals.conversions) : null,
      pageViewsDelta: hasPrev ? pctDelta(totals.pageViews, prevAgg.totals.pageViews) : null,
      bounceRateDelta: hasPrev ? pctDelta(curr.bounceRate, prevAgg.bounceRate) : null,
      conversionRateDelta: hasPrev ? pctDelta(conversionRate, prevConversionRate) : null,
    },
    series,
    channels: breakdowns.channels || [],
    devices: breakdowns.devices || [],
    countries: breakdowns.countries || [],
    landingPages: breakdowns.landingPages || [],
    llmReferrers: breakdowns.llmReferrers || [],
  };

  const viewData =
    view === 'channels'
      ? {
          channels: data.channels,
          devices: data.devices,
          countries: data.countries,
          series: data.series,
          kpis: data.kpis,
        }
      : view === 'content'
        ? { landingPages: data.landingPages, series: data.series, kpis: data.kpis }
        : view === 'conversions'
          ? { series: data.series, kpis: data.kpis, channels: data.channels }
          : view === 'demographics'
            ? { countries: data.countries, devices: data.devices, kpis: data.kpis }
            : view === 'engagement'
              ? { series: data.series, kpis: data.kpis }
              : { series: data.series, kpis: data.kpis };

  return {
    linked: true,
    emptyReason: null,
    cycle: metaCycle(ctx),
    range: metaRange(ctx),
    source: ctx.source,
    data: viewData,
  };
}

export async function buildGmbView(clientIds, view, query) {
  const ctx = await resolveAnalyticsContext(clientIds, query);
  if (ctx.error) return ctx.error;
  if (!ctx.links.gmb) {
    return empty(false, 'Connect a Business Profile location in Admin → Integrations', ctx.cycle, ctx.source);
  }

  const { start, end } = ctx.range;
  const prevRange = ctx.prevRange;
  const [rows, prevRows] = await Promise.all([
    prisma.gmbDailyMetric.findMany({
      where: { projectId: { in: ctx.projectIds }, date: { gte: start, lte: end } },
      orderBy: { date: 'asc' },
    }),
    prevRange
      ? prisma.gmbDailyMetric.findMany({
          where: { projectId: { in: ctx.projectIds }, date: { gte: prevRange.start, lte: prevRange.end } },
          orderBy: { date: 'asc' },
        })
      : Promise.resolve([]),
  ]);
  const aggregateGmb = (rs) => {
    const seriesMap = new Map();
    for (const r of rs) {
      const key = r.date.toISOString().slice(0, 10);
      const acc = seriesMap.get(key) || {
        date: key,
        impressions: 0,
        impressionsSearch: 0,
        impressionsMaps: 0,
        websiteClicks: 0,
        directions: 0,
        calls: 0,
      };
      acc.impressions += r.impressions;
      acc.impressionsSearch += r.impressionsSearch;
      acc.impressionsMaps += r.impressionsMaps;
      acc.websiteClicks += r.websiteClicks;
      acc.directions += r.directions;
      acc.calls += r.calls;
      seriesMap.set(key, acc);
    }
    return [...seriesMap.values()];
  };
  const prevSeries = aggregateGmb(prevRows);
  const series = attachPrevSeries(aggregateGmb(rows), prevSeries, [
    'impressions',
    'impressionsSearch',
    'impressionsMaps',
    'websiteClicks',
    'directions',
    'calls',
  ]);
  const hasPrev = prevRows.length > 0;
  const sum = (k) => series.reduce((s, r) => s + r[k], 0);
  const prevSum = (k) => prevSeries.reduce((s, r) => s + r[k], 0);

  const reviews = await prisma.gmbReview.findMany({
    where: { projectId: { in: ctx.projectIds } },
    orderBy: { createTime: 'desc' },
    take: 200,
  });
  const avgRating = reviews.length
    ? Number((reviews.reduce((s, r) => s + r.starRating, 0) / reviews.length).toFixed(1))
    : null;
  const byStar = [5, 4, 3, 2, 1].map((star) => ({
    star,
    count: reviews.filter((r) => r.starRating === star).length,
  }));

  const data = {
    kpis: {
      impressions: sum('impressions'),
      directions: sum('directions'),
      websiteClicks: sum('websiteClicks'),
      calls: sum('calls'),
      reviews: reviews.length,
      rating: avgRating,
      searchShare:
        sum('impressions') > 0
          ? Number(((sum('impressionsSearch') / sum('impressions')) * 100).toFixed(1))
          : 0,
      mapsShare:
        sum('impressions') > 0
          ? Number(((sum('impressionsMaps') / sum('impressions')) * 100).toFixed(1))
          : 0,
      impressionsDelta: hasPrev ? pctDelta(sum('impressions'), prevSum('impressions')) : null,
      directionsDelta: hasPrev ? pctDelta(sum('directions'), prevSum('directions')) : null,
      websiteClicksDelta: hasPrev ? pctDelta(sum('websiteClicks'), prevSum('websiteClicks')) : null,
      callsDelta: hasPrev ? pctDelta(sum('calls'), prevSum('calls')) : null,
    },
    series,
    reviews: reviews.map((r) => ({
      id: r.id,
      reviewerName: r.reviewerName,
      starRating: r.starRating,
      comment: r.comment,
      replyComment: r.replyComment,
      createTime: r.createTime,
      replied: !!r.replyComment,
    })),
    byStar,
  };

  const viewData =
    view === 'reviews'
      ? { reviews: data.reviews, byStar: data.byStar, kpis: { reviews: data.kpis.reviews, rating: data.kpis.rating } }
      : view === 'actions'
        ? {
            series: data.series.map((r) => ({
              date: r.date,
              websiteClicks: r.websiteClicks,
              directions: r.directions,
              calls: r.calls,
              total: r.websiteClicks + r.directions + r.calls,
              totalPrev:
                r.websiteClicksPrev != null || r.directionsPrev != null || r.callsPrev != null
                  ? (r.websiteClicksPrev || 0) + (r.directionsPrev || 0) + (r.callsPrev || 0)
                  : undefined,
            })),
            kpis: {
              websiteClicks: data.kpis.websiteClicks,
              directions: data.kpis.directions,
              calls: data.kpis.calls,
              total: data.kpis.websiteClicks + data.kpis.directions + data.kpis.calls,
              websiteClicksDelta: data.kpis.websiteClicksDelta,
              directionsDelta: data.kpis.directionsDelta,
              callsDelta: data.kpis.callsDelta,
              totalDelta: hasPrev
                ? pctDelta(
                    data.kpis.websiteClicks + data.kpis.directions + data.kpis.calls,
                    prevSum('websiteClicks') + prevSum('directions') + prevSum('calls')
                  )
                : null,
            },
          }
        : { series: data.series, kpis: data.kpis };

  return {
    linked: true,
    emptyReason: null,
    cycle: metaCycle(ctx),
    range: metaRange(ctx),
    source: ctx.source,
    data: viewData,
  };
}

export async function buildSeoView(clientIds, _view, query) {
  const ctx = await resolveAnalyticsContext(clientIds, query);
  if (ctx.error) return ctx.error;
  if (!ctx.links.seo) {
    return empty(false, 'Set a DataForSEO domain in Admin → Integrations', ctx.cycle, ctx.source);
  }

  const keywords = await prisma.keywordTrack.findMany({
    where: { projectId: { in: ctx.projectIds } },
    select: { keyword: true, currentRank: true, volume: true, status: true },
    orderBy: { currentRank: 'asc' },
    take: 200,
  });
  const ranked = keywords.filter((k) => typeof k.currentRank === 'number');

  return {
    linked: true,
    emptyReason: null,
    cycle: metaCycle(ctx),
    range: metaRange(ctx),
    source: ctx.source,
    data: {
      kpis: {
        tracked: keywords.length,
        ranked: ranked.length,
        top3: ranked.filter((k) => k.currentRank <= 3).length,
        top10: ranked.filter((k) => k.currentRank <= 10).length,
        top20: ranked.filter((k) => k.currentRank <= 20).length,
        avgRank: ranked.length
          ? Number((ranked.reduce((s, k) => s + k.currentRank, 0) / ranked.length).toFixed(1))
          : null,
      },
      keywords,
    },
  };
}

export async function buildLlmView(clientIds, view, query) {
  const ctx = await resolveAnalyticsContext(clientIds, query);
  if (ctx.error) return ctx.error;

  const { start, end } = ctx.range;
  const prevRange = ctx.prevRange;
  const [promptsTested, cited, platformRows, prevTested, prevCited] = await Promise.all([
    prisma.promptLog.count({ where: { project: { clientId: ctx.clientId }, createdAt: { gte: start, lte: end } } }),
    prisma.promptLog.count({
      where: { project: { clientId: ctx.clientId }, createdAt: { gte: start, lte: end }, cited: true },
    }),
    prisma.promptLog.findMany({
      where: { project: { clientId: ctx.clientId }, createdAt: { gte: start, lte: end } },
      select: { platform: true, cited: true, promptQuery: true, createdAt: true },
      take: 300,
      orderBy: { createdAt: 'desc' },
    }),
    prevRange
      ? prisma.promptLog.count({
          where: { project: { clientId: ctx.clientId }, createdAt: { gte: prevRange.start, lte: prevRange.end } },
        })
      : Promise.resolve(0),
    prevRange
      ? prisma.promptLog.count({
          where: {
            project: { clientId: ctx.clientId },
            createdAt: { gte: prevRange.start, lte: prevRange.end },
            cited: true,
          },
        })
      : Promise.resolve(0),
  ]);
  const hasPrevLlm = !!prevRange && prevTested > 0;
  const prevCitationRate = prevTested > 0 ? Math.round((prevCited / prevTested) * 100) : 0;

  // LLM referrers from latest GA4 breakdown if available
  let llmReferrers = [];
  if (ctx.links.ga4) {
    const rows = await prisma.ga4DailyMetric.findMany({
      where: { projectId: { in: ctx.projectIds }, date: { gte: start, lte: end }, breakdowns: { not: null } },
      orderBy: { date: 'desc' },
      take: 5,
    });
    for (const r of rows) {
      if (r.breakdowns?.llmReferrers?.length) {
        llmReferrers = r.breakdowns.llmReferrers;
        break;
      }
    }
  }

  const byPlatform = {};
  for (const p of platformRows) {
    const key = p.platform || 'unknown';
    byPlatform[key] = byPlatform[key] || { platform: key, tested: 0, cited: 0 };
    byPlatform[key].tested++;
    if (p.cited) byPlatform[key].cited++;
  }

  const data = {
    kpis: {
      promptsTested,
      cited,
      citationRate: promptsTested > 0 ? Math.round((cited / promptsTested) * 100) : 0,
      referrers: llmReferrers.length,
      promptsTestedDelta: hasPrevLlm ? pctDelta(promptsTested, prevTested) : null,
      citedDelta: hasPrevLlm ? pctDelta(cited, prevCited) : null,
      citationRateDelta: hasPrevLlm
        ? pctDelta(promptsTested > 0 ? Math.round((cited / promptsTested) * 100) : 0, prevCitationRate)
        : null,
    },
    platforms: Object.values(byPlatform),
    llmReferrers,
    recent: platformRows.slice(0, 50),
  };

  return {
    linked: promptsTested > 0 || llmReferrers.length > 0 || ctx.links.ga4,
    emptyReason:
      promptsTested === 0 && llmReferrers.length === 0
        ? 'No AI visibility or LLM referrer data for this session yet'
        : null,
    cycle: metaCycle(ctx),
    range: metaRange(ctx),
    source: ctx.source,
    data: view === 'referrers' ? { llmReferrers, kpis: data.kpis } : data,
  };
}
