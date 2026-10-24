/**
 * OS Backups crons (plan e.1), registered from src/index.js after app.listen, LEADER ONLY (isLeader: PM2
 * NODE_APP_INSTANCE 0 / unset) and only when OS_BACKUP_ENABLED=true with a valid key. The DB lock row (lock.js) is the
 * second layer: two leaders could never run two backups.
 *   OS_BACKUP_CRON (50 0,4,8,12,16,20 * * *)  scheduled backup (skipped: paused, maintenance, lock held, < 30 min since last)
 *   5 * * * *                                 monitor: retention, orphans, disk alert, stale alarm (> 9 h), reconcile
 *   * * * * * + boot                           crash recovery (plain node-cron: it must run during maintenance)
 *   30 0 * * *                                 detect() refresh
 */
import nodeCron from 'node-cron';
import { cron as gatedCron } from './cronGate.js';
import { prisma } from '../prisma.js';
import { isLeader } from '../interviewScheduler.js';
import { loadConfig, decryptKeys, featureProblem } from './config.js';
import * as store from './store.js';
import { lockHeld } from './lock.js';
import { ensureDirs, spawnWorker, readJobFile, writeJobFile, appendJournal, pidAlive, hostName } from './jobs.js';
import { isMaintenance, readMaintenance, clearMaintenance, setMaintenanceDir } from './maintenance.js';
import { runRetention, reconcile } from './catalog.js';
import { checkDiskSpace, statDir, dirUsage } from './disk.js';
import { decideRecovery } from './recovery.js';
import { sendTemplate, osBackupsUrl } from './emails.js';

const running = new Set();
async function guarded(name, fn, log, leader = isLeader) {
  if (!leader()) return { skipped: 'not-leader' };
  if (running.has(name)) return { skipped: 'running' };
  running.add(name);
  try {
    return await fn();
  } catch (err) {
    log?.error?.({ err: { code: err?.code, name: err?.name } }, `${name} failed`);
    return { error: err?.code || 'ERROR' };
  } finally {
    running.delete(name);
  }
}

/** Create a QUEUED job (row + job file) and spawn its worker. */
export async function startJob({ db, cfg, type, trigger, backupId = null, user = null, options = {}, spawn = spawnWorker, file = {} }) {
  const job = await store.insertJob(db, { id: store.newId(), type, trigger, status: 'QUEUED', phase: type === 'BACKUP' ? 'QUEUED' : 'PREFLIGHT', backupId, requestedById: user?.id || null, requestedByEmail: user?.email || null, progress: { options } });
  writeJobFile(cfg.dir, job.id, { type, trigger, status: 'QUEUED', phase: job.phase, createdAt: new Date().toISOString(), requestedByEmail: user?.email || null, ...file });
  const { pid } = spawn(cfg.dir, job.id);
  await store.updateJob(db, job.id, { workerPid: pid || null, workerHost: hostName() });
  appendJournal(cfg.dir, { event: `${type.toLowerCase()}.queued`, jobId: job.id, backupId, trigger, actorId: user?.id, actorEmail: user?.email });
  return job;
}

/** Pure-ish gate for the scheduled run. */
export function scheduledSkipReason({ state, maintenance, lastStartedAt, now = new Date() }) {
  if (state?.schedulePaused) return 'paused';
  if (maintenance) return 'maintenance';
  if (lockHeld(state, now)) return 'locked';
  if (lastStartedAt && now.getTime() - new Date(lastStartedAt).getTime() < 30 * 60_000) return 'recent';
  return null;
}

export async function scheduledBackupTick({ db = store.prismaSql(prisma), cfg = loadConfig(), log, spawn } = {}) {
  const state = await store.getState(db);
  const [last] = await store.listBackups(db, { limit: 1 });
  const reason = scheduledSkipReason({ state, maintenance: isMaintenance(), lastStartedAt: last?.startedAt });
  if (reason) return { skipped: reason };
  const job = await startJob({ db, cfg, type: 'BACKUP', trigger: 'CRON', spawn });
  log?.info?.({ jobId: job.id }, 'OS backup scheduled run started');
  return { jobId: job.id };
}

export async function monitorTick({ db = store.prismaSql(prisma), cfg = loadConfig(), log, now = new Date() } = {}) {
  if (isMaintenance()) return { skipped: 'maintenance' };
  const ret = await runRetention({ db, cfg, now });
  const rec = await reconcile({ db, dir: cfg.dir, keys: decryptKeys(cfg) });
  const state = await store.getState(db);
  const owners = await store.activeOwners(db);
  const out = { ...ret, ...rec };
  // Disk (at most one email per 24 h).
  const backups = await store.listBackups(db, { limit: 20 });
  const last = backups.find((b) => b.status === 'READY');
  const stat = await statDir(cfg.dir);
  const disk = checkDiskSpace({ freeBytes: stat.freeBytes, lastFileBytes: Number(last?.sizeBytes) || 0, minFreeMb: cfg.minFreeMb, quotaMb: cfg.quotaMb, usedBytes: cfg.quotaMb ? await dirUsage(cfg.dir) : 0 });
  const day = 24 * 3_600_000;
  if (!disk.ok && (!state.lastDiskAlertAt || now - new Date(state.lastDiskAlertAt) > day)) {
    await store.updateState(db, { lastDiskAlertAt: now });
    await sendTemplate('diskLow', { freeBytes: disk.freeBytes, requiredBytes: disk.requiredBytes, actionUrl: osBackupsUrl() }, owners);
    out.diskAlert = true;
  }
  // Stale: no READY backup for > 9 h while the schedule runs (at most one email per 24 h).
  const newestReady = last ? new Date(last.startedAt) : null;
  const stale = !state.schedulePaused && (!newestReady || now - newestReady > cfg.staleHours * 3_600_000);
  if (stale && (!state.lastStaleAlertAt || now - new Date(state.lastStaleAlertAt) > day)) {
    await store.updateState(db, { lastStaleAlertAt: now });
    await sendTemplate('backupStale', { lastSuccessAt: state.lastSuccessAt, actionUrl: osBackupsUrl() }, owners);
    out.staleAlert = true;
  }
  return out;
}

/** Crash recovery tick: acts only on maintenance.json or a stale RUNNING job whose worker is gone. */
export async function recoveryTick({ db = store.prismaSql(prisma), cfg = loadConfig(), log, spawn = spawnWorker, now = Date.now() } = {}) {
  const maintenance = readMaintenance(cfg.dir);
  const active = await store.activeJobs(db).catch(() => []);
  const candidates = maintenance?.jobId ? [maintenance.jobId] : active.filter((j) => j.status === 'RUNNING').map((j) => j.id);
  if (!maintenance && !candidates.length) return { action: 'NONE' };
  const alive = (pid, host) => (host && host !== hostName() ? false : pidAlive(pid));
  const results = [];
  for (const jobId of candidates.length ? candidates : [null]) {
    const fileJob = jobId ? readJobFile(cfg.dir, jobId) : null;
    const rowJob = jobId ? await store.getJob(db, jobId).catch(() => null) : null;
    const job = fileJob || rowJob ? { ...(rowJob || {}), ...(fileJob || {}), heartbeatAt: latest(fileJob?.heartbeatAt, rowJob?.heartbeatAt), type: rowJob?.type || fileJob?.type, status: rowJob?.status || fileJob?.status } : null;
    let safetyReady = false;
    const safetyId = job?.safetyBackupId || rowJob?.safetyBackupId;
    if (safetyId) {
      const b = await store.getBackup(db, safetyId).catch(() => null);
      safetyReady = b?.status === 'READY';
    }
    const decision = decideRecovery({ maintenance, job, safetyReady, now, alive });
    results.push(decision);
    if (decision.action === 'NONE') continue;
    log?.warn?.({ jobId, action: decision.action }, 'OS backup crash recovery');
    appendJournal(cfg.dir, { event: `recovery.${decision.action.toLowerCase()}`, jobId, phase: job?.phase });
    if (decision.action === 'CLEAR') {
      clearMaintenance(cfg.dir);
      await store.updateState(db, { maintenanceJobId: null });
    } else if (decision.action === 'CLEAR_AND_FAIL' || decision.action === 'FAIL_BACKUP') {
      await store.updateJob(db, jobId, { status: 'FAILED', error: 'WORKER_DIED: the worker stopped (nothing changed)', finishedAt: new Date(now) });
      writeJobFile(cfg.dir, jobId, { status: 'FAILED', error: 'WORKER_DIED: the worker stopped (nothing changed)', finishedAt: new Date(now).toISOString() });
      await store.forceReleaseLockRow(db);
      if (rowJob?.backupId && job.type === 'BACKUP') await store.updateBackup(db, rowJob.backupId, { status: 'FAILED', error: 'WORKER_DIED' }).catch(() => {});
      if (decision.action === 'CLEAR_AND_FAIL') {
        clearMaintenance(cfg.dir);
        await store.updateState(db, { maintenanceJobId: null });
        const n = fileJob?.notify;
        if (n) await sendTemplate('restoreFailed', { error: 'the restore worker stopped before changing data' }, n.owners, { settings: n.branding }).catch(() => 0);
      }
    } else if (decision.action === 'ROLLBACK') {
      await store.forceReleaseLockRow(db);
      const rb = await startJob({ db, cfg, type: 'ROLLBACK', trigger: 'RECOVERY', backupId: job.backupId || null, options: { originalJobId: jobId }, spawn });
      await store.updateJob(db, rb.id, { safetyBackupId: safetyId });
      writeJobFile(cfg.dir, jobId, { phase: 'ROLLING_BACK', rollbackJobId: rb.id });
      results[results.length - 1].rollbackJobId = rb.id;
    } else if (decision.action === 'KEEP_AND_ALERT') {
      if (jobId && job?.type === 'ROLLBACK') {
        const orig = job?.progress?.options?.originalJobId;
        for (const id of [jobId, orig].filter(Boolean)) {
          await store.updateJob(db, id, { status: 'FAILED_ROLLBACK', phase: 'FAILED_ROLLBACK', error: 'Rollback worker stopped' }).catch(() => {});
          writeJobFile(cfg.dir, id, { status: 'FAILED_ROLLBACK', phase: 'FAILED_ROLLBACK', error: 'Rollback worker stopped' });
        }
      } else if (jobId) {
        await store.updateJob(db, jobId, { status: 'FAILED_ROLLBACK', phase: 'FAILED_ROLLBACK', error: 'Worker stopped and no safety backup is READY' }).catch(() => {});
        writeJobFile(cfg.dir, jobId, { status: 'FAILED_ROLLBACK', phase: 'FAILED_ROLLBACK', error: 'Worker stopped and no safety backup is READY' });
      }
      const n = fileJob?.notify || { owners: await store.activeOwners(db).catch(() => []), branding: null };
      await sendTemplate('restoreFailed', { rollbackFailed: true, error: decision.reason || 'worker stopped' }, n.owners, { settings: n.branding }).catch(() => 0);
    }
  }
  return results.length === 1 ? results[0] : { results };
}

function latest(a, b) {
  const ta = a ? new Date(a).getTime() : 0;
  const tb = b ? new Date(b).getTime() : 0;
  return ta >= tb ? a || null : b || null;
}

export async function detectTick({ db = store.prismaSql(prisma), cfg = loadConfig() } = {}) {
  const { detect } = await import('./detect.js');
  const { openDataConnection, dataAdapter } = await import('./dbConn.js');
  let data = null;
  try {
    data = dataAdapter(await openDataConnection(cfg.databaseUrl));
    const result = await detect({ cfg, data });
    await store.updateState(db, { detectJson: result, detectedAt: new Date() });
    return result;
  } finally {
    if (data) await data.end();
  }
}

export function startOsBackupJobs(log, { cfg = loadConfig() } = {}) {
  setMaintenanceDir(cfg.dir);
  const problem = featureProblem(cfg);
  if (problem) {
    log?.info?.({ reason: problem }, 'OS backups: crons not registered');
    return { registered: false, reason: problem };
  }
  if (!nodeCron.validate(cfg.cron)) {
    log?.error?.({ cron: cfg.cron }, 'OS backups: OS_BACKUP_CRON is not a valid cron expression');
    return { registered: false, reason: 'bad cron' };
  }
  try {
    ensureDirs(cfg.dir);
  } catch (err) {
    log?.error?.({ err: { code: err?.code } }, 'OS backups: cannot create OS_BACKUP_DIR');
  }
  gatedCron.schedule(cfg.cron, () => guarded('osBackup.scheduled', () => scheduledBackupTick({ cfg, log }), log));
  gatedCron.schedule('5 * * * *', () => guarded('osBackup.monitor', () => monitorTick({ cfg, log }), log));
  gatedCron.schedule('30 0 * * *', () => guarded('osBackup.detect', () => detectTick({ cfg }), log));
  // Crash recovery must run while maintenance is on: plain node-cron.
  nodeCron.schedule('* * * * *', () => guarded('osBackup.recovery', () => recoveryTick({ cfg, log }), log));
  setTimeout(() => guarded('osBackup.recovery', () => recoveryTick({ cfg, log }), log), 5000).unref?.();
  log?.info?.({ leader: isLeader(), cron: cfg.cron }, 'OS backup jobs scheduled');
  return { registered: true };
}
