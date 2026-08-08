/**
 * Reads persisted GSC daily time-series (GscDailyMetric) and shapes it into
 * chart-ready series keyed to a core Client (aggregated across its projects).
 * When local coverage for the requested range is incomplete (including trailing
 * zero cliffs), live-heals from the GSC API so dashboard totals match Search Console.
 */
import { prisma } from '../prisma.js';
import { MS_DAY, fmt, persistDailyRange, utcDay } from '../gscDailyPersist.js';

/** Active-day coverage below this ratio triggers a live GSC fetch. */
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

function isActive(acc) {
  return !!acc && ((acc.clicks || 0) > 0 || (acc.impressions || 0) > 0);
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
      activeDays: 0,
      newestActiveKey: null,
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
  let activeDays = 0;
  let newestActiveKey = null;
  for (const [date, acc] of byDate.entries()) {
    totalClicks += acc.clicks;
    totalImpr += acc.impressions;
    totalPosWeight += acc.posWeight;
    if (isActive(acc)) {
      activeDays += 1;
      if (!newestActiveKey || date > newestActiveKey) newestActiveKey = date;
    }
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
    activeDays,
    newestActiveKey,
  };
}

/**
 * True when local data should be refreshed from the GSC API.
 * Uses active days (clicks/impressions > 0), not mere row presence, and
 * detects trailing zero cliffs (e.g. data dies after mid-range).
 */
function coverageIncomplete(start, end, agg) {
  const expected = expectedDays(start, end);
  if (expected <= 0) return false;

  const { activeDays, newestActiveKey, byDate, hasActivity } = agg;

  if (!hasActivity) return true;
  if (activeDays / expected < MIN_COVERAGE_RATIO) return true;

  if (!newestActiveKey) return true;
  const newestActive = utcDay(newestActiveKey);
  if (newestActive.getTime() < end.getTime() - MS_DAY) return true;

  // Activity cliff: first half has activity, trailing window is all zero/missing.
  const trailDays = Math.max(7, Math.ceil(expected * 0.25));
  const trailStart = new Date(end.getTime() - (trailDays - 1) * MS_DAY);
  const mid = new Date(start.getTime() + Math.floor((expected - 1) / 2) * MS_DAY);

  let firstHalfActive = false;
  for (let t = start.getTime(); t <= mid.getTime(); t += MS_DAY) {
    if (isActive(byDate.get(fmt(new Date(t))))) {
      firstHalfActive = true;
      break;
    }
  }
  if (!firstHalfActive) return false;

  let trailActive = false;
  for (let t = trailStart.getTime(); t <= end.getTime(); t += MS_DAY) {
    if (isActive(byDate.get(fmt(new Date(t))))) {
      trailActive = true;
      break;
    }
  }
  return !trailActive;
}

/**
 * Get chart-ready daily traffic series for a client over a date range.
 * Live-heals from GSC when active-day coverage is incomplete or cliffed.
 *
 * @param {string} clientId
 * @param {{ start?: Date, end?: Date, days?: number }} [range]
 * @returns {Promise<{
 *   series: Array,
 *   totals: object,
 *   hasActivity: boolean,
 *   healed: boolean,
 *   healError?: string|null,
 *   gscSites?: string[],
 * }>}
 */
export async function getClientTrafficSeries(clientId, range = {}) {
  const end = utcDay(range.end ?? new Date());
  const start = range.start
    ? utcDay(range.start)
    : new Date(end.getTime() - ((range.days ?? 30) - 1) * MS_DAY);

  const emptyMeta = { healed: false, healError: null, gscSites: [] };
  const empty = {
    series: densifySeries(start, end, new Map()),
    totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
    hasActivity: false,
    ...emptyMeta,
  };

  const projects = await prisma.project.findMany({
    where: { clientId },
    select: { id: true, gscSiteUrl: true },
  });
  if (projects.length === 0) {
    return empty;
  }

  // Prefer GSC-linked projects so orphan/stale daily rows from unlinked projects
  // cannot create false cliffs or dilute live-healed totals.
  const gscProjects = projects.filter((p) => !!p.gscSiteUrl);
  const metricProjectIds = (gscProjects.length ? gscProjects : projects).map((p) => p.id);
  const gscSites = gscProjects.map((p) => p.gscSiteUrl).filter(Boolean);

  let agg = await loadAggregated(clientId, start, end, metricProjectIds);
  let healed = false;
  let healError = null;
  let usedSites = [...gscSites];

  if (coverageIncomplete(start, end, agg)) {
    if (!gscProjects.length) {
      healError = 'No Search Console property linked on this client';
    } else {
      try {
        let dayRows = 0;
        let apiClicks = 0;
        for (const project of gscProjects) {
          const result = await persistDailyRange(project, start, end);
          dayRows += result.dayRows || 0;
          apiClicks += result.clicks || 0;
          if (result.siteUrl && !usedSites.includes(result.siteUrl)) {
            usedSites.push(result.siteUrl);
          }
        }
        healed = true;
        // eslint-disable-next-line no-console
        console.info(
          `[gscSeries] live-healed ${clientId}: ${fmt(start)} → ${fmt(end)} ` +
            `(${dayRows} day-rows, apiClicks=${Math.round(apiClicks)}, sites=${usedSites.join(', ')})`
        );
        agg = await loadAggregated(clientId, start, end, metricProjectIds);

        if (coverageIncomplete(start, end, agg)) {
          healError =
            dayRows === 0
              ? `Search Console returned no daily rows for ${usedSites.join(', ') || 'linked property'}. ` +
                'Check Admin → Integrations property URL and Google access.'
              : `Search Console refresh still incomplete for ${usedSites.join(', ') || 'linked property'} ` +
                `(apiClicks=${Math.round(apiClicks)}, newestActive=${agg.newestActiveKey || 'none'}). ` +
                'Confirm the property matches the site in Search Console.';
          // eslint-disable-next-line no-console
          console.warn(`[gscSeries] ${healError}`);
        }
      } catch (err) {
        healError = err?.message || String(err);
        // eslint-disable-next-line no-console
        console.warn(`[gscSeries] live heal failed for ${clientId}: ${healError}`);
      }
    }
  }

  return {
    series: densifySeries(start, end, agg.byDate),
    totals: agg.totals,
    hasActivity: agg.hasActivity,
    healed,
    healError,
    gscSites: usedSites,
  };
}
