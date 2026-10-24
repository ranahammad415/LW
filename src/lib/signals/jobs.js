/**
 * Leader-only signals jobs (backend.md §6; PM2 cluster: isLeader() = NODE_APP_INSTANCE 0 / unset). Registered from
 * src/index.js with ONE call (startSignalsJobs). Each job also keeps an in-process "running" flag so a slow run never
 * overlaps itself, and the sessionizer's claims are compare-and-set, so even two leaders could not double-count.
 * SIGNALS_ENABLED=false turns every job off (ingest keeps storing so the sites' outboxes are answered).
 *   every 5 min  signals.sessionize → signals.attribute → owed site erasures
 *   03:10        signals.bots (session level only)
 *   03:20        signals-summary pull per site with capabilities.signals (1 call per site, data-quality panel)
 *   03:30        signals.rollup (dirty dates + yesterday)
 *   04:00        signals.retention (compaction + deletes, ≤ 5 000 rows per statement)
 * No AI calls anywhere in this module.
 */
import cron from '../osBackup/cronGate.js'; // node-cron + maintenance gate (features/os-backups.md)
import { prisma } from '../prisma.js';
import { isLeader } from '../emdashSync.js';
import { signalsJobsEnabled } from './common.js';
import { runSessionizer } from './sessionize.js';
import { attributeLeads } from './attribution.js';
import { retryPendingSignalErasures } from './erase.js';
import { runBotRescore } from './bots.js';
import { runRollup } from './rollup.js';
import { runRetention } from './retention.js';
import { pullSignalsSummary } from './config.js';

const running = new Set();

/** Run `fn` once at a time per job name, leader only, errors logged (never thrown into node-cron). */
export async function guarded(name, fn, log, { leader = isLeader, enabled = signalsJobsEnabled } = {}) {
  if (!enabled() || !leader()) return { skipped: true };
  if (running.has(name)) return { skipped: 'running' };
  running.add(name);
  try {
    return await fn();
  } catch (err) {
    log?.error?.({ err: { message: err?.message, code: err?.code } }, `${name} failed`);
    return { error: err?.code || 'ERROR' };
  } finally {
    running.delete(name);
  }
}

export async function runFiveMinuteTick(log) {
  const sessionized = await runSessionizer({ log });
  const attributed = await attributeLeads({ log });
  const erasures = await retryPendingSignalErasures({ log });
  return { sessionized, attributed, erasures };
}

/** Daily signals-summary for the data-quality panel: one call per paired site with the capability. */
export async function pullAllSignalsSummaries(log) {
  const projects = await prisma.project.findMany({
    where: { cmsType: 'EMDASH', cmsPairedAt: { not: null }, cmsRepairNeededAt: null, status: { not: 'ARCHIVED' } },
    select: { id: true, cmsCapabilities: true },
  });
  let pulled = 0;
  for (const p of projects) {
    if (p.cmsCapabilities?.signals !== true) continue;
    try {
      if (await pullSignalsSummary(p.id)) pulled += 1;
    } catch (err) {
      log?.warn?.({ projectId: p.id, code: err?.code }, 'signals-summary pull failed');
    }
  }
  return { pulled };
}

export function startSignalsJobs(log) {
  cron.schedule('*/5 * * * *', () => guarded('signals.tick', () => runFiveMinuteTick(log), log));
  cron.schedule('10 3 * * *', () => guarded('signals.bots', () => runBotRescore({ log }), log));
  cron.schedule('20 3 * * *', () => guarded('signals.summary', () => pullAllSignalsSummaries(log), log));
  cron.schedule('30 3 * * *', () => guarded('signals.rollup', () => runRollup({ log }), log));
  cron.schedule('0 4 * * *', () => guarded('signals.retention', () => runRetention({ log }), log));
  log?.info?.({ leader: isLeader(), enabled: signalsJobsEnabled() }, 'Signals jobs scheduled');
}
