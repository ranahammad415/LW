/**
 * Daily GSC sync orchestrator.
 * Queries all projects with gscSiteUrl, fetches GSC data, and writes
 * ClientMetricSnapshot records for the associated client.
 */
import { prisma } from './prisma.js';
import { isGscEnabled, isGscAvailable, fetchSearchAnalytics, fetchDailySearchAnalytics } from './gscClient.js';
import { calculateMetrics } from './gscMetrics.js';

const MS_DAY = 86400000;

/** GSC Search Analytics typically retains ~16 months — needed for YoY compare. */
const YOY_LOOKBACK_DAYS = 487;
/** Always re-fetch this recent window on every sync (GSC data revises for a few days). */
const FRESH_DAYS = 30;
/** Chunk size when pulling long history (keeps each API call small/reliable). */
const FETCH_CHUNK_DAYS = 90;

/**
 * Format a Date as YYYY-MM-DD (UTC).
 */
function fmt(d) {
  return d.toISOString().slice(0, 10);
}

/** UTC calendar day (midnight). */
function utcDay(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addUtcDays(d, days) {
  return new Date(d.getTime() + days * MS_DAY);
}

/**
 * Upsert daily GSC rows for one project.
 * @returns {Promise<number>} number of days written
 */
async function upsertDailyRows(projectId, rows) {
  let upserts = 0;
  for (const row of rows || []) {
    const dateStr = row.keys?.[0];
    if (!dateStr) continue;
    const date = new Date(`${String(dateStr).slice(0, 10)}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) continue;
    await prisma.gscDailyMetric.upsert({
      where: { projectId_date: { projectId, date } },
      create: {
        projectId,
        date,
        clicks: Math.round(row.clicks || 0),
        impressions: Math.round(row.impressions || 0),
        ctr: row.ctr || 0,
        position: row.position || 0,
      },
      update: {
        clicks: Math.round(row.clicks || 0),
        impressions: Math.round(row.impressions || 0),
        ctr: row.ctr || 0,
        position: row.position || 0,
      },
    });
    upserts++;
  }
  return upserts;
}

/**
 * Fetch daily GSC metrics in chunks for [start, end] (inclusive UTC days).
 */
async function fetchDailyInChunks(siteUrl, start, end) {
  const all = [];
  for (let chunkStart = start; chunkStart.getTime() <= end.getTime(); ) {
    const chunkEnd = addUtcDays(chunkStart, FETCH_CHUNK_DAYS - 1);
    const cappedEnd = chunkEnd.getTime() > end.getTime() ? end : chunkEnd;
    const rows = await fetchDailySearchAnalytics(siteUrl, fmt(chunkStart), fmt(cappedEnd));
    if (rows?.length) all.push(...rows);
    chunkStart = addUtcDays(cappedEnd, 1);
  }
  return all;
}

/**
 * Sync daily GSC time-series for a project.
 *
 * - Always refreshes the last {@link FRESH_DAYS} (recent data can revise).
 * - If history is missing (YoY) or the newest row is stale/gapped, widens the
 *   pull window so Search Console totals can catch up.
 * - forceFull re-pulls the entire ~16 month lookback.
 *
 * @param {object} project
 * @param {{ forceFull?: boolean }} [opts]
 */
async function syncDailySeries(project, opts = {}) {
  const end = addUtcDays(utcDay(), -2); // GSC ~2-day delay
  const fullStart = addUtcDays(end, -(YOY_LOOKBACK_DAYS - 1));
  const freshStart = addUtcDays(end, -(FRESH_DAYS - 1));

  const [oldest, newest] = await Promise.all([
    prisma.gscDailyMetric.findFirst({
      where: { projectId: project.id },
      orderBy: { date: 'asc' },
      select: { date: true },
    }),
    prisma.gscDailyMetric.findFirst({
      where: { projectId: project.id },
      orderBy: { date: 'desc' },
      select: { date: true },
    }),
  ]);

  const oldestDay = oldest?.date ? utcDay(oldest.date) : null;
  const newestDay = newest?.date ? utcDay(newest.date) : null;
  const missingHistory = !oldestDay || oldestDay.getTime() > fullStart.getTime();
  // More than 1 day behind expected GSC end → treat as a recent sync gap.
  const staleNewest =
    !newestDay || newestDay.getTime() < addUtcDays(end, -1).getTime();

  let rangeStart = freshStart;
  let reason = 'fresh';

  if (opts.forceFull || missingHistory) {
    rangeStart = fullStart;
    reason = opts.forceFull ? 'forceFull' : 'missingHistory';
  } else if (staleNewest) {
    const daysBehind = Math.max(
      0,
      Math.round((end.getTime() - newestDay.getTime()) / MS_DAY)
    );
    // Cover the gap plus a fresh buffer so revised recent days are re-pulled.
    const gapStart = addUtcDays(end, -(Math.max(FRESH_DAYS, daysBehind + FRESH_DAYS) - 1));
    rangeStart = gapStart.getTime() < fullStart.getTime() ? fullStart : gapStart;
    reason = `staleNewest(newest=${fmt(newestDay)}, behind=${daysBehind}d)`;
  }

  const rows = await fetchDailyInChunks(project.gscSiteUrl, rangeStart, end);
  const upserts = await upsertDailyRows(project.id, rows);

  // eslint-disable-next-line no-console
  console.info(
    `[gscSync] daily series ${project.id}: ${fmt(rangeStart)} → ${fmt(end)} ` +
      `(${upserts} days, reason=${reason}, newest=${newestDay ? fmt(newestDay) : 'none'})`
  );
  return upserts;
}

/**
 * Store top queries for the sync period under the period end date.
 */
async function syncQuerySnapshot(project, rows, endDate) {
  const date = new Date(`${fmt(endDate)}T00:00:00.000Z`);
  let upserts = 0;
  for (const row of (rows || []).slice(0, 500)) {
    const query = String(row.keys?.[0] || '').slice(0, 500);
    if (!query) continue;
    await prisma.gscQueryMetric.upsert({
      where: { projectId_date_query: { projectId: project.id, date, query } },
      create: {
        projectId: project.id,
        date,
        query,
        clicks: Math.round(row.clicks || 0),
        impressions: Math.round(row.impressions || 0),
        ctr: row.ctr || 0,
        position: row.position || 0,
      },
      update: {
        clicks: Math.round(row.clicks || 0),
        impressions: Math.round(row.impressions || 0),
        ctr: row.ctr || 0,
        position: row.position || 0,
      },
    });
    upserts++;
  }
  return upserts;
}

/**
 * Sync a single project's GSC data and persist metric snapshots.
 * @param {object} project - { id, gscSiteUrl, clientId }
 * @param {{ forceFullDaily?: boolean }} [opts]
 * @returns {{ projectId: string, status: string, error?: string }}
 */
export async function syncProject(project, opts = {}) {
  try {
    const now = utcDay();
    // Current period: last 7 days (GSC data has ~2 day delay so -9 to -2)
    const currentEnd = addUtcDays(now, -2);
    const currentStart = addUtcDays(currentEnd, -6);

    // Previous period: the 7 days before that
    const prevEnd = addUtcDays(currentStart, -1);
    const prevStart = addUtcDays(prevEnd, -6);

    const [currentRows, previousRows] = await Promise.all([
      fetchSearchAnalytics(project.gscSiteUrl, fmt(currentStart), fmt(currentEnd)),
      fetchSearchAnalytics(project.gscSiteUrl, fmt(prevStart), fmt(prevEnd)),
    ]);

    const metrics = calculateMetrics(currentRows, previousRows);

    // Find the client associated with this project
    const proj = await prisma.project.findUnique({
      where: { id: project.id },
      select: { clientId: true },
    });

    if (!proj?.clientId) {
      return { projectId: project.id, status: 'skipped', error: 'No client linked' };
    }

    // Write metric snapshots
    await prisma.clientMetricSnapshot.createMany({
      data: metrics.map((m) => ({
        clientId: proj.clientId,
        metricType: m.metricType,
        value: String(m.value).slice(0, 100),
        change: m.change ? String(m.change).slice(0, 100) : null,
      })),
    });

    // Persist daily time-series (best-effort — don't fail the KPI sync on it).
    // forceFullDaily pulls ~16 months so YoY compare has history.
    let dailyPoints = 0;
    try {
      dailyPoints = await syncDailySeries(project, { forceFull: !!opts.forceFullDaily });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[gscSync] Daily series sync failed for ${project.id}: ${err.message}`);
    }

    // Persist recent query rows for brand/generic + rankings pages (snapshot of last 7 days as one day key)
    let queryPoints = 0;
    try {
      queryPoints = await syncQuerySnapshot(project, currentRows, currentEnd);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[gscSync] Query snapshot failed for ${project.id}: ${err.message}`);
    }

    // Update last synced timestamp
    await prisma.project.update({
      where: { id: project.id },
      data: { gscLastSyncedAt: new Date() },
    });

    return { projectId: project.id, status: 'ok', metricsCount: metrics.length, dailyPoints, queryPoints };
  } catch (err) {
    return { projectId: project.id, status: 'error', error: err.message };
  }
}

/**
 * Run GSC sync for all configured projects.
 * Called by the daily cron job (smart backfill) or manual admin sync.
 *
 * @param {{ forceFullDaily?: boolean }} [opts]
 *   When true (manual sync), re-pull the full ~16 month daily window for YoY.
 */
export async function runGscSync(opts = {}) {
  const available = typeof isGscAvailable === 'function'
    ? await isGscAvailable()
    : isGscEnabled();
  if (!available) {
    return { skipped: true, reason: 'GSC not configured' };
  }

  const projects = await prisma.project.findMany({
    where: { gscSiteUrl: { not: null } },
    select: { id: true, gscSiteUrl: true, clientId: true },
  });

  if (projects.length === 0) {
    return { skipped: true, reason: 'No projects with GSC configured' };
  }

  const results = [];
  for (const project of projects) {
    const result = await syncProject(project, { forceFullDaily: !!opts.forceFullDaily });
    results.push(result);
  }

  return {
    total: projects.length,
    success: results.filter((r) => r.status === 'ok').length,
    errors: results.filter((r) => r.status === 'error').length,
    details: results,
  };
}
