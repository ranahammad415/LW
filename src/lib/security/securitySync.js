/**
 * Security platform pulls (contract v1.6.0 §36.1): security-status {detail: "full"}, security-history and
 * backup-status. Called by the leader-only daily EmDash job (emdashSync.syncAllEmdashProjects, 03:00) and by the
 * OWNER/PM "Refresh" button. Read-only for the site; no AI, bounded (3 calls per site per run, 4 with config).
 *
 * Failures are graceful: 429 RATE_LIMITED stores retryAfterUntil (details.retryAfterSec) and stops; 501
 * NOT_IMPLEMENTED (no site-sentinel) and 503 UPSTREAM_UNAVAILABLE (sentinel not started yet) are recorded per call
 * and the next run tries again. No retries inside a run (the site budget is 60 calls/min per key).
 */
import { prisma } from '../prisma.js';
import { loadEmdashConnection } from '../cmsStore.js';
import { CmsBridgeError, emdashRoutes } from '../siteAdapters/emdash.js';
import { recordStatusPull, recordHistory, recordBackupStatus } from './securityStore.js';
import { J } from './jsonNull.js';

const caps = (project) => (project?.cmsCapabilities && typeof project.cmsCapabilities === 'object' ? project.cmsCapabilities : {});
export const hasSecurity = (project) => project?.cmsType === 'EMDASH' && caps(project).security === true;
export const hasBackups = (project) => project?.cmsType === 'EMDASH' && caps(project).backups === true;
export const hasSecurityLogs = (project) => project?.cmsType === 'EMDASH' && caps(project).logs === true;
export const hasSecurityConfig = (project) => project?.cmsType === 'EMDASH' && caps(project).securityConfig === true;

const NO_RETRY = Object.freeze({ retryDelays: [] });
const DEFAULT_RETRY_AFTER_SEC = 60;
/** A destination is "missed" this long after its nextExpectedAt without a newer success (plan §5.2 graceMin). */
export const BACKUP_MISSED_GRACE_MS = 60 * 60 * 1000;

/**
 * One rule for "this archive's backup was missed" (server-side missed detection and the client backup tile, O-R2-3):
 * nextExpectedAt + 60 min has passed and there is no success since nextExpectedAt.
 */
export function backupOverdue(archive, now = Date.now()) {
  if (!archive?.nextExpectedAt) return false;
  const t = now instanceof Date ? now.getTime() : now;
  const due = Date.parse(archive.nextExpectedAt);
  const last = archive.lastOkAt ? Date.parse(archive.lastOkAt) : 0;
  return Number.isFinite(due) && due + BACKUP_MISSED_GRACE_MS < t && last < due;
}

export function retryAfterSecOf(err) {
  const n = Number(err?.details?.retryAfterSec);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.ceil(n), 3600) : DEFAULT_RETRY_AFTER_SEC;
}

async function setStatus(projectId, data) {
  await prisma.securitySiteStatus.upsert({ where: { projectId }, update: J(data), create: J({ projectId, ...data }) });
}

/**
 * Detect missed backups from nextExpectedAt (the OS raises "missed" itself, contract §36.3): for each archive whose
 * nextExpectedAt + grace has passed with no success since, store a synthetic `missed:` run (once) and check the
 * destination's failure streak.
 */
export async function detectMissedBackups(project, backups, { now = new Date(), log } = {}) {
  if (!backups) return 0;
  const { checkBackupFailures } = await import('./securityAlerts.js');
  const targets = [];
  const add = (id, owner, type, label, archive) => {
    if (backupOverdue(archive, now)) targets.push({ id, owner, type, label, expectedAt: archive.nextExpectedAt });
  };
  add('agency-db', 'agency', null, 'the agency database backup', backups.agency?.db);
  add('agency-files', 'agency', null, 'the agency files backup', backups.agency?.files);
  for (const d of backups.client || []) {
    add(d.destinationId, 'client', d.type, d.label, d.db);
    add(d.destinationId, 'client', d.type, d.label, d.files);
  }
  let n = 0;
  for (const t of targets) {
    const runId = `missed:${t.id}:${t.expectedAt}`.slice(0, 160);
    const exists = await prisma.securityBackupRun.findUnique({ where: { projectId_runId: { projectId: project.id, runId } } });
    if (exists) continue;
    try {
      await prisma.securityBackupRun.create({
        data: { projectId: project.id, runId, owner: t.owner, destinationId: t.id, destinationType: t.type, destinationLabel: t.label, startedAt: new Date(t.expectedAt), result: 'missed', origin: 'os' },
      });
    } catch {
      continue; // unique race with another run: already recorded
    }
    n += 1;
    await checkBackupFailures(project, { id: t.id, owner: t.owner, label: t.label }, { now, log }).catch(() => {});
  }
  return n;
}

/**
 * Pull everything the site's capabilities offer. `interactive` (Refresh button) surfaces a 429 to the caller as
 * a CmsBridgeError; the background run records it and returns.
 */
export async function pullSecurity(projectId, { interactive = false, log, now = new Date() } = {}) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, leadPmId: true, clientId: true, cmsType: true, cmsCapabilities: true, cmsRepairNeededAt: true, status: true },
  });
  if (!project || project.cmsType !== 'EMDASH') throw new CmsBridgeError({ status: 400, code: 'VALIDATION', message: 'EmDash sites only.' });
  if (!hasSecurity(project) && !hasBackups(project)) {
    throw new CmsBridgeError({ status: 409, code: 'NOT_IMPLEMENTED', message: 'This site does not share security status with Agency OS yet.' });
  }
  if (project.cmsRepairNeededAt) throw new CmsBridgeError({ status: 503, code: 'NOT_PAIRED', message: 'The website connection needs to be renewed first.' });
  const st = await prisma.securitySiteStatus.findUnique({ where: { projectId }, select: { retryAfterUntil: true } });
  if (st?.retryAfterUntil && new Date(st.retryAfterUntil).getTime() > now.getTime()) {
    const retryAfterSec = Math.ceil((new Date(st.retryAfterUntil).getTime() - now.getTime()) / 1000);
    if (interactive) throw new CmsBridgeError({ status: 429, code: 'RATE_LIMITED', message: `The site asked Agency OS to wait ${retryAfterSec} s before asking again.`, retryable: true, details: { retryAfterSec } });
    return { skipped: 'rate_limited', retryAfterSec };
  }
  const { conn } = await loadEmdashConnection(projectId);
  const out = {};
  let lastError = null;
  const { alertForTransition, checkBackupFailures } = await import('./securityAlerts.js');

  const guard = async (name, fn) => {
    try {
      out[name] = await fn();
      return true;
    } catch (err) {
      const code = err instanceof CmsBridgeError ? err.code : 'ERROR';
      out[name] = code;
      lastError = code;
      if (code === 'RATE_LIMITED') {
        const retryAfterSec = retryAfterSecOf(err);
        await setStatus(projectId, { retryAfterUntil: new Date(now.getTime() + retryAfterSec * 1000), lastPullError: code, lastPullAt: now });
        if (interactive) throw new CmsBridgeError({ status: 429, code, message: `The site is busy; try again in ${retryAfterSec} s.`, retryable: true, details: { retryAfterSec } });
        throw Object.assign(new Error('stop'), { stop: true });
      }
      log?.warn?.({ projectId, route: name, code }, 'Security pull failed');
      return false;
    }
  };

  try {
    if (hasSecurity(project)) {
      await guard('status', async () => {
        const res = await emdashRoutes.securityStatus(conn, { detail: 'full' }, NO_RETRY);
        const rec = await recordStatusPull(projectId, res?.status, { now });
        for (const t of rec.transitions) await alertForTransition(project, t, { now, log }).catch(() => {});
        return rec.ok ? 'ok' : 'INVALID';
      });
      const hasPoints = await prisma.securityDailyPoint.count({ where: { projectId } });
      await guard('history', async () => {
        const res = await emdashRoutes.securityHistory(conn, { days: hasPoints > 1 ? 3 : 90 }, NO_RETRY);
        return recordHistory(projectId, res?.points);
      });
    }
    if (hasBackups(project)) {
      await guard('backups', async () => {
        const res = await emdashRoutes.backupStatus(conn, NO_RETRY);
        const rec = await recordBackupStatus(projectId, res, { now });
        for (const d of rec.newFailures) await checkBackupFailures(project, d, { now, log }).catch(() => {});
        await detectMissedBackups(project, rec.backups, { now, log });
        return rec.backups ? 'ok' : 'NO_RECORD';
      });
    }
    // v1.6.1 §37: mirror the settings once (first sync / pairing) and keep it fresh daily.
    if (hasSecurityConfig(project)) {
      await guard('config', async () => {
        const { pullSecurityConfig } = await import('./securityConfig.js');
        const cfg = await pullSecurityConfig(projectId, { conn, opts: NO_RETRY });
        return cfg ? 'ok' : 'INVALID';
      });
    }
  } catch (err) {
    if (!err?.stop) throw err;
    return out;
  }
  await setStatus(projectId, { lastPullAt: now, lastPullError: lastError, retryAfterUntil: null });
  return out;
}

/** Daily leader-only run for every paired EmDash project with security or backups (called from emdashSync). */
export async function pullSecurityForProject(projectId, { log } = {}) {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { cmsType: true, cmsCapabilities: true } });
  if (!hasSecurity(p) && !hasBackups(p)) return null;
  return pullSecurity(projectId, { log }).catch((err) => {
    log?.warn?.({ projectId, code: err?.code }, 'Daily security pull failed');
    return { error: err?.code || 'ERROR' };
  });
}

/**
 * logs-pull is Phase 3 (contract 1.6.0: always 501 NOT_IMPLEMENTED, capability logs false). This only checks
 * that the route fails gracefully; nothing is stored. Never scheduled.
 */
export async function probeSecurityLogs(projectId, { conn = null } = {}) {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { cmsType: true, cmsCapabilities: true } });
  if (!hasSecurityLogs(p)) return { supported: false, reason: 'capability_off' };
  const c = conn || (await loadEmdashConnection(projectId)).conn;
  try {
    await emdashRoutes.logsPull(c, { sinceCursor: 0, limit: 1 }, NO_RETRY);
    return { supported: true, stored: false };
  } catch (err) {
    if (err instanceof CmsBridgeError && (err.code === 'NOT_IMPLEMENTED' || err.status === 501)) return { supported: false, reason: 'not_implemented' };
    return { supported: false, reason: err?.code || 'ERROR' };
  }
}
