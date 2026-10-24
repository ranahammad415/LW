/**
 * Job runner used by the detached worker (worker.js) and the CLI: BACKUP, RESTORE and ROLLBACK jobs (plan e.3, f).
 * Connections: one mysql2 "control" connection (preserved tables, GET_LOCK, heartbeats) and one "data" connection
 * (snapshot dump / drop + load). Never Prisma. The job file in OS_BACKUP_DIR/jobs/ is the truth the UI polls; the job
 * row mirrors it (the four osbackup* tables are never dropped, so the row stays writable during a restore).
 * Logs carry phases, table names, counts and bytes only.
 */
import fs from 'fs';
import path from 'path';
import { loadConfig, decryptKeys, featureProblem } from './config.js';
import { openControlConnection, openDataConnection, dataAdapter, sanitizeError, LwosError } from './dbConn.js';
import * as store from './store.js';
import { acquireLock, getMysqlLock, heartbeat as lockHeartbeat, releaseLock, releaseMysqlLock, HEARTBEAT_MS } from './lock.js';
import { runBackup } from './backup.js';
import { runRetention } from './catalog.js';
import { checkDiskSpace, statDir, dirUsage } from './disk.js';
import { appendJournal, ensureDirs, hostName, layout, writeJobFile, readJobFile } from './jobs.js';
import { readManifest, verifyManifestHmac, manifestNameFor } from './manifest.js';
import { verifyBackupFile } from './verify.js';
import { compareSchema, listCodeMigrations } from './compat.js';
import { writeMaintenance, updateMaintenancePhase, clearMaintenance, readMaintenance } from './maintenance.js';
import { takeSnapshot, applyCarryForward } from './securityCarryForward.js';
import { restoreDatabase, verifyRestore } from './restoreEngine.js';
import { sendTemplate, restorePageUrl, osBackupsUrl } from './emails.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (log, msg, extra = {}) => log?.(`[os-backup] ${new Date().toISOString()} ${msg}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}`);

function makeCtx({ cfg, db, job, log }) {
  let lastDbWrite = 0;
  const options = job.progress?.options || {};
  const ctx = {
    cfg,
    db,
    job,
    log,
    options,
    jobId: job.id,
    /** Phase / progress → job file (always) + job row (throttled to 2 s, always on a phase change). */
    async report(patch, { force = false } = {}) {
      const file = writeJobFile(cfg.dir, job.id, patch);
      const t = Date.now();
      if (force || patch.phase || patch.status || t - lastDbWrite > 2000) {
        lastDbWrite = t;
        const row = {};
        if (patch.status) row.status = patch.status;
        if (patch.phase) row.phase = patch.phase;
        if (patch.progress) row.progress = { ...patch.progress, options };
        if (patch.error !== undefined) row.error = patch.error;
        if (patch.safetyBackupId) row.safetyBackupId = patch.safetyBackupId;
        if (patch.finishedAt) row.finishedAt = new Date(patch.finishedAt);
        await store.updateJob(db, job.id, row).catch(() => {});
      }
      return file;
    },
  };
  return ctx;
}

function startHeartbeat(ctx) {
  const beat = async () => {
    const at = new Date();
    writeJobFile(ctx.cfg.dir, ctx.jobId, { heartbeatAt: at.toISOString(), workerPid: process.pid, workerHost: hostName() });
    await store.updateJob(ctx.db, ctx.jobId, { heartbeatAt: at }).catch(() => {});
    await lockHeartbeat(ctx.db, ctx.jobId).catch(() => {});
    if (ctx.mirrorJobId) writeJobFile(ctx.cfg.dir, ctx.mirrorJobId, { heartbeatAt: at.toISOString() });
  };
  const t = setInterval(() => beat().catch(() => {}), HEARTBEAT_MS);
  return { beat, stop: () => clearInterval(t) };
}

async function takeLocks(ctx) {
  if (!(await acquireLock(ctx.db, ctx.jobId))) throw new LwosError('LOCKED', 'Another backup or restore holds the lock');
  ctx.lockRow = true;
  if (!(await getMysqlLock(ctx.db))) throw new LwosError('LOCKED', 'Another backup or restore holds the MySQL lock');
  ctx.mysqlLock = true;
}
async function dropLocks(ctx) {
  if (ctx.mysqlLock) await releaseMysqlLock(ctx.db);
  if (ctx.lockRow) await releaseLock(ctx.db, ctx.jobId).catch(() => {});
}

async function diskCheck(ctx, nextFileBytes) {
  const backups = await store.listBackups(ctx.db, { limit: 50 });
  const last = backups.find((b) => b.status === 'READY');
  const stat = await statDir(ctx.cfg.dir);
  const usedBytes = ctx.cfg.quotaMb ? await dirUsage(ctx.cfg.dir) : 0;
  const state = await store.getState(ctx.db);
  const homeDu = Number(state?.detectJson?.homeUsageKb) > 0 ? Number(state.detectJson.homeUsageKb) * 1024 : 0;
  return checkDiskSpace({ freeBytes: stat.freeBytes, lastFileBytes: Number(last?.sizeBytes) || 0, nextFileBytes, minFreeMb: ctx.cfg.minFreeMb, quotaMb: ctx.cfg.quotaMb, usedBytes: Math.max(usedBytes, homeDu) });
}

async function ownersAndBranding(db) {
  return { owners: await store.activeOwners(db).catch(() => []), branding: await store.agencyBranding(db).catch(() => null) };
}

// ── BACKUP ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function backupJob(ctx) {
  const { cfg, db, job } = ctx;
  await takeLocks(ctx);
  await ctx.report({ status: 'RUNNING', phase: 'DISK', startedAt: new Date().toISOString() });
  const disk = await diskCheck(ctx);
  if (!disk.ok) {
    await maybeDiskAlert(ctx, disk);
    throw new LwosError('DISK_LOW', `Not enough disk space (${Math.round(disk.freeBytes / 1048576)} MB free, ${Math.round(disk.requiredBytes / 1048576)} MB needed)`);
  }
  const data = dataAdapter(await openDataConnection(cfg.databaseUrl));
  try {
    await ctx.report({ phase: 'DUMP' });
    const kind = job.trigger === 'CRON' ? 'SCHEDULED' : 'MANUAL';
    const out = await runBackup({
      cfg,
      data,
      db,
      kind,
      createdBy: job.requestedById ? { id: job.requestedById, email: job.requestedByEmail } : null,
      onProgress: (p) => ctx.report({ progress: p }).catch(() => {}),
    });
    await store.updateJob(db, job.id, { backupId: out.id });
    await ctx.report({ phase: 'PRUNE', backupId: out.id, fileName: out.fileName });
    const ret = await runRetention({ db, cfg }).catch(() => ({ pruned: 0 }));
    await store.updateState(db, { consecutiveFailures: 0, lastSuccessAt: new Date(), lastError: null, lastFailureAlertAt: null });
    appendJournal(cfg.dir, { event: 'backup.ready', jobId: job.id, backupId: out.id, fileName: out.fileName, trigger: job.trigger, tables: out.manifest.totals.tables, rows: out.manifest.totals.rows, bytes: out.manifest.totals.fileBytes, durationMs: out.manifest.durationMs });
    say(ctx.log, 'backup ready', { tables: out.manifest.totals.tables, rows: out.manifest.totals.rows, bytes: out.manifest.totals.fileBytes, pruned: ret.pruned });
    return { status: 'SUCCEEDED', backupId: out.id };
  } finally {
    await data.end();
  }
}

async function maybeDiskAlert(ctx, disk) {
  const state = await store.getState(ctx.db);
  const last = state?.lastDiskAlertAt ? new Date(state.lastDiskAlertAt).getTime() : 0;
  if (Date.now() - last < 24 * 3_600_000) return;
  await store.updateState(ctx.db, { lastDiskAlertAt: new Date() });
  const { owners, branding } = await ownersAndBranding(ctx.db);
  await sendTemplate('diskLow', { freeBytes: disk.freeBytes, requiredBytes: disk.requiredBytes, actionUrl: osBackupsUrl() }, owners, { settings: branding });
}

async function recordBackupFailure(ctx, err) {
  const { db, job } = ctx;
  const state = await store.getState(db).catch(() => null);
  if (!state) return;
  const failures = (Number(state.consecutiveFailures) || 0) + 1;
  await store.updateState(db, { consecutiveFailures: failures, lastFailureAt: new Date(), lastError: sanitizeError(err) }).catch(() => {});
  if (job.trigger === 'CRON' && failures >= 2 && !state.lastFailureAlertAt) {
    await store.updateState(db, { lastFailureAlertAt: new Date() }).catch(() => {});
    const { owners, branding } = await ownersAndBranding(db);
    await sendTemplate('backupFailing', { failures, error: String(err?.code || 'ERROR'), lastSuccessAt: state.lastSuccessAt, actionUrl: osBackupsUrl() }, owners, { settings: branding }).catch(() => 0);
  }
}

// ── RESTORE ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function loadVerifiedBackup(cfg, db, backupId) {
  const b = await store.getBackup(db, backupId);
  if (!b || b.status !== 'READY') throw new LwosError('NOT_READY', 'The backup is not READY');
  const file = path.join(layout(cfg.dir).backups, b.fileName);
  if (!fs.existsSync(file)) throw new LwosError('MISSING', 'The backup file is not on disk');
  const manifest = await readManifest(path.join(layout(cfg.dir).backups, manifestNameFor(b.fileName)));
  if (!verifyManifestHmac(manifest, decryptKeys(cfg))) throw new LwosError('BAD_MANIFEST', 'The manifest signature does not match (tampered or another key)');
  return { backup: b, file, manifest };
}

async function restoreJob(ctx) {
  const { cfg, db, job } = ctx;
  const keys = decryptKeys(cfg);
  const started = Date.now();
  await ctx.report({ status: 'RUNNING', phase: 'PREFLIGHT', startedAt: new Date().toISOString() }, { force: true });

  // ── PREFLIGHT: nothing changes if any of this fails ──
  const target = await loadVerifiedBackup(cfg, db, job.backupId);
  const v = await verifyBackupFile(target.file, keys, target.manifest);
  if (!v.ok) throw new LwosError('VERIFY_FAILED', `The backup file failed verification: ${v.error}`);
  const compat = compareSchema(target.manifest.migrations?.names || [], listCodeMigrations());
  if (compat.status === 'NEWER') throw new LwosError('SCHEMA_NEWER', 'The backup was made by newer code: deploy that code first');
  if (compat.status === 'OLDER' && !ctx.options.acknowledgeOlderSchema) throw new LwosError('SCHEMA_OLDER', 'The backup is older than the code and the warning was not acknowledged');
  const disk = await diskCheck(ctx, Number(target.manifest.totals?.fileBytes) || 0);
  if (!disk.ok) throw new LwosError('DISK_LOW', 'Not enough disk space for the safety backup');
  await takeLocks(ctx);
  const { owners, branding } = await ownersAndBranding(db);
  const requester = owners.find((o) => o.id === job.requestedById) || { email: job.requestedByEmail };
  await ctx.report({ notify: { owners, branding }, compat, backup: { id: target.backup.id, startedAt: target.backup.startedAt, fileName: target.backup.fileName, sizeBytes: target.backup.sizeBytes } });

  // ── MAINTENANCE_ON + DRAIN ──
  writeMaintenance(cfg.dir, { jobId: job.id, kind: 'restore', startedAt: new Date().toISOString(), phase: 'MAINTENANCE_ON', retryAfter: 300 });
  await store.updateState(db, { maintenanceJobId: job.id });
  appendJournal(cfg.dir, { event: 'restore.maintenance_on', jobId: job.id, backupId: target.backup.id });
  await ctx.report({ phase: 'MAINTENANCE_ON' });
  await ctx.report({ phase: 'DRAIN' });
  updateMaintenancePhase(cfg.dir, 'DRAIN');
  const drainMs = Number(process.env.LWOS_DRAIN_MS);
  await sleep(Number.isFinite(drainMs) && drainMs >= 0 ? drainMs : 15_000);
  let data = dataAdapter(await openDataConnection(cfg.databaseUrl));
  await killOwnBusyQueries(data, [data.threadId, ctx.controlThreadId]);

  // ── SAFETY_BACKUP (inside maintenance: nothing changes after it) ──
  await ctx.report({ phase: 'SAFETY_BACKUP' });
  updateMaintenancePhase(cfg.dir, 'SAFETY_BACKUP');
  let safety;
  try {
    safety = await runBackup({ cfg, data, db, kind: 'SAFETY', safetyForJobId: job.id, createdBy: { id: job.requestedById, email: job.requestedByEmail }, onProgress: (p) => ctx.report({ progress: p }).catch(() => {}) });
  } catch (err) {
    await data.end();
    clearMaintenance(cfg.dir);
    await store.updateState(db, { maintenanceJobId: null });
    const e = new LwosError('SAFETY_FAILED', `Safety backup failed (${String(err?.code || 'ERROR')}): nothing changed`);
    await finish(ctx, 'FAILED', e);
    await sendTemplate('restoreFailed', { backupAt: target.backup.startedAt, error: e.message }, owners, { settings: branding }).catch(() => 0);
    return { status: 'FAILED', done: true };
  }
  await store.updateJob(db, job.id, { safetyBackupId: safety.id });
  const safetyInfo = { id: safety.id, fileName: safety.fileName, startedAt: safety.manifest.startedAt };
  await ctx.report({ safetyBackupId: safety.id, safetyBackup: safetyInfo });

  // ── RESTORING → POST_RESTORE → VERIFYING (any error → ROLLING_BACK) ──
  let snap = null;
  let purged = [];
  try {
    await ctx.report({ phase: 'RESTORING' });
    updateMaintenancePhase(cfg.dir, 'RESTORING');
    snap = await takeSnapshot(data);
    const loaded = await restoreDatabase(data, target.file, keys, target.manifest, { onProgress: (p) => ctx.report({ progress: p }).catch(() => {}) });
    purged = loaded.purged;
    await ctx.report({ phase: 'POST_RESTORE' });
    updateMaintenancePhase(cfg.dir, 'POST_RESTORE');
    await applyCarryForward(data, snap, { carryForwardCredentials: ctx.options.carryForwardCredentials !== false, mode: 'restore' });
    await ctx.report({ phase: 'VERIFYING' });
    updateMaintenancePhase(cfg.dir, 'VERIFYING');
    const problems = await verifyRestore(data, target.manifest, { purged });
    if (problems.length) throw new LwosError('RESTORE_VERIFY_FAILED', problems[0]);
  } catch (err) {
    const reason = sanitizeError(err);
    say(ctx.log, 'restore failed, rolling back', { error: reason });
    appendJournal(cfg.dir, { event: 'restore.rolling_back', jobId: job.id, error: reason });
    await data.end();
    data = null;
    const rb = await rollbackTo(ctx, { safetyFile: safety.file, safetyManifest: safety.manifest, snap, reason });
    if (rb.ok) {
      await sendTemplate('restoreRolledBack', { backupAt: target.backup.startedAt, error: reason }, owners, { settings: branding }).catch(() => 0);
      return { status: 'ROLLED_BACK', done: true };
    }
    await sendTemplate('restoreFailed', { rollbackFailed: true, error: reason, safetyFile: safety.fileName }, owners, { settings: branding }).catch(() => 0);
    return { status: 'FAILED_ROLLBACK', done: true };
  } finally {
    if (data) await data.end();
  }

  // ── FINALIZING ──
  await ctx.report({ phase: 'FINALIZING' });
  updateMaintenancePhase(cfg.dir, 'FINALIZING');
  const { reconcile } = await import('./catalog.js');
  await reconcile({ db, dir: cfg.dir, keys }).catch(() => {});
  const restoredTo = new Date(target.backup.startedAt).toISOString();
  for (const o of owners) {
    await db
      .x('INSERT INTO `systemalert` (`id`, `userId`, `type`, `message`, `isRead`, `actionUrl`, `createdAt`) VALUES (?, ?, ?, ?, 0, ?, UTC_TIMESTAMP(3))', [store.newId(), o.id, 'os_restore', `Agency OS was restored to the backup from ${restoredTo.slice(0, 16).replace('T', ' ')} UTC`, '/portal/admin/os-backups'])
      .catch(() => {}); // an owner created after the backup no longer exists
  }
  const needsMigration = compat.status === 'OLDER';
  const status = needsMigration ? 'NEEDS_MIGRATION' : 'SUCCEEDED';
  appendJournal(cfg.dir, { event: needsMigration ? 'restore.needs_migration' : 'restore.succeeded', jobId: job.id, backupId: target.backup.id, safetyBackupId: safety.id, durationMs: Date.now() - started, compat: compat.status });
  await finish(ctx, status, null, { phase: needsMigration ? 'NEEDS_MIGRATION' : 'DONE', missingMigrations: compat.missingMigrations });
  const mail = { backupAt: target.backup.startedAt, actorEmail: requester.email, durationMs: Date.now() - started, safetyFile: safety.fileName, safetyAt: safety.manifest.startedAt, missingCount: compat.missingMigrations.length, actionUrl: restorePageUrl(job.id), actionLabel: 'Open the restore page' };
  await sendTemplate(needsMigration ? 'restoreNeedsMigration' : 'restoreCompleted', mail, owners, { settings: branding }).catch(() => 0);
  if (needsMigration) updateMaintenancePhase(cfg.dir, 'NEEDS_MIGRATION');
  else {
    clearMaintenance(cfg.dir);
    await store.updateState(db, { maintenanceJobId: null });
  }
  return { status, done: true };
}

/** Restore the safety backup (no new safety backup), carry-forward, verify. Leaves maintenance ON when it fails. */
export async function rollbackTo(ctx, { safetyFile, safetyManifest, snap, reason, mirrorJobId = null }) {
  const { cfg, db } = ctx;
  const keys = decryptKeys(cfg);
  const targets = [ctx.jobId, mirrorJobId].filter(Boolean);
  const mark = async (patch) => {
    for (const id of targets) writeJobFile(cfg.dir, id, patch);
    for (const id of targets) await store.updateJob(db, id, { ...(patch.status ? { status: patch.status } : {}), ...(patch.phase ? { phase: patch.phase } : {}), ...(patch.error ? { error: patch.error } : {}), ...(patch.finishedAt ? { finishedAt: new Date(patch.finishedAt) } : {}) }).catch(() => {});
  };
  await mark({ phase: 'ROLLING_BACK', rollbackReason: reason });
  updateMaintenancePhase(cfg.dir, 'ROLLING_BACK');
  let data = null;
  try {
    data = dataAdapter(await openDataConnection(cfg.databaseUrl));
    const loaded = await restoreDatabase(data, safetyFile, keys, safetyManifest, { failAfterStatements: Infinity, onProgress: (p) => writeJobFile(cfg.dir, ctx.jobId, { progress: p }) });
    await applyCarryForward(data, snap, snap ? { carryForwardCredentials: true, mode: 'restore' } : { mode: 'rollback' });
    const problems = await verifyRestore(data, safetyManifest, { purged: loaded.purged });
    if (problems.length) throw new LwosError('ROLLBACK_VERIFY_FAILED', problems[0]);
    await mark({ status: 'ROLLED_BACK', phase: 'ROLLED_BACK', error: reason, finishedAt: new Date().toISOString() });
    appendJournal(cfg.dir, { event: 'restore.rolled_back', jobId: ctx.jobId, error: reason });
    clearMaintenance(cfg.dir);
    await store.updateState(db, { maintenanceJobId: null }).catch(() => {});
    return { ok: true };
  } catch (err) {
    const e = sanitizeError(err);
    await mark({ status: 'FAILED_ROLLBACK', phase: 'FAILED_ROLLBACK', error: `${reason}; rollback: ${e}`.slice(0, 500), finishedAt: new Date().toISOString() });
    appendJournal(cfg.dir, { event: 'restore.failed_rollback', jobId: ctx.jobId, error: e });
    updateMaintenancePhase(cfg.dir, 'FAILED_ROLLBACK');
    return { ok: false, error: e };
  } finally {
    if (data) await data.end();
  }
}

// ── ROLLBACK job (crash recovery spawned it) ───────────────────────────────────────────────────────────────────────
async function rollbackJob(ctx) {
  const { cfg, db, job } = ctx;
  const originalJobId = job.progress?.options?.originalJobId || null;
  ctx.mirrorJobId = originalJobId;
  await ctx.report({ status: 'RUNNING', phase: 'ROLLING_BACK', startedAt: new Date().toISOString() }, { force: true });
  await takeLocks(ctx);
  const safety = await loadVerifiedBackup(cfg, db, job.safetyBackupId);
  const notify = (originalJobId && readJobFile(cfg.dir, originalJobId)?.notify) || { owners: [], branding: null };
  const rb = await rollbackTo(ctx, { safetyFile: safety.file, safetyManifest: safety.manifest, snap: null, reason: 'Restore worker stopped; rolled back by crash recovery', mirrorJobId: originalJobId });
  if (rb.ok) await sendTemplate('restoreRolledBack', { backupAt: null, error: 'the restore worker stopped' }, notify.owners, { settings: notify.branding }).catch(() => 0);
  else await sendTemplate('restoreFailed', { rollbackFailed: true, error: rb.error, safetyFile: safety.backup.fileName }, notify.owners, { settings: notify.branding }).catch(() => 0);
  return { status: rb.ok ? 'ROLLED_BACK' : 'FAILED_ROLLBACK', done: true };
}

async function killOwnBusyQueries(data, ownIds) {
  try {
    const [me] = await data.rows('SELECT CURRENT_USER() AS u');
    const user = String(me?.u || '').split('@')[0];
    const list = await data.rows('SHOW PROCESSLIST');
    for (const p of list) {
      const id = Number(p.Id ?? p.ID);
      if (!id || ownIds.includes(id)) continue;
      if (String(p.User) !== user) continue;
      if (String(p.Command) === 'Query' && Number(p.Time) > 10) await data.exec(`KILL QUERY ${id}`).catch(() => {});
    }
  } catch {
    /* best effort */
  }
}

async function finish(ctx, status, err, extra = {}) {
  const patch = { status, finishedAt: new Date().toISOString(), error: err ? sanitizeError(err) : null, ...extra };
  if (!patch.phase) patch.phase = status === 'SUCCEEDED' ? 'DONE' : status;
  await ctx.report(patch, { force: true });
}

/** Run one job by id. `log` = line logger (console.log in the worker). Never throws. */
export async function runJob(jobId, { cfg = loadConfig(), log = console.log } = {}) {
  ensureDirs(cfg.dir);
  const problem = featureProblem(cfg, { requireEnabled: false });
  let ctl = null;
  let ctx = null;
  let hb = null;
  try {
    ctl = await openControlConnection(cfg.databaseUrl);
    const db = store.mysqlSql(ctl);
    const job = await store.getJob(db, jobId);
    if (!job) throw new LwosError('NO_JOB', 'Job not found');
    ctx = makeCtx({ cfg, db, job, log });
    ctx.controlThreadId = ctl.threadId ?? ctl.connection?.threadId;
    if (problem) throw new LwosError('DISABLED', problem);
    await store.updateJob(db, job.id, { status: 'RUNNING', workerPid: process.pid, workerHost: hostName(), heartbeatAt: new Date(), startedAt: new Date() });
    writeJobFile(cfg.dir, job.id, { type: job.type, status: 'RUNNING', workerPid: process.pid, workerHost: hostName(), heartbeatAt: new Date().toISOString() });
    hb = startHeartbeat(ctx);
    say(log, `job start ${job.type}`, { trigger: job.trigger });
    let res;
    if (job.type === 'BACKUP') res = await backupJob(ctx);
    else if (job.type === 'RESTORE') res = await restoreJob(ctx);
    else if (job.type === 'ROLLBACK') res = await rollbackJob(ctx);
    else throw new LwosError('BAD_JOB', 'Unknown job type');
    if (!res.done) await finish(ctx, res.status, null, res.backupId ? { backupId: res.backupId } : {});
    say(log, `job end ${res.status}`);
    return res;
  } catch (err) {
    const msg = sanitizeError(err);
    say(log, 'job failed', { error: msg });
    if (ctx) {
      if (ctx.job.type === 'BACKUP') await recordBackupFailure(ctx, err).catch(() => {});
      await finish(ctx, 'FAILED', err).catch(() => {});
      // Before the safety backup nothing changed; in FINALIZING the data is already restored and verified. Either way
      // no maintenance file of ours may stay behind. (RESTORING..VERIFYING errors are handled by the rollback above.)
      const m = readMaintenance(cfg.dir);
      if (m && m.jobId === ctx.jobId && ['PREFLIGHT', 'MAINTENANCE_ON', 'DRAIN', 'FINALIZING'].includes(m.phase)) {
        clearMaintenance(cfg.dir);
        await store.updateState(ctx.db, { maintenanceJobId: null }).catch(() => {});
      }
      appendJournal(cfg.dir, { event: `${String(ctx.job.type).toLowerCase()}.failed`, jobId: ctx.jobId, error: msg });
      if (ctx.job.type === 'RESTORE' && ctx.notified !== true) {
        const n = readJobFile(cfg.dir, ctx.jobId)?.notify;
        if (n) await sendTemplate('restoreFailed', { error: msg }, n.owners, { settings: n.branding }).catch(() => 0);
      }
    } else {
      try {
        writeJobFile(cfg.dir, jobId, { status: 'FAILED', error: msg, finishedAt: new Date().toISOString() });
      } catch {
        /* bad id */
      }
    }
    return { status: 'FAILED', error: msg };
  } finally {
    hb?.stop();
    if (ctx) await dropLocks(ctx).catch(() => {});
    if (ctl) await ctl.end().catch(() => {});
  }
}
