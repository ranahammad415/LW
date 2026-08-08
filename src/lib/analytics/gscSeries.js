/**
 * Reads persisted GSC daily time-series (GscDailyMetric) and shapes it into
 * chart-ready series keyed to a core Client (aggregated across its projects).
 */
import { prisma } from '../prisma.js';

const MS_DAY = 86400000;

/** Format a Date as YYYY-MM-DD (UTC). */
function fmt(d) {
  return d.toISOString().slice(0, 10);
}

/** Normalize any Date/string into a UTC midnight Date for @db.Date queries. */
function utcDay(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (typeof value === 'string' && value.length >= 10) {
    return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

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

/**
 * Get chart-ready daily traffic series for a client over a date range.
 * Aggregates across all of the client's projects per day and densifies the
 * window so compare overlays can align by day index.
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
    select: { id: true },
  });
  const projectIds = projects.map((p) => p.id);
  if (projectIds.length === 0) {
    return empty;
  }

  const rows = await prisma.gscDailyMetric.findMany({
    where: {
      projectId: { in: projectIds },
      date: { gte: start, lte: end },
    },
    orderBy: { date: 'asc' },
  });

  // Aggregate multiple projects per calendar day.
  const byDate = new Map();
  for (const r of rows) {
    const key = fmt(utcDay(r.date));
    const acc = byDate.get(key) || { clicks: 0, impressions: 0, posWeight: 0 };
    acc.clicks += r.clicks;
    acc.impressions += r.impressions;
    // Impression-weighted average position across projects.
    acc.posWeight += r.position * (r.impressions || 1);
    byDate.set(key, acc);
  }

  let totalClicks = 0;
  let totalImpr = 0;
  let totalPosWeight = 0;
  for (const acc of byDate.values()) {
    totalClicks += acc.clicks;
    totalImpr += acc.impressions;
    totalPosWeight += acc.posWeight;
  }

  // Real prior-window activity only (densify zeros must not invent deltas).
  const hasActivity = totalClicks > 0 || totalImpr > 0;

  const totals = {
    clicks: totalClicks,
    impressions: totalImpr,
    ctr: totalImpr > 0 ? Number(((totalClicks / totalImpr) * 100).toFixed(2)) : 0,
    position: totalImpr > 0 ? Number((totalPosWeight / totalImpr).toFixed(1)) : 0,
  };

  return {
    series: densifySeries(start, end, byDate),
    totals,
    hasActivity,
  };
}
