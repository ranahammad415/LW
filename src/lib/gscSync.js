/**
 * Daily GSC sync orchestrator.
 * Queries all projects with gscSiteUrl, fetches GSC data, and writes
 * ClientMetricSnapshot records for the associated client.
 */
import { prisma } from './prisma.js';
import { isGscEnabled, isGscAvailable, fetchSearchAnalytics, fetchDailySearchAnalytics } from './gscClient.js';
import { calculateMetrics } from './gscMetrics.js';

// How many days of daily time-series to keep fresh on each sync.
const DAILY_SERIES_DAYS = 30;

/**
 * Format a Date as YYYY-MM-DD.
 */
function fmt(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Fetch the last N days of daily GSC metrics and upsert them as a time-series.
 */
async function syncDailySeries(project) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() - 2); // GSC ~2-day delay
  const start = new Date(end);
  start.setDate(start.getDate() - (DAILY_SERIES_DAYS - 1));

  const rows = await fetchDailySearchAnalytics(project.gscSiteUrl, fmt(start), fmt(end));

  let upserts = 0;
  for (const row of rows) {
    const dateStr = row.keys?.[0];
    if (!dateStr) continue;
    const date = new Date(`${dateStr}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) continue;
    await prisma.gscDailyMetric.upsert({
      where: { projectId_date: { projectId: project.id, date } },
      create: {
        projectId: project.id,
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
 * @returns {{ projectId: string, status: string, error?: string }}
 */
export async function syncProject(project) {
  try {
    const now = new Date();
    // Current period: last 7 days (GSC data has ~2 day delay so -9 to -2)
    const currentEnd = new Date(now);
    currentEnd.setDate(currentEnd.getDate() - 2);
    const currentStart = new Date(currentEnd);
    currentStart.setDate(currentStart.getDate() - 6);

    // Previous period: the 7 days before that
    const prevEnd = new Date(currentStart);
    prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - 6);

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

    // Persist daily time-series (best-effort — don't fail the KPI sync on it)
    let dailyPoints = 0;
    try {
      dailyPoints = await syncDailySeries(project);
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
 * Called by the daily cron job.
 */
export async function runGscSync() {
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
    const result = await syncProject(project);
    results.push(result);
  }

  return {
    total: projects.length,
    success: results.filter((r) => r.status === 'ok').length,
    errors: results.filter((r) => r.status === 'error').length,
    details: results,
  };
}
