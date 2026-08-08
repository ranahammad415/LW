/**
 * Freezes a per-session analytics snapshot for a work cycle.
 *
 * On month close, we persist each active client's analytics figures as they
 * were for that cycle, so browsing a past month shows historical numbers
 * (live charts only for the current session). Written into
 * WorkCycleAnalyticsSnapshot as JSON, one row per client per cycle.
 */
import { prisma } from '../prisma.js';
import { getClientTrafficSeries } from './gscSeries.js';

/** First/last day (UTC) of a cycle's calendar month. */
function cycleRange(cycle) {
  const start = new Date(Date.UTC(cycle.year, cycle.month - 1, 1));
  const end = new Date(Date.UTC(cycle.year, cycle.month, 0)); // day 0 of next month = last day
  return { start, end };
}

/** First/last day (UTC) of the calendar month before a cycle. */
function previousCycleRange(cycle) {
  const start = new Date(Date.UTC(cycle.year, cycle.month - 2, 1));
  const end = new Date(Date.UTC(cycle.year, cycle.month - 1, 0));
  return { start, end };
}

/** Percentage change; null when there is no comparable prior value. */
function pctDelta(curr, prev) {
  if (prev == null) return null;
  if (prev === 0) return curr === 0 ? 0 : 100;
  return Number((((curr - prev) / prev) * 100).toFixed(1));
}

/** Aggregate GSC query rows into a query -> impression-weighted position map. */
function queryPositions(rows) {
  const byQuery = new Map();
  for (const r of rows) {
    const acc = byQuery.get(r.query) || { impressions: 0, clicks: 0, posWeight: 0 };
    acc.impressions += r.impressions;
    acc.clicks += r.clicks;
    acc.posWeight += r.position * (r.impressions || 1);
    byQuery.set(r.query, acc);
  }
  const out = new Map();
  for (const [q, v] of byQuery) {
    out.set(q, {
      position: v.impressions > 0 ? Number((v.posWeight / v.impressions).toFixed(1)) : 0,
      impressions: v.impressions,
      clicks: v.clicks,
    });
  }
  return out;
}

/**
 * Gather the analytics figures worth freezing (or serving live) for one
 * client/cycle. Exported so the live analytics endpoint can reuse the exact
 * same shape as a frozen snapshot.
 */
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

export async function buildClientAnalytics(clientId, cycle, opts = {}) {
  const { start, end } = opts.range || cycleRange(cycle);
  // `prevRange` may be explicitly null (compare disabled); only fall back to the
  // prior calendar month when the caller did not specify a comparison window.
  const prev = 'prevRange' in opts ? opts.prevRange : previousCycleRange(cycle);
  // `yoyRange` may be explicitly null (YoY compare disabled); default to prior year.
  const yoy = 'yoyRange' in opts ? opts.yoyRange : previousYearWindow(start, end);

  // GSC daily traffic for the period (aggregated across projects).
  const traffic = await getClientTrafficSeries(clientId, { start, end });
  const [prevTraffic, yoyTraffic] = await Promise.all([
    prev ? getClientTrafficSeries(clientId, { start: prev.start, end: prev.end }) : Promise.resolve(null),
    yoy ? getClientTrafficSeries(clientId, { start: yoy.start, end: yoy.end }) : Promise.resolve(null),
  ]);
  // Prefer real prior activity (not densify-filled zeros) when computing deltas.
  const hasPrevTraffic = !!prevTraffic?.hasActivity;
  const hasYoyTraffic = !!yoyTraffic?.hasActivity;
  const trafficDeltas = hasPrevTraffic
    ? {
        clicks: pctDelta(traffic.totals.clicks, prevTraffic.totals.clicks),
        impressions: pctDelta(traffic.totals.impressions, prevTraffic.totals.impressions),
        ctr: pctDelta(traffic.totals.ctr, prevTraffic.totals.ctr),
        position: pctDelta(traffic.totals.position, prevTraffic.totals.position),
      }
    : null;
  const trafficYoyDeltas = hasYoyTraffic
    ? {
        clicks: pctDelta(traffic.totals.clicks, yoyTraffic.totals.clicks),
        impressions: pctDelta(traffic.totals.impressions, yoyTraffic.totals.impressions),
        ctr: pctDelta(traffic.totals.ctr, yoyTraffic.totals.ctr),
        position: pctDelta(traffic.totals.position, yoyTraffic.totals.position),
      }
    : null;

  // Latest KPI metric snapshots for the client.
  const metricSnapshots = await prisma.clientMetricSnapshot.findMany({
    where: { clientId, createdAt: { lte: end } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  const latestByType = new Map();
  for (const m of metricSnapshots) {
    if (!latestByType.has(m.metricType)) {
      latestByType.set(m.metricType, {
        value: m.value,
        label: m.label,
        change: m.change,
        capturedAt: m.createdAt,
      });
    }
  }

  // Tracked-keyword ranking distribution for the client's projects.
  const projects = await prisma.project.findMany({
    where: { clientId },
    select: { id: true },
  });
  const projectIds = projects.map((p) => p.id);
  const keywords = projectIds.length
    ? await prisma.keywordTrack.findMany({
        where: { projectId: { in: projectIds }, status: 'ACCEPTED' },
        select: { keyword: true, currentRank: true, volume: true },
      })
    : [];

  const ranked = keywords.filter((k) => typeof k.currentRank === 'number');
  const rankingSummary = {
    tracked: keywords.length,
    ranked: ranked.length,
    top3: ranked.filter((k) => k.currentRank <= 3).length,
    top10: ranked.filter((k) => k.currentRank <= 10).length,
    top100: ranked.filter((k) => k.currentRank <= 100).length,
    avgRank: ranked.length
      ? Number((ranked.reduce((s, k) => s + k.currentRank, 0) / ranked.length).toFixed(1))
      : null,
  };

  // AI Visibility from latest completed OpenRouter snapshot (not PromptLog sim).
  const latestAiRun = projectIds.length
    ? await prisma.aiVisibilityRun.findFirst({
        where: { clientId, projectId: { in: projectIds }, status: 'completed' },
        orderBy: { finishedAt: 'desc' },
        include: { results: { select: { platform: true, cited: true } } },
      })
    : null;
  const promptsTested = latestAiRun?.results?.length || 0;
  const cited = latestAiRun?.results?.filter((r) => r.cited).length || 0;
  const citationRate = promptsTested > 0 ? Math.round((cited / promptsTested) * 100) : 0;
  const aiVisibility = {
    promptsTested,
    cited,
    citationRate,
    citationRateDelta: null,
    platforms: [...new Set((latestAiRun?.results || []).map((p) => p.platform).filter(Boolean))],
    runFinishedAt: latestAiRun?.finishedAt || null,
  };

  // GA4 + GMB rollups for the cycle month (with previous / YoY windows for deltas)
  const [ga4Rows, prevGa4Rows, yoyGa4Rows, gmbRows, prevGmbRows, yoyGmbRows] = await Promise.all([
    projectIds.length
      ? prisma.ga4DailyMetric.findMany({ where: { projectId: { in: projectIds }, date: { gte: start, lte: end } } })
      : [],
    prev && projectIds.length
      ? prisma.ga4DailyMetric.findMany({
          where: { projectId: { in: projectIds }, date: { gte: prev.start, lte: prev.end } },
        })
      : [],
    yoy && projectIds.length
      ? prisma.ga4DailyMetric.findMany({
          where: { projectId: { in: projectIds }, date: { gte: yoy.start, lte: yoy.end } },
        })
      : [],
    projectIds.length
      ? prisma.gmbDailyMetric.findMany({ where: { projectId: { in: projectIds }, date: { gte: start, lte: end } } })
      : [],
    prev && projectIds.length
      ? prisma.gmbDailyMetric.findMany({
          where: { projectId: { in: projectIds }, date: { gte: prev.start, lte: prev.end } },
        })
      : [],
    yoy && projectIds.length
      ? prisma.gmbDailyMetric.findMany({
          where: { projectId: { in: projectIds }, date: { gte: yoy.start, lte: yoy.end } },
        })
      : [],
  ]);
  const sumRows = (rows, f) => rows.reduce((s, r) => s + (r[f] || 0), 0);
  const hasPrevGa4 = prevGa4Rows.length > 0;
  const hasYoyGa4 = yoyGa4Rows.length > 0;
  const ga4 = {
    sessions: sumRows(ga4Rows, 'sessions'),
    users: sumRows(ga4Rows, 'totalUsers'),
    conversions: sumRows(ga4Rows, 'conversions'),
    pageViews: sumRows(ga4Rows, 'pageViews'),
    series: aggregateByDate(ga4Rows, ['sessions', 'totalUsers', 'conversions', 'pageViews']),
    deltas: hasPrevGa4
      ? {
          sessions: pctDelta(sumRows(ga4Rows, 'sessions'), sumRows(prevGa4Rows, 'sessions')),
          users: pctDelta(sumRows(ga4Rows, 'totalUsers'), sumRows(prevGa4Rows, 'totalUsers')),
          conversions: pctDelta(sumRows(ga4Rows, 'conversions'), sumRows(prevGa4Rows, 'conversions')),
          pageViews: pctDelta(sumRows(ga4Rows, 'pageViews'), sumRows(prevGa4Rows, 'pageViews')),
        }
      : null,
    yoyDeltas: hasYoyGa4
      ? {
          sessions: pctDelta(sumRows(ga4Rows, 'sessions'), sumRows(yoyGa4Rows, 'sessions')),
          users: pctDelta(sumRows(ga4Rows, 'totalUsers'), sumRows(yoyGa4Rows, 'totalUsers')),
          conversions: pctDelta(sumRows(ga4Rows, 'conversions'), sumRows(yoyGa4Rows, 'conversions')),
          pageViews: pctDelta(sumRows(ga4Rows, 'pageViews'), sumRows(yoyGa4Rows, 'pageViews')),
        }
      : null,
  };

  const hasPrevGmb = prevGmbRows.length > 0;
  const hasYoyGmb = yoyGmbRows.length > 0;
  const gmbActions = sumRows(gmbRows, 'websiteClicks') + sumRows(gmbRows, 'directions') + sumRows(gmbRows, 'calls');
  const prevGmbActions =
    sumRows(prevGmbRows, 'websiteClicks') + sumRows(prevGmbRows, 'directions') + sumRows(prevGmbRows, 'calls');
  const yoyGmbActions =
    sumRows(yoyGmbRows, 'websiteClicks') + sumRows(yoyGmbRows, 'directions') + sumRows(yoyGmbRows, 'calls');
  const gmb = {
    impressions: sumRows(gmbRows, 'impressions'),
    directions: sumRows(gmbRows, 'directions'),
    websiteClicks: sumRows(gmbRows, 'websiteClicks'),
    calls: sumRows(gmbRows, 'calls'),
    actions: gmbActions,
    series: aggregateByDate(gmbRows, [
      'impressions',
      'impressionsSearch',
      'impressionsMaps',
      'websiteClicks',
      'directions',
      'calls',
    ]),
    deltas: hasPrevGmb
      ? {
          impressions: pctDelta(sumRows(gmbRows, 'impressions'), sumRows(prevGmbRows, 'impressions')),
          actions: pctDelta(gmbActions, prevGmbActions),
        }
      : null,
    yoyDeltas: hasYoyGmb
      ? {
          impressions: pctDelta(sumRows(gmbRows, 'impressions'), sumRows(yoyGmbRows, 'impressions')),
          actions: pctDelta(gmbActions, yoyGmbActions),
        }
      : null,
  };

  // Rank movers: compare impression-weighted query positions vs previous month.
  const [qCurr, qPrev] = projectIds.length
    ? await Promise.all([
        prisma.gscQueryMetric.findMany({
          where: { projectId: { in: projectIds }, date: { gte: start, lte: end } },
          orderBy: { impressions: 'desc' },
          take: 1000,
        }),
        prev
          ? prisma.gscQueryMetric.findMany({
              where: { projectId: { in: projectIds }, date: { gte: prev.start, lte: prev.end } },
              orderBy: { impressions: 'desc' },
              take: 1000,
            })
          : Promise.resolve([]),
      ])
    : [[], []];
  const posCurr = queryPositions(qCurr);
  const posPrev = queryPositions(qPrev);
  const moverRows = [];
  for (const [query, cur] of posCurr) {
    const before = posPrev.get(query);
    if (!before || !before.position || !cur.position) continue;
    moverRows.push({
      query,
      from: before.position,
      to: cur.position,
      change: Number((before.position - cur.position).toFixed(1)), // >0 means improved (moved up)
      impressions: cur.impressions,
    });
  }
  const improved = moverRows
    .filter((m) => m.change > 0)
    .sort((a, b) => b.change - a.change)
    .slice(0, 5);
  const declined = moverRows
    .filter((m) => m.change < 0)
    .sort((a, b) => a.change - b.change)
    .slice(0, 5);
  const movers = { improved, declined };

  const funnel = {
    impressions: traffic.totals.impressions,
    clicks: traffic.totals.clicks,
    sessions: ga4.sessions,
    conversions: ga4.conversions,
  };

  const links = await prisma.project.findMany({
    where: { clientId },
    select: {
      id: true,
      gscSiteUrl: true,
      ga4PropertyId: true,
      gmbLocationId: true,
      dataforseoDomain: true,
    },
  });

  const trafficKeys = ['clicks', 'impressions', 'ctr', 'position'];
  const trafficSeries = attachYoySeries(
    attachPrevSeries(traffic.series || [], prevTraffic?.series || [], trafficKeys),
    yoyTraffic?.series || [],
    trafficKeys
  );

  return {
    frozenAt: new Date().toISOString(),
    cycle: { month: cycle.month, year: cycle.year },
    range: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
    traffic: {
      series: trafficSeries,
      totals: traffic.totals,
      deltas: trafficDeltas,
      yoyDeltas: trafficYoyDeltas,
      gsc: {
        healed: !!traffic.healed,
        healError: traffic.healError || null,
        gscSites: traffic.gscSites || [],
      },
    },
    funnel,
    movers,
    metrics: Object.fromEntries(latestByType),
    rankings: rankingSummary,
    aiVisibility,
    ga4,
    gmb,
    links: {
      gsc: links.some((l) => !!l.gscSiteUrl),
      ga4: links.some((l) => !!l.ga4PropertyId),
      gmb: links.some((l) => !!l.gmbLocationId),
      seo: links.some((l) => !!l.dataforseoDomain),
    },
  };
}

function aggregateByDate(rows, fields) {
  const map = new Map();
  for (const r of rows) {
    const key = r.date.toISOString().slice(0, 10);
    const acc = map.get(key) || { date: key };
    for (const f of fields) {
      acc[f] = (acc[f] || 0) + (r[f] || 0);
    }
    map.set(key, acc);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
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

/** Year-over-year overlay (`*Yoy` keys). */
function attachYoySeries(series, yoySeries, keys) {
  return attachAlignedSeries(series, yoySeries, keys, 'Yoy');
}

/** Previous-period overlay (`*Prev` keys). */
function attachPrevSeries(series, prevSeries, keys) {
  return attachAlignedSeries(series, prevSeries, keys, 'Prev');
}

/**
 * Freeze analytics snapshots for every active client of a (just-closed) cycle.
 * Idempotent: re-running upserts the snapshot for each client.
 *
 * @param {object} cycle - the WorkCycle being closed
 * @param {{ log?: object }} [opts]
 * @returns {Promise<{ created: number, skipped: number }>}
 */
export async function freezeAnalyticsForCycle(cycle, opts = {}) {
  const log = opts.log;
  const clients = await prisma.clientAccount.findMany({
    where: { isActive: true },
    select: { id: true, agencyName: true },
  });

  let created = 0;
  let skipped = 0;

  for (const client of clients) {
    try {
      const data = await buildClientAnalytics(client.id, cycle);
      await prisma.workCycleAnalyticsSnapshot.upsert({
        where: { workCycleId_clientId: { workCycleId: cycle.id, clientId: client.id } },
        create: { workCycleId: cycle.id, clientId: client.id, data },
        update: { data },
      });
      created++;
    } catch (err) {
      skipped++;
      if (log?.warn) {
        log.warn(`[freezeSnapshot] client ${client.id} failed: ${err.message}`);
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[freezeSnapshot] client ${client.id} failed: ${err.message}`);
      }
    }
  }

  return { created, skipped };
}
