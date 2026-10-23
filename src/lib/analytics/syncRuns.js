/**
 * Background job status (AnalyticsSyncRun). A manual sync / refresh answers 202 with the run id and runs after the
 * response; the UI polls GET …/runs/:id, which any PM2 instance can answer because the status lives in the database.
 * A run still queued/running for less than STALE_RUN_MS blocks a second one of the same kind (+ project).
 */
import { prisma } from '../prisma.js';

export const STALE_RUN_MS = 45 * 60_000;
export const RUN_KINDS = Object.freeze(['integrations_sync', 'local_rank', 'local_grid', 'local_profile', 'citations_check', 'bing_sync']);

/** Public shape of a run (staff only; summary is OS-built JSON, no secrets). */
export function runView(run) {
  if (!run) return null;
  return {
    id: run.id,
    kind: run.kind,
    projectId: run.projectId || null,
    status: run.status,
    summary: run.summary ?? null,
    error: run.error || null,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    createdAt: run.createdAt,
  };
}

export async function activeRun(kind, projectId = null, now = new Date()) {
  return prisma.analyticsSyncRun.findFirst({
    where: {
      kind,
      projectId: projectId ?? null,
      status: { in: ['queued', 'running'] },
      createdAt: { gte: new Date(now.getTime() - STALE_RUN_MS) },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Create a run and start `work()` after the current request (setImmediate). Returns { run, existing }: when a run of
 * the same kind (+ project) is already active, that one is returned and nothing new starts.
 */
export async function startBackgroundRun({ kind, projectId = null, requestedById = null, log = console }, work) {
  if (!RUN_KINDS.includes(kind)) throw new Error(`Unknown run kind ${kind}`);
  const existing = await activeRun(kind, projectId);
  if (existing) return { run: existing, existing: true };
  const run = await prisma.analyticsSyncRun.create({ data: { kind, projectId, requestedById, status: 'queued' } });
  setImmediate(() => {
    executeRun(run.id, work, log).catch(() => null);
  });
  return { run, existing: false };
}

/** Run `work` and record the outcome (exported for tests). */
export async function executeRun(runId, work, log = console) {
  await prisma.analyticsSyncRun.update({ where: { id: runId }, data: { status: 'running', startedAt: new Date() } });
  try {
    const summary = await work();
    await prisma.analyticsSyncRun.update({
      where: { id: runId },
      data: { status: 'done', finishedAt: new Date(), summary: summary ?? null },
    });
    return summary;
  } catch (err) {
    log?.error?.({ err: err?.message, runId }, 'Background analytics run failed');
    await prisma.analyticsSyncRun.update({
      where: { id: runId },
      data: { status: 'error', finishedAt: new Date(), error: String(err?.message || 'failed').slice(0, 500) },
    });
    return null;
  }
}

export async function getRun(id) {
  return prisma.analyticsSyncRun.findUnique({ where: { id: String(id) } });
}
