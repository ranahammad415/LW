/**
 * Crash recovery (plan f.6), leader only, every minute + at boot. Acts only when maintenance.json exists or a
 * RUNNING job's heartbeat is stale (> 2 min) AND its worker pid is gone. Decision table (pure, unit-tested):
 *   restore job, phase ≤ SAFETY_BACKUP         → CLEAR_AND_FAIL  (DB untouched)
 *   restore job, phase ≥ RESTORING, safety OK   → ROLLBACK        (spawn a ROLLBACK worker on the safety backup)
 *   restore job, phase ≥ RESTORING, no safety   → KEEP_AND_ALERT  (maintenance stays on, owners emailed)
 *   rollback job died                           → KEEP_AND_ALERT  (FAILED_ROLLBACK; never loop)
 *   job already final (SUCCEEDED, ...)          → CLEAR           (the worker died after finishing)
 *   NEEDS_MIGRATION / FAILED_ROLLBACK           → NONE            (waits for the owner)
 *   backup job stale                            → FAIL_BACKUP     (release the lock, delete the partial)
 */
export const PHASES = ['PREFLIGHT', 'MAINTENANCE_ON', 'DRAIN', 'SAFETY_BACKUP', 'RESTORING', 'POST_RESTORE', 'VERIFYING', 'FINALIZING', 'DONE'];
export const STALE_MS = 2 * 60_000;
const phaseIndex = (p) => PHASES.indexOf(p);

export function isStale(job, now = Date.now(), aliveFn = () => false) {
  const hb = job?.heartbeatAt ? new Date(job.heartbeatAt).getTime() : 0;
  if (now - hb <= STALE_MS) return false;
  return !aliveFn(job?.workerPid, job?.workerHost);
}

export function decideRecovery({ maintenance, job, safetyReady, now = Date.now(), alive = () => false }) {
  if (!job) return maintenance ? { action: 'KEEP_AND_ALERT', reason: 'maintenance without a job file' } : { action: 'NONE' };
  if (['NEEDS_MIGRATION', 'FAILED_ROLLBACK'].includes(job.status)) return { action: 'NONE' };
  if (['SUCCEEDED', 'ROLLED_BACK', 'FAILED'].includes(job.status)) return maintenance ? { action: 'CLEAR', reason: 'job already finished' } : { action: 'NONE' };
  if (!isStale(job, now, alive)) return { action: 'NONE' };
  if (job.type === 'BACKUP') return { action: 'FAIL_BACKUP' };
  if (job.type === 'ROLLBACK') return { action: 'KEEP_AND_ALERT', reason: 'rollback worker died' };
  const i = phaseIndex(job.phase || 'PREFLIGHT');
  if (i <= phaseIndex('SAFETY_BACKUP') && job.phase !== 'ROLLING_BACK') return { action: 'CLEAR_AND_FAIL' };
  if (safetyReady) return { action: 'ROLLBACK' };
  return { action: 'KEEP_AND_ALERT', reason: 'no READY safety backup' };
}
