/**
 * Reads persisted GSC daily time-series (GscDailyMetric) and shapes it into
 * chart-ready series keyed to a core Client (aggregated across its projects).
 * When local coverage for the requested range is incomplete, live-heals from
 * the GSC API so dashboard totals match Search Console.
 */
import { prisma } from '../prisma.js';
import { MS_DAY, fmt, persistDailyRange, utcDay } from '../gscDailyPersist.js';

/** Coverage below this ratio triggers a live GSC fetch for the range. */
const MIN_COVERAGE_RATIO = 0.9;

/**
 * Fill every calendar day in [start, end] so equal-length compare windows
 * can be index-zipped for chart overlays. Missing days get zeros.
 */
function densifySeries(start, end, byDate) {
  const series = [];
  for (let t = start.getTime(); t <= end.getTime(); t += MS_DAY) {
    const date = fmt(new Date(t));
    const acc = byDate.get(date);
    if (acc) {
      const ctr = acc.impressions > 0 ? acc.clicks / acc.impressions : 0;
      const position = acc.impressions > 0 ? acc.posWeight / acc.impressions : 0;
      series.push({
        date,
        clicks: acc.clicks,
        impressions: acc.impressions,
        ctr: Number((ctr * 100).toFixed(2)),
        position: Number(position.toFixed(1)),
      });
    } else {
      series.push({ date, clicks: 0, impressions: 0, ctr: 0, position: 0 });
    }
  }
  return series;
}

function expectedDays(start, end) {
  return Math.round((end.getTime() - start.getTime()) / MS_DAY) + 1;
}

/**
 * Load + aggregate GscDailyMetric rows for a client over [start, end].
 */
async function loadAggregated(clientId, start, end, projectIds) {
  if (!projectIds.length) {
    return {
      byDate: new Map(),
      totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
      hasActivity: false,
      storedDays: 0,
      newestKey: null,
    };
  }

  const rows = await prisma.gscDailyMetric.findMany({
    where: {
      projectId: { in: projectIds },
      date: { gte: start, lte: end },
    },
    orderBy: { date: 'asc' },
  });

  const byDate = new Map();
  for (const r of rows) {
    const key = fmt(utcDay(r.date));
    const acc = byDate.get(key) || { clicks: 0, impressions: 0, posWeight: 0 };
    acc.clicks += r.clicks;
    acc.impressions += r.impressions;
    acc.posWeight += r.position * (r.impressions || 1);
    byDate.set(key, acc);
  }

  let totalClicks = 0;
  let totalImpr = 0;
  let totalPosWeight = 0;
  let newestKey = null;
  for (const [date, acc] of byDate.entries()) {
    totalClicks += acc.clicks;
    totalImpr += acc.impressions;
    totalPosWeight += acc.posWeight;
    if (!newestKey || date > newestKey) newestKey = date;
  }

  return {
    byDate,
    totals: {
      clicks: totalClicks,
      impressions: totalImpr,
      ctr: totalImpr > 0 ? Number(((totalClicks / totalImpr) * 100).toFixed(2)) : 0,
      position: totalImpr > 0 ? Number((totalPosWeight / totalImpr).toFixed(1)) : 0,
    },
    hasActivity: totalClicks > 0 || totalImpr > 0,
    storedDays: byDate.size,
    newestKey,
  };
}

function coverageIncomplete(start, end, storedDays, newestKey) {
  const expected = expectedDays(start, end);
  if (expected <= 0) return false;
  if (storedDays / expected < MIN_COVERAGE_RATIO) return true;
  if (!newestKey) return true;
  const newest = utcDay(newestKey);
  // Newest stored day more than 1 day before range end → trailing gap.
  return newest.getTime() < end.getTime() - MS_DAY;
}

/**
 * Get chart-ready daily traffic series for a client over a date range.
 * Aggregates across all of the client's projects per day and densifies the
 * window so compare overlays can align by day index. Live-heals from GSC when
 * local coverage for the range is incomplete.
 *
 * @param {string} clientId
 * @param {{ start?: Date, end?: Date, days?: number }} [range]
 * @returns {Promise<{ series: Array, totals: object, hasActivity: boolean }>}
 */
export async function getClientTrafficSeries(clientId, range = {}) {
  const end = utcDay(range.end ?? new Date());
  const start = range.start
    ? utcDay(range.start)
    : new Date(end.getTime() - ((range.days ?? 30) - 1) * MS_DAY);

  const empty = {
    series: densifySeries(start, end, new Map()),
    totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
    hasActivity: false,
  };

  const projects = await prisma.project.findMany({
    where: { clientId },
    select: { id: true, gscSiteUrl: true },
  });
  const projectIds = projects.map((p) => p.id);
  if (projectIds.length === 0) {
    return empty;
  }

  let agg = await loadAggregated(clientId, start, end, projectIds);

  if (coverageIncomplete(start, end, agg.storedDays, agg.newestKey)) {
    const gscProjects = projects.filter((p) => !!p.gscSiteUrl);
    if (gscProjects.length) {
      try {
        let healed = 0;
        for (const project of gscProjects) {
          healed += await persistDailyRange(project, start, end);
        }
        // eslint-disable-next-line no-console
        console.info(
          `[gscSeries] live-healed ${clientId}: ${fmt(start)} → ${fmt(end)} (${healed} day-rows)`
        );
        agg = await loadAggregated(clientId, start, end, projectIds);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[gscSeries] live heal failed for ${clientId}: ${err?.message || err}`
        );
      }
    }
  }

  return {
    series: densifySeries(start, end, agg.byDate),
    totals: agg.totals,
    hasActivity: agg.hasActivity,
  };
}
