/**
 * Reads persisted GSC daily time-series (GscDailyMetric) and shapes it into
 * chart-ready series keyed to a core Client (aggregated across its projects).
 */
import { prisma } from '../prisma.js';

/** Format a Date as YYYY-MM-DD (UTC). */
function fmt(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Get chart-ready daily traffic series for a client over a date range.
 * Aggregates across all of the client's projects per day.
 *
 * @param {string} clientId
 * @param {{ start?: Date, end?: Date, days?: number }} [range]
 * @returns {Promise<{ series: Array<{date, clicks, impressions, ctr, position}>, totals }>}
 */
export async function getClientTrafficSeries(clientId, range = {}) {
  const end = range.end ?? new Date();
  const start =
    range.start ??
    (() => {
      const d = new Date(end);
      d.setDate(d.getDate() - ((range.days ?? 30) - 1));
      return d;
    })();

  const projects = await prisma.project.findMany({
    where: { clientId },
    select: { id: true },
  });
  const projectIds = projects.map((p) => p.id);
  if (projectIds.length === 0) {
    return { series: [], totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 } };
  }

  const rows = await prisma.gscDailyMetric.findMany({
    where: {
      projectId: { in: projectIds },
      date: { gte: new Date(fmt(start)), lte: new Date(fmt(end)) },
    },
    orderBy: { date: 'asc' },
  });

  // Aggregate multiple projects per calendar day.
  const byDate = new Map();
  for (const r of rows) {
    const key = fmt(r.date);
    const acc = byDate.get(key) || { clicks: 0, impressions: 0, posWeight: 0 };
    acc.clicks += r.clicks;
    acc.impressions += r.impressions;
    // Impression-weighted average position across projects.
    acc.posWeight += r.position * (r.impressions || 1);
    byDate.set(key, acc);
  }

  const series = [];
  let totalClicks = 0;
  let totalImpr = 0;
  let totalPosWeight = 0;
  for (const [date, acc] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ctr = acc.impressions > 0 ? acc.clicks / acc.impressions : 0;
    const position = acc.impressions > 0 ? acc.posWeight / acc.impressions : 0;
    series.push({
      date,
      clicks: acc.clicks,
      impressions: acc.impressions,
      ctr: Number((ctr * 100).toFixed(2)),
      position: Number(position.toFixed(1)),
    });
    totalClicks += acc.clicks;
    totalImpr += acc.impressions;
    totalPosWeight += acc.posWeight;
  }

  const totals = {
    clicks: totalClicks,
    impressions: totalImpr,
    ctr: totalImpr > 0 ? Number(((totalClicks / totalImpr) * 100).toFixed(2)) : 0,
    position: totalImpr > 0 ? Number((totalPosWeight / totalImpr).toFixed(1)) : 0,
  };

  return { series, totals };
}
