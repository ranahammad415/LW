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

/** Shift a UTC date back one calendar year, clamping invalid days (e.g. Feb 29). */
function shiftYearBack(d) {
  const y = d.getUTCFullYear() - 1;
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, lastDay)));
}

/** Same calendar window one year earlier (YoY compare). */
function previousYearWindow(start, end) {
  return { start: shiftYearBack(start), end: shiftYearBack(end) };
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
  const out = {
    start: toISO(ctx.range.start),
    end: toISO(ctx.range.end),
    label: ctx.rangeLabel ?? ctx.cycle?.label ?? null,
  };
  if (ctx.yoyRange) {
    out.yoy = {
      start: toISO(ctx.yoyRange.start),
      end: toISO(ctx.yoyRange.end),
      label: humanRange(ctx.yoyRange.start, ctx.yoyRange.end),
    };
  }
  return out;
}

/**
 * Fill every calendar day in [start, end] from a sparse series so equal-length
 * compare windows can be index-zipped for chart overlays.
 */
function densifyDailySeries(start, end, sparseSeries, keys) {
  const byDate = new Map();
  for (const r of sparseSeries || []) {
    const key = String(r.date).slice(0, 10);
    byDate.set(key, r);
  }
  const out = [];
  const s = start instanceof Date ? start : new Date(`${String(start).slice(0, 10)}T00:00:00.000Z`);
  const e = end instanceof Date ? end : new Date(`${String(end).slice(0, 10)}T00:00:00.000Z`);
  for (let t = s.getTime(); t <= e.getTime(); t += MS_DAY) {
    const date = new Date(t).toISOString().slice(0, 10);
    const src = byDate.get(date);
    if (src) {
      out.push({ ...src, date });
    } else {
      const row = { date };
      for (const k of keys) row[k] = 0;
      out.push(row);
    }
  }
  return out;
}

/**
 * Merge a compare series into the current one by day index (equal-length windows),
 * adding `<key><suffix>` fields so charts can overlay on the current x-axis.
 */
function attachAlignedSeries(series, otherSeries, keys, suffix) {
  return (series || []).map((r, i) => {
    const other = (otherSeries || [])[i];
    if (!other) return { ...r };
    const out = { ...r };
    for (const k of keys) out[`${k}${suffix}`] = other[k] ?? 0;
    return out;
  });
}

/** Previous-period overlay (`*Prev` keys). */
function attachPrevSeries(series, prevSeries, keys) {
  return attachAlignedSeries(series, prevSeries, keys, 'Prev');
}

/** Year-over-year overlay (`*Yoy` keys). */
function attachYoySeries(series, yoySeries, keys) {
  return attachAlignedSeries(series, yoySeries, keys, 'Yoy');
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
      gmbLocationName: true,
      dataforseoDomain: true,
      targetMarket: true,
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

  // Compare-to-previous / YoY are on unless explicitly disabled (?compare=0 / ?compareYoY=0).
  const compare = !(query?.compare === '0' || query?.compare === false || query?.compare === 'false');
  const compareYoY = !(
    query?.compareYoY === '0' ||
    query?.compareYoY === false ||
    query?.compareYoY === 'false'
  );

  // Explicit date range (GSC-style period selector) overrides the cycle month.
  const rangeStart = parseRangeDate(query?.start);
  const rangeEnd = parseRangeDate(query?.end);
  let range;
  let prevRange;
  let yoyRange;
  let rangeLabel = null;
  let mode;
  if (rangeStart && rangeEnd) {
    const s = rangeStart <= rangeEnd ? rangeStart : rangeEnd;
    const e = rangeStart <= rangeEnd ? rangeEnd : rangeStart;
    range = { start: s, end: e };
    prevRange = compare ? previousWindow(s, e) : null;
    yoyRange = compareYoY ? previousYearWindow(s, e) : null;
    rangeLabel = humanRange(s, e);
    mode = 'range';
  } else {
    range = cycleRange(cycle);
    prevRange = compare ? previousCycleRange(cycle) : null;
    yoyRange = compareYoY ? previousYearWindow(range.start, range.end) : null;
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
    yoyRange,
    rangeLabel,
    mode,
    compare,
    compareYoY,
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
    (await buildClientAnalytics(ctx.clientId, ctx.cycle, {
      range: ctx.range,
      prevRange: ctx.prevRange,
      yoyRange: ctx.yoyRange,
    }));
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

  // Previous / YoY comparable periods for deltas (skipped when compare flags are off).
  const [prevTraffic, yoyTraffic] = await Promise.all([
    ctx.prevRange
      ? getClientTrafficSeries(ctx.clientId, { start: ctx.prevRange.start, end: ctx.prevRange.end })
      : Promise.resolve(null),
    ctx.yoyRange
      ? getClientTrafficSeries(ctx.clientId, { start: ctx.yoyRange.start, end: ctx.yoyRange.end })
      : Promise.resolve(null),
  ]);

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
  const prev = prevTraffic?.hasActivity ? prevTraffic.totals : null;
  const yoy = yoyTraffic?.hasActivity ? yoyTraffic.totals : null;
  const gscSeriesKeys = ['clicks', 'impressions', 'ctr', 'position'];

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
      clicksYoyDelta: yoy ? pctDelta(totals.clicks, yoy.clicks) : null,
      impressionsYoyDelta: yoy ? pctDelta(totals.impressions, yoy.impressions) : null,
      ctrYoyDelta: yoy ? pctDelta(totals.ctr, yoy.ctr) : null,
      positionYoyDelta: yoy ? pctDelta(totals.position, yoy.position) : null,
    },
    // GSC series is already densified; index-zip YoY (and prev when present).
    series: attachYoySeries(
      attachPrevSeries(traffic.series, prevTraffic?.series || [], gscSeriesKeys),
      yoyTraffic?.series || [],
      gscSeriesKeys
    ),
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
  const yoyRange = ctx.yoyRange;
  const [rows, prevRows, yoyRows] = await Promise.all([
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
    yoyRange
      ? prisma.ga4DailyMetric.findMany({
          where: { projectId: { in: ctx.projectIds }, date: { gte: yoyRange.start, lte: yoyRange.end } },
          orderBy: { date: 'asc' },
        })
      : Promise.resolve([]),
  ]);

  const curr = aggregateGa4Rows(rows);
  const prevAgg = aggregateGa4Rows(prevRows);
  const yoyAgg = aggregateGa4Rows(yoyRows);
  const hasPrev = prevRows.length > 0;
  const hasYoy = yoyRows.length > 0;
  const ga4SeriesKeys = ['sessions', 'totalUsers', 'conversions', 'pageViews'];
  const currSeries = densifyDailySeries(start, end, curr.series, ga4SeriesKeys);
  const prevSeriesDense = prevRange
    ? densifyDailySeries(prevRange.start, prevRange.end, prevAgg.series, ga4SeriesKeys)
    : [];
  const yoySeriesDense = yoyRange
    ? densifyDailySeries(yoyRange.start, yoyRange.end, yoyAgg.series, ga4SeriesKeys)
    : [];
  const series = attachYoySeries(
    attachPrevSeries(currSeries, prevSeriesDense, ga4SeriesKeys),
    yoySeriesDense,
    ga4SeriesKeys
  );
  const totals = curr.totals;
  const conversionRate = totals.sessions > 0 ? Number(((totals.conversions / totals.sessions) * 100).toFixed(2)) : 0;
  const prevConversionRate =
    prevAgg.totals.sessions > 0
      ? Number(((prevAgg.totals.conversions / prevAgg.totals.sessions) * 100).toFixed(2))
      : 0;
  const yoyConversionRate =
    yoyAgg.totals.sessions > 0
      ? Number(((yoyAgg.totals.conversions / yoyAgg.totals.sessions) * 100).toFixed(2))
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
      sessionsYoyDelta: hasYoy ? pctDelta(totals.sessions, yoyAgg.totals.sessions) : null,
      usersYoyDelta: hasYoy ? pctDelta(totals.users, yoyAgg.totals.users) : null,
      conversionsYoyDelta: hasYoy ? pctDelta(totals.conversions, yoyAgg.totals.conversions) : null,
      pageViewsYoyDelta: hasYoy ? pctDelta(totals.pageViews, yoyAgg.totals.pageViews) : null,
      bounceRateYoyDelta: hasYoy ? pctDelta(curr.bounceRate, yoyAgg.bounceRate) : null,
      conversionRateYoyDelta: hasYoy ? pctDelta(conversionRate, yoyConversionRate) : null,
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

  const reviewCountEarly = ctx.projectIds.length
    ? await prisma.gmbReview.count({ where: { projectId: { in: ctx.projectIds } } })
    : 0;

  if (!ctx.links.gmb && reviewCountEarly === 0) {
    return empty(
      false,
      'Connect a Business Profile location (or paste Maps/CID for DataForSEO) in Admin → Integrations',
      ctx.cycle,
      ctx.source
    );
  }

  const { start, end } = ctx.range;
  const prevRange = ctx.prevRange;
  const yoyRange = ctx.yoyRange;
  const [rows, prevRows, yoyRows] = await Promise.all([
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
    yoyRange
      ? prisma.gmbDailyMetric.findMany({
          where: { projectId: { in: ctx.projectIds }, date: { gte: yoyRange.start, lte: yoyRange.end } },
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
  const gmbSeriesKeys = [
    'impressions',
    'impressionsSearch',
    'impressionsMaps',
    'websiteClicks',
    'directions',
    'calls',
  ];
  const prevSeries = densifyDailySeries(
    prevRange?.start || start,
    prevRange?.end || end,
    aggregateGmb(prevRows),
    gmbSeriesKeys
  );
  const yoySeries = densifyDailySeries(
    yoyRange?.start || start,
    yoyRange?.end || end,
    aggregateGmb(yoyRows),
    gmbSeriesKeys
  );
  const currGmbSeries = densifyDailySeries(start, end, aggregateGmb(rows), gmbSeriesKeys);
  const series = attachYoySeries(
    attachPrevSeries(currGmbSeries, prevRange ? prevSeries : [], gmbSeriesKeys),
    yoyRange ? yoySeries : [],
    gmbSeriesKeys
  );
  const hasPrev = prevRows.length > 0;
  const hasYoy = yoyRows.length > 0;
  const sum = (k) => series.reduce((s, r) => s + r[k], 0);
  const prevSum = (k) => prevSeries.reduce((s, r) => s + r[k], 0);
  const yoySum = (k) => yoySeries.reduce((s, r) => s + r[k], 0);

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
      impressionsYoyDelta: hasYoy ? pctDelta(sum('impressions'), yoySum('impressions')) : null,
      directionsYoyDelta: hasYoy ? pctDelta(sum('directions'), yoySum('directions')) : null,
      websiteClicksYoyDelta: hasYoy ? pctDelta(sum('websiteClicks'), yoySum('websiteClicks')) : null,
      callsYoyDelta: hasYoy ? pctDelta(sum('calls'), yoySum('calls')) : null,
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

  const hasNativeMetrics = rows.length > 0;
  const hasDfsBinding = ctx.projects.some((p) => !!p.gmbCid);
  const hasNativeBinding = ctx.projects.some((p) => !!p.gmbLocationId);
  const metricsLimited = hasDfsBinding && !hasNativeMetrics;
  const dataSource = hasNativeMetrics ? 'google' : hasDfsBinding || reviews.length > 0 ? 'dataforseo' : 'none';

  const meta = {
    metricsLimited,
    dataSource,
    hasNativeBinding,
    hasDfsBinding,
    profileName: ctx.projects.map((p) => p.gmbLocationName).find(Boolean) || null,
  };

  const viewData =
    view === 'reviews'
      ? {
          reviews: data.reviews,
          byStar: data.byStar,
          kpis: { reviews: data.kpis.reviews, rating: data.kpis.rating },
          ...meta,
        }
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
              totalYoy:
                r.websiteClicksYoy != null || r.directionsYoy != null || r.callsYoy != null
                  ? (r.websiteClicksYoy || 0) + (r.directionsYoy || 0) + (r.callsYoy || 0)
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
              websiteClicksYoyDelta: data.kpis.websiteClicksYoyDelta,
              directionsYoyDelta: data.kpis.directionsYoyDelta,
              callsYoyDelta: data.kpis.callsYoyDelta,
              totalYoyDelta: hasYoy
                ? pctDelta(
                    data.kpis.websiteClicks + data.kpis.directions + data.kpis.calls,
                    yoySum('websiteClicks') + yoySum('directions') + yoySum('calls')
                  )
                : null,
            },
            ...meta,
          }
        : { series: data.series, kpis: data.kpis, reviews: data.reviews, byStar: data.byStar, ...meta };

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

  // Prefer latest completed OpenRouter + DFS snapshot (persists until next regenerate).
  const latestRun = await prisma.aiVisibilityRun.findFirst({
    where: { clientId: ctx.clientId, projectId: { in: ctx.projectIds }, status: 'completed' },
    orderBy: { finishedAt: 'desc' },
    include: {
      results: true,
      dfs: true,
      project: { select: { id: true, name: true, dataforseoDomain: true, gscSiteUrl: true } },
    },
  });

  const activeRun = await prisma.aiVisibilityRun.findFirst({
    where: {
      clientId: ctx.clientId,
      projectId: { in: ctx.projectIds },
      status: { in: ['pending', 'running'] },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      projectId: true,
      status: true,
      startedAt: true,
      createdAt: true,
      queryCount: true,
      modelCount: true,
      error: true,
    },
  });

  const prevRun = latestRun
    ? await prisma.aiVisibilityRun.findFirst({
        where: {
          clientId: ctx.clientId,
          projectId: { in: ctx.projectIds },
          status: 'completed',
          id: { not: latestRun.id },
          finishedAt: { lt: latestRun.finishedAt || latestRun.createdAt },
        },
        orderBy: { finishedAt: 'desc' },
        include: { results: { select: { cited: true } } },
      })
    : null;

  // GA4 AI referrers (period-scoped traffic, separate from citations)
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

  const results = latestRun?.results || [];
  const promptsTested = results.length;
  const cited = results.filter((r) => r.cited).length;
  const citationRate = promptsTested > 0 ? Math.round((cited / promptsTested) * 100) : 0;

  const prevTested = prevRun?.results?.length || 0;
  const prevCited = prevRun?.results?.filter((r) => r.cited).length || 0;
  const prevCitationRate = prevTested > 0 ? Math.round((prevCited / prevTested) * 100) : 0;
  const hasPrev = prevTested > 0;

  const byPlatform = {};
  for (const p of results) {
    const key = p.platform || 'unknown';
    byPlatform[key] = byPlatform[key] || { platform: key, tested: 0, cited: 0 };
    byPlatform[key].tested++;
    if (p.cited) byPlatform[key].cited++;
  }

  // Query breakdown: group by query across platforms (all answers, not only cited)
  const byQuery = new Map();
  for (const r of results) {
    const acc = byQuery.get(r.query) || {
      query: r.query,
      sourceQuery: r.sourceQuery || null,
      tested: 0,
      cited: 0,
      platforms: {},
      snippets: [],
      competitors: new Set(),
    };
    if (!acc.sourceQuery && r.sourceQuery) acc.sourceQuery = r.sourceQuery;
    acc.tested++;
    if (r.cited) acc.cited++;
    if (r.responseText) {
      const comps = Array.isArray(r.competitorsJson) ? r.competitorsJson : [];
      for (const c of comps) if (c) acc.competitors.add(String(c));
      acc.snippets.push({
        platform: r.platform,
        cited: !!r.cited,
        citationType: r.citationType,
        text: String(r.responseText).slice(0, 1200),
        competitors: comps,
      });
    }
    acc.platforms[r.platform] = { cited: r.cited, citationType: r.citationType };
    byQuery.set(r.query, acc);
  }
  const queries = [...byQuery.values()]
    .map((q) => {
      const snippets = [...q.snippets].sort((a, b) => Number(b.cited) - Number(a.cited));
      return {
        query: q.query,
        sourceQuery:
          q.sourceQuery && q.sourceQuery !== q.query ? q.sourceQuery : q.sourceQuery || null,
        tested: q.tested,
        cited: q.cited,
        platforms: q.platforms,
        snippets,
        competitors: [...q.competitors].slice(0, 20),
        citationRate: q.tested > 0 ? Math.round((q.cited / q.tested) * 100) : 0,
      };
    })
    .sort((a, b) => b.cited - a.cited || b.tested - a.tested);

  const dfsPayload = latestRun?.dfs?.payload || null;
  const dfs = dfsPayload
    ? {
        ok: !!dfsPayload.ok,
        skipped: !!dfsPayload.skipped,
        error: dfsPayload.error || null,
        domain: dfsPayload.domain || latestRun?.dfs?.domain || null,
        totalMentions: dfsPayload.totalMentions || 0,
        aiSearchVolume: dfsPayload.aiSearchVolume || 0,
        byPlatform: dfsPayload.byPlatform || {},
        topDomains: dfsPayload.topDomains || [],
        searchMentions: dfsPayload.searchMentions || null,
        fetchedAt: dfsPayload.fetchedAt || latestRun?.dfs?.createdAt || null,
      }
    : null;

  // Merge Google AIO from DFS into platform table when present
  const platforms = Object.values(byPlatform);
  if (dfs?.byPlatform?.google?.mentions != null) {
    platforms.push({
      platform: 'google_aio',
      tested: null,
      cited: dfs.byPlatform.google.mentions,
      source: 'dataforseo',
    });
  }

  const projects = ctx.projects.map((p) => ({
    id: p.id,
    name: p.name,
    gscLinked: !!p.gscSiteUrl,
    domain: p.dataforseoDomain || null,
    targetMarket: p.targetMarket || null,
  }));

  const runMeta = latestRun
    ? {
        id: latestRun.id,
        projectId: latestRun.projectId,
        projectName: latestRun.project?.name || null,
        status: latestRun.status,
        startedAt: latestRun.startedAt,
        finishedAt: latestRun.finishedAt,
        queryCount: latestRun.queryCount,
        modelCount: latestRun.modelCount,
        gscRangeStart: latestRun.gscRangeStart,
        gscRangeEnd: latestRun.gscRangeEnd,
        error: latestRun.error,
        isDemo: !!latestRun.isDemo,
      }
    : null;

  const data = {
    kpis: {
      promptsTested,
      cited,
      citationRate,
      referrers: llmReferrers.length,
      platformsCovered: platforms.filter((p) => p.tested == null || p.tested > 0).length,
      promptsTestedDelta: hasPrev ? pctDelta(promptsTested, prevTested) : null,
      citedDelta: hasPrev ? pctDelta(cited, prevCited) : null,
      citationRateDelta: hasPrev ? pctDelta(citationRate, prevCitationRate) : null,
    },
    platforms,
    queries,
    dfs,
    llmReferrers,
    run: runMeta,
    activeRun: activeRun || null,
    projects,
    canRegenerate: true,
    emptyHint: !latestRun
      ? ctx.links.gsc
        ? 'No AI Visibility run yet — Generate AI Visibility to probe ChatGPT, Claude, Gemini, and Perplexity on your top Search queries.'
        : 'Link Google Search Console and set a domain, then Generate AI Visibility.'
      : null,
  };

  return {
    // Always linked so the page can show regenerate CTA / honest empty state
    linked: true,
    emptyReason: null,
    cycle: metaCycle(ctx),
    range: metaRange(ctx),
    source: ctx.source,
    data: view === 'referrers' ? { llmReferrers, kpis: data.kpis, run: runMeta } : data,
  };
}

function aggregateLeadRows(rows) {
  const seriesMap = new Map();
  const totals = {
    phoneClicks: 0,
    emailClicks: 0,
    formSubmits: 0,
    thankYouViews: 0,
    leads: 0,
  };
  const ruleMap = new Map();
  const pathMap = new Map();

  for (const r of rows) {
    const key = r.date.toISOString().slice(0, 10);
    const acc = seriesMap.get(key) || {
      date: key,
      phoneClicks: 0,
      emailClicks: 0,
      formSubmits: 0,
      thankYouViews: 0,
      leads: 0,
      intentClicks: 0,
    };
    acc.phoneClicks += r.phoneClicks;
    acc.emailClicks += r.emailClicks;
    acc.formSubmits += r.formSubmits;
    acc.thankYouViews += r.thankYouViews;
    acc.leads += r.leads;
    acc.intentClicks += r.phoneClicks + r.emailClicks;
    seriesMap.set(key, acc);

    totals.phoneClicks += r.phoneClicks;
    totals.emailClicks += r.emailClicks;
    totals.formSubmits += r.formSubmits;
    totals.thankYouViews += r.thankYouViews;
    totals.leads += r.leads;

    const bd = r.breakdowns && typeof r.breakdowns === 'object' ? r.breakdowns : null;
    if (bd?.rules && Array.isArray(bd.rules)) {
      for (const rule of bd.rules) {
        const rk = `${rule.eventType || ''}::${rule.ruleId || rule.ruleLabel || 'default'}`;
        const prev = ruleMap.get(rk) || {
          ruleId: rule.ruleId || null,
          ruleLabel: rule.ruleLabel || 'Untitled',
          eventType: rule.eventType || 'unknown',
          count: 0,
        };
        prev.count += Number(rule.count) || 0;
        if (rule.ruleLabel) prev.ruleLabel = rule.ruleLabel;
        ruleMap.set(rk, prev);
      }
    }
    if (bd?.paths && Array.isArray(bd.paths)) {
      for (const p of bd.paths) {
        if (!p?.path) continue;
        pathMap.set(p.path, (pathMap.get(p.path) || 0) + (Number(p.count) || 0));
      }
    }
  }

  const series = [...seriesMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const rules = [...ruleMap.values()].sort((a, b) => b.count - a.count);
  const paths = [...pathMap.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count);

  return { series, totals, rules, paths };
}

/**
 * First-party Bridge lead / intent analytics (form + thank-you = leads;
 * phone/email clicks are separate intent metrics).
 */
export async function buildLeadsView(clientIds, view, query) {
  const ctx = await resolveAnalyticsContext(clientIds, query);
  if (ctx.error) return ctx.error;

  const { start, end } = ctx.range;
  const prevRange = ctx.prevRange;
  const yoyRange = ctx.yoyRange;

  const hasAny = ctx.projectIds.length
    ? await prisma.siteLeadDailyMetric.count({
        where: { projectId: { in: ctx.projectIds } },
      })
    : 0;

  // Also treat linked WP as "linked" so empty states can guide setup.
  const wpLinked = (await prisma.project.count({
    where: { id: { in: ctx.projectIds }, wpApiKey: { not: null } },
  })) > 0;

  if (!wpLinked && hasAny === 0) {
    return empty(
      false,
      'Connect WordPress via Agency OS Bridge and enable Lead Tracking in plugin settings',
      ctx.cycle,
      ctx.source
    );
  }

  const [rows, prevRows, yoyRows] = await Promise.all([
    prisma.siteLeadDailyMetric.findMany({
      where: { projectId: { in: ctx.projectIds }, date: { gte: start, lte: end } },
      orderBy: { date: 'asc' },
    }),
    prevRange
      ? prisma.siteLeadDailyMetric.findMany({
          where: {
            projectId: { in: ctx.projectIds },
            date: { gte: prevRange.start, lte: prevRange.end },
          },
          orderBy: { date: 'asc' },
        })
      : Promise.resolve([]),
    yoyRange
      ? prisma.siteLeadDailyMetric.findMany({
          where: {
            projectId: { in: ctx.projectIds },
            date: { gte: yoyRange.start, lte: yoyRange.end },
          },
          orderBy: { date: 'asc' },
        })
      : Promise.resolve([]),
  ]);

  const curr = aggregateLeadRows(rows);
  const prev = aggregateLeadRows(prevRows);
  const yoy = aggregateLeadRows(yoyRows);
  const hasPrev = prevRows.length > 0;
  const hasYoy = yoyRows.length > 0;
  const leadSeriesKeys = [
    'leads',
    'formSubmits',
    'thankYouViews',
    'phoneClicks',
    'emailClicks',
    'intentClicks',
  ];
  const currSeries = densifyDailySeries(start, end, curr.series, leadSeriesKeys);
  const prevSeriesDense = prevRange
    ? densifyDailySeries(prevRange.start, prevRange.end, prev.series, leadSeriesKeys)
    : [];
  const yoySeriesDense = yoyRange
    ? densifyDailySeries(yoyRange.start, yoyRange.end, yoy.series, leadSeriesKeys)
    : [];
  const series = attachYoySeries(
    attachPrevSeries(currSeries, prevSeriesDense, leadSeriesKeys),
    yoySeriesDense,
    leadSeriesKeys
  );

  const byType = [
    { type: 'form_submit', label: 'Form submits', count: curr.totals.formSubmits },
    { type: 'thank_you_page', label: 'Thank-you pages', count: curr.totals.thankYouViews },
    { type: 'phone_click', label: 'Phone clicks', count: curr.totals.phoneClicks },
    { type: 'email_click', label: 'Email clicks', count: curr.totals.emailClicks },
  ];

  const leadMix = [
    { name: 'Form submits', value: curr.totals.formSubmits },
    { name: 'Thank-you pages', value: curr.totals.thankYouViews },
  ].filter((x) => x.value > 0);

  const data = {
    kpis: {
      leads: curr.totals.leads,
      formSubmits: curr.totals.formSubmits,
      thankYouViews: curr.totals.thankYouViews,
      phoneClicks: curr.totals.phoneClicks,
      emailClicks: curr.totals.emailClicks,
      intentClicks: curr.totals.phoneClicks + curr.totals.emailClicks,
      leadsDelta: hasPrev ? pctDelta(curr.totals.leads, prev.totals.leads) : null,
      formSubmitsDelta: hasPrev ? pctDelta(curr.totals.formSubmits, prev.totals.formSubmits) : null,
      thankYouViewsDelta: hasPrev
        ? pctDelta(curr.totals.thankYouViews, prev.totals.thankYouViews)
        : null,
      phoneClicksDelta: hasPrev ? pctDelta(curr.totals.phoneClicks, prev.totals.phoneClicks) : null,
      emailClicksDelta: hasPrev ? pctDelta(curr.totals.emailClicks, prev.totals.emailClicks) : null,
      leadsYoyDelta: hasYoy ? pctDelta(curr.totals.leads, yoy.totals.leads) : null,
      formSubmitsYoyDelta: hasYoy ? pctDelta(curr.totals.formSubmits, yoy.totals.formSubmits) : null,
      thankYouViewsYoyDelta: hasYoy
        ? pctDelta(curr.totals.thankYouViews, yoy.totals.thankYouViews)
        : null,
      phoneClicksYoyDelta: hasYoy ? pctDelta(curr.totals.phoneClicks, yoy.totals.phoneClicks) : null,
      emailClicksYoyDelta: hasYoy ? pctDelta(curr.totals.emailClicks, yoy.totals.emailClicks) : null,
    },
    series,
    leadMix,
    byType,
    rules: curr.rules,
    paths: curr.paths,
    emptyHint:
      rows.length === 0
        ? 'No lead events in this period. Enable Lead Tracking in the WordPress plugin and configure forms, thank-you pages, or phone/email buttons.'
        : null,
  };

  const viewData =
    view === 'breakdown'
      ? {
          kpis: data.kpis,
          series,
          byType,
          rules: curr.rules,
          paths: curr.paths,
          emptyHint: data.emptyHint,
        }
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

