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

/**
 * Gather the analytics figures worth freezing (or serving live) for one
 * client/cycle. Exported so the live analytics endpoint can reuse the exact
 * same shape as a frozen snapshot.
 */
export async function buildClientAnalytics(clientId, cycle) {
  const { start, end } = cycleRange(cycle);

  // GSC daily traffic for the cycle month (aggregated across projects).
  const traffic = await getClientTrafficSeries(clientId, { start, end });

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

  // AI-search visibility ("AI chat results") for the cycle month.
  const [promptsTested, cited, platformRows] = await Promise.all([
    prisma.promptLog.count({ where: { project: { clientId }, createdAt: { gte: start, lte: end } } }),
    prisma.promptLog.count({ where: { project: { clientId }, createdAt: { gte: start, lte: end }, cited: true } }),
    prisma.promptLog.findMany({
      where: { project: { clientId }, createdAt: { gte: start, lte: end } },
      select: { platform: true },
      take: 500,
    }),
  ]);
  const aiVisibility = {
    promptsTested,
    cited,
    citationRate: promptsTested > 0 ? Math.round((cited / promptsTested) * 100) : 0,
    platforms: [...new Set(platformRows.map((p) => p.platform).filter(Boolean))],
  };

  return {
    frozenAt: new Date().toISOString(),
    cycle: { month: cycle.month, year: cycle.year },
    range: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
    traffic: { series: traffic.series, totals: traffic.totals },
    metrics: Object.fromEntries(latestByType),
    rankings: rankingSummary,
    aiVisibility,
  };
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
    select: { id: true, name: true },
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
