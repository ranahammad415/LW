/**
 * Daily GSC sync orchestrator.
 * Queries all projects with gscSiteUrl, fetches GSC data, and writes
 * ClientMetricSnapshot records for the associated client.
 */
import { prisma } from './prisma.js';
import { isGscEnabled, fetchSearchAnalytics } from './gscClient.js';
import { calculateMetrics } from './gscMetrics.js';

/**
 * Format a Date as YYYY-MM-DD.
 */
function fmt(d) {
  return d.toISOString().slice(0, 10);
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

    // Update last synced timestamp
    await prisma.project.update({
      where: { id: project.id },
      data: { gscLastSyncedAt: new Date() },
    });

    return { projectId: project.id, status: 'ok', metricsCount: metrics.length };
  } catch (err) {
    return { projectId: project.id, status: 'error', error: err.message };
  }
}

/**
 * Run GSC sync for all configured projects.
 * Called by the daily cron job.
 */
export async function runGscSync() {
  if (!isGscEnabled()) {
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
