/**
 * Contract v1.9.1 §41 (restore from the site admin), OS side (restore architecture §7.3).
 *
 * Policy (§41.1): the OS NEVER starts a restore, a rollback or a verify. There is no route for it and none may be added.
 * This module only stores what the site reports:
 *   - backup.restore_started | restore_completed | restore_failed | restore_rolled_back events (SiteRestore, keyed on
 *     the site's restoreId). Idempotent per restoreId AND phase: restore_started may be re-sent from the restored
 *     database with a NEW eventId (same restoreId); a phase seen before only fills fields still empty and never alerts
 *     again (alert keys restore:<restoreId>:<phase>, claimed once);
 *   - backup-status `backups.restore { lastRestore, active }` (origin pull; absent below 1.9.1);
 *   - the Health v2 / signals `data_gap` marker (database scopes) from pointInTime to restore_completed.at;
 *   - site entities that disappeared with a database restore: leads (by the site's createdAt, here) and EmDash entries
 *     (by the next full inventory, lib/emdashSync.js) are marked `orphanedByRestoreId`, never deleted.
 * Every value reaching these functions was validated, bounded and redacted by lib/siteAdapters/security.js.
 */
import { prisma } from '../prisma.js';
import { J } from './jsonNull.js';
import { RESTORE_DB_SCOPES, sanitizeRestoreState, isoOrNull } from '../siteAdapters/security.js';

/** A restore that started this recently and has not finished keeps the uptime prober from paging (§41.5). */
export const RESTORE_MAINTENANCE_WINDOW_MS = 30 * 60_000;
/** ... and so does one that completed / was rolled back this recently (the process restarts around the swap). */
export const RESTORE_AFTER_SWAP_GRACE_MS = 10 * 60_000;
/** COUNTER_REGRESSION within this time of a restore is logged as "after a restore" (§41.4 says it must not happen). */
export const RESTORE_REGRESSION_LOOKBACK_MS = 48 * 60 * 60_000;
/** The client tile shows a restore for this long after it finished. */
export const CLIENT_RESTORE_TILE_DAYS = 30;

const PHASE_OF = Object.freeze({
  'backup.restore_started': 'started',
  'backup.restore_completed': 'completed',
  'backup.restore_failed': 'failed',
  'backup.restore_rolled_back': 'rolled_back',
});

const toDate = (v) => (v ? new Date(v) : null);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const isDbScope = (scope) => RESTORE_DB_SCOPES.includes(scope);

function isUniqueViolation(err) {
  return err && (err.code === 'P2002' || /Unique constraint/i.test(String(err.message || '')));
}

/** Only the keys of `patch` whose stored value is still empty (a re-sent phase never overwrites what is stored). */
export function fillOnly(existing, patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    if (!existing || existing[k] === null || existing[k] === undefined) out[k] = v;
  }
  return out;
}

/**
 * The data gap of a restore (pure): database scopes only (files scopes: no restart, no bridge pause, no gap).
 * Completed: [eventsLostAfter ?? pointInTime ?? startedAt, completedAt]. Rolled back (site team, 2026-10-23): the rollback
 * swaps the pre-restore database back (counters raised again), so the restore's own gap is undone and the rows the site
 * wrote between restore_completed.at and restore_rolled_back.at are lost: [completedAt ?? startedAt, rolledBackAt].
 */
export function dataGapOf(row) {
  if (!row || !isDbScope(row.scope)) return null;
  if (row.result === 'rolled_back' && row.rolledBackAt) {
    const from = row.completedAt || row.startedAt;
    return from ? { from: new Date(from), to: new Date(row.rolledBackAt) } : null;
  }
  if (row.result === 'ok' && row.completedAt) {
    const from = row.eventsLostAfter || row.pointInTime || row.startedAt;
    return from ? { from: new Date(from), to: new Date(row.completedAt) } : null;
  }
  return null;
}

/** New result of a row given the incoming phase (pure). rolled_back is final; ok is never downgraded to failed. */
export function nextResult(current, phase) {
  if (current === 'rolled_back') return 'rolled_back';
  if (phase === 'rolled_back') return 'rolled_back';
  if (phase === 'completed') return 'ok';
  if (phase === 'failed') return current === 'ok' ? 'ok' : 'failed';
  return current || 'running'; // started
}

const sourceCols = (source) =>
  source ? { sourceOwner: source.owner, sourceDestinationId: source.destinationId ?? null, sourceType: source.type } : {};

/** One phase's patch (pure): `fill` = descriptive fields (only when empty), `phaseCols` = the phase's own columns. */
export function phasePatch(phase, data, evAt) {
  switch (phase) {
    case 'started':
      return {
        fill: { scope: data.scope, pointInTime: toDate(data.pointInTime), ...sourceCols(data.source), byRole: data.byRole, preExport: data.preExport },
        // startedAt is overwritten: a completion that arrived first only derived it (at − durationMs)
        phaseCols: { startedAt: new Date(evAt), rollbackPoint: data.rollbackPoint },
        // rollbackPoint exists only on restore_started: "this phase is stored" (startedAt alone may be derived / pulled)
        marker: 'rollbackPoint',
      };
    case 'completed': {
      const at = new Date(evAt);
      return {
        fill: {
          scope: data.scope,
          pointInTime: toDate(data.pointInTime),
          ...sourceCols(data.source),
          // derived when restore_started never arrived (its event can be lost with the old database, §41.4)
          startedAt: new Date(at.getTime() - data.durationMs),
        },
        phaseCols: {
          completedAt: at,
          durationMs: data.durationMs,
          counts: data.counts,
          schemaFrom: data.schema?.from ?? null,
          schemaTo: data.schema?.to ?? null,
          countersRaised: data.bridge ? data.bridge.countersRaised : null,
          eventsLostAfter: toDate(data.bridge?.eventsLostAfter),
          phase: 'done',
        },
        marker: 'completedAt',
      };
    }
    case 'failed':
      return {
        fill: { scope: data.scope },
        phaseCols: { failedAt: new Date(evAt), phase: data.phase, errorCode: data.errorCode, retryable: data.retryable },
        marker: 'failedAt',
      };
    case 'rolled_back':
      return {
        fill: {},
        phaseCols: { rollbackId: data.rollbackId, rolledBackAt: new Date(data.at || evAt), rolledBackByRole: data.byRole },
        marker: 'rolledBackAt',
      };
    default:
      return null;
  }
}

async function findRestore(projectId, restoreId) {
  return prisma.siteRestore.findUnique({ where: { projectId_restoreId: { projectId, restoreId } } });
}

/**
 * Create-or-update one SiteRestore with `build(existing) → { data, apply }`. A concurrent create of the same restoreId
 * (two PM2 instances, an event and a pull) loses the unique race and is applied as an update.
 */
async function writeRestore(projectId, restoreId, build, origin) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await findRestore(projectId, restoreId);
    const { data, apply } = build(existing);
    if (!apply) return { row: existing, changed: false, existing };
    if (existing) {
      const row = await prisma.siteRestore.update({ where: { id: existing.id }, data: J(data) });
      return { row: { ...existing, ...data, ...(row && typeof row === 'object' ? row : {}) }, changed: true, existing };
    }
    try {
      const row = await prisma.siteRestore.create({ data: J({ projectId, restoreId, origin, result: 'running', ...data }) });
      return { row: { projectId, restoreId, origin, result: 'running', ...data, ...(row && typeof row === 'object' ? row : {}) }, changed: true, existing: null };
    } catch (err) {
      if (!isUniqueViolation(err) || attempt > 0) throw err;
    }
  }
  return { row: null, changed: false, existing: null };
}

/** Recompute and store the data gap when it moved (database scopes only). */
async function syncDataGap(row) {
  const gap = dataGapOf(row);
  const from = gap?.from ?? null;
  const to = gap?.to ?? null;
  const same = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);
  if (same(row.dataGapFrom, from) && same(row.dataGapTo, to)) return row;
  await prisma.siteRestore.update({ where: { id: row.id }, data: { dataGapFrom: from, dataGapTo: to } });
  return { ...row, dataGapFrom: from, dataGapTo: to };
}

/**
 * Site leads that disappeared with a database restore (§41.4): created on the site after the backup's point in time
 * and before the restore finished. Only our own copies of site leads (provider emdash, not erased); GoHighLevel leads
 * are OS-owned. Marked, never deleted. Returns the number marked now.
 */
export async function markOrphanLeads(row, { now = new Date(), from, to } = {}) {
  if (!row?.id || !isDbScope(row.scope) || !from || !to) return 0;
  const res = await prisma.cmsLead.updateMany({
    where: {
      projectId: row.projectId,
      provider: 'emdash',
      erasedAt: null,
      orphanedByRestoreId: null,
      siteCreatedAt: { gt: new Date(from), lt: new Date(to) },
    },
    data: { orphanedByRestoreId: row.restoreId, orphanedAt: now },
  });
  const n = res?.count || 0;
  if (n) await prisma.siteRestore.update({ where: { id: row.id }, data: { orphanedLeads: { increment: n } } });
  return n;
}

/** A rollback brings the pre-restore database back: the leads this restore had orphaned exist again. */
export async function clearOrphanLeads(row) {
  if (!row?.restoreId) return 0;
  const res = await prisma.cmsLead.updateMany({
    where: { projectId: row.projectId, orphanedByRestoreId: row.restoreId },
    data: { orphanedByRestoreId: null, orphanedAt: null },
  });
  if (res?.count) await prisma.siteRestore.update({ where: { id: row.id }, data: { orphanedLeads: 0 } });
  return res?.count || 0;
}

/** At most this many GHL mirrors are re-queued per restore / rollback (the lead-import queue then sends ≤ 20 a minute). */
export const REMIRROR_MAX = 500;

/**
 * GoHighLevel leads whose site mirror (lead-import) the database swap removed (site team, 2026-10-23): re-queue them on
 * the existing lead-import queue with a new idempotency epoch (`mirrorRestoreId`: the restoreId, or the rollbackId after
 * a rollback) and `cmsMirrorLeadId` cleared; the new response sets it again. Once per restore and once per rollback
 * (compare-and-set on SiteRestore.remirrorAt / remirrorRollbackAt), at most REMIRROR_MAX leads.
 *   completed (db / full): ghl, not erased, mirrorState done, received after pointInTime and before completion
 *     (older mirrors are in the restored backup and still exist);
 *   rolled_back: ghl, not erased, done, received between completion and rollback, or re-mirrored by this restore
 *     (that new mirror lived in the database rolled away; the site de-duplicates on provider + contact + form).
 */
export async function requeueGhlMirrors(row, phase, { now = new Date(), log } = {}) {
  if (!row?.id || !isDbScope(row.scope)) return 0;
  const claimCol = phase === 'rolled_back' ? 'remirrorRollbackAt' : 'remirrorAt';
  let window;
  let epoch;
  if (phase === 'completed') {
    if (!row.pointInTime || !row.completedAt) return 0;
    window = { gt: new Date(row.pointInTime), lt: new Date(row.completedAt) };
    epoch = row.restoreId;
  } else {
    if (!row.completedAt || !row.rolledBackAt) return 0;
    window = { gt: new Date(row.completedAt), lt: new Date(row.rolledBackAt) };
    epoch = row.rollbackId || `rb_${row.restoreId}`.slice(0, 64);
  }
  const claim = await prisma.siteRestore.updateMany({ where: { id: row.id, [claimCol]: null }, data: { [claimCol]: now } });
  if (!claim?.count) return 0;
  const base = { projectId: row.projectId, provider: 'ghl', erasedAt: null, mirrorState: 'done' };
  const inWindow = [{ siteCreatedAt: window }, { siteCreatedAt: null, receivedAt: window }];
  const OR = phase === 'rolled_back' ? [...inWindow, { mirrorRestoreId: row.restoreId }] : inWindow;
  const leads = await prisma.cmsLead.findMany({ where: { ...base, OR }, select: { id: true }, orderBy: { receivedAt: 'asc' }, take: REMIRROR_MAX + 1 });
  const ids = leads.slice(0, REMIRROR_MAX).map((l) => l.id);
  if (!ids.length) return 0;
  const res = await prisma.cmsLead.updateMany({
    where: { id: { in: ids }, mirrorState: 'done' },
    data: { mirrorState: 'pending', mirrorNextAt: now, mirrorAttempts: 0, mirrorError: null, cmsMirrorLeadId: null, mirrorRestoreId: epoch },
  });
  const n = res?.count || 0;
  if (leads.length > REMIRROR_MAX) log?.warn?.({ projectId: row.projectId, restoreId: row.restoreId, requeued: n }, `Site restore: more than ${REMIRROR_MAX} GHL mirrors to re-create; the rest need a staff Retry`);
  else log?.info?.({ projectId: row.projectId, restoreId: row.restoreId, phase, requeued: n }, 'Site restore: GHL lead mirrors re-queued (lead-import)');
  return n;
}

/** Leads / entries / GHL mirrors after the database changed for `row` (completion or rollback). */
async function reconcileAfterSwap(row, phase, { now, log }) {
  if (!isDbScope(row.scope)) return;
  if (phase === 'completed' && row.result === 'ok') {
    const from = row.pointInTime || row.eventsLostAfter;
    const n = await markOrphanLeads(row, { now, from, to: row.completedAt });
    if (n) log?.info?.({ projectId: row.projectId, restoreId: row.restoreId, leads: n }, 'Site restore: leads created after the backup point marked orphaned_by_restore');
    await requeueGhlMirrors(row, 'completed', { now, log });
  }
  if (phase === 'rolled_back') {
    const cleared = await clearOrphanLeads(row);
    // What the site received between the restore and the rollback lived in the database that was rolled away.
    const n = row.completedAt && row.rolledBackAt ? await markOrphanLeads(row, { now, from: row.completedAt, to: row.rolledBackAt }) : 0;
    if (cleared || n) log?.info?.({ projectId: row.projectId, restoreId: row.restoreId, cleared, leads: n }, 'Site restore rolled back: orphan markers updated');
    await requeueGhlMirrors(row, 'rolled_back', { now, log });
  }
}

/**
 * backup.restore_* event → SiteRestore (+ data gap, orphan markers, alert). Returns the receipt outcome:
 * 'applied' (a phase seen for the first time) or 'stale' (that phase of that restore is already stored; a re-sent
 * restore_started with a new eventId lands here and only fills empty fields).
 */
export async function applyRestoreEvent(project, type, data, ev, { log, now = new Date(), alert = true } = {}) {
  const phase = PHASE_OF[type];
  if (!phase || !data?.restoreId) return 'stored';
  const projectId = project.id;
  const evAt = isoOrNull(ev?.at) || now.toISOString();
  const patch = phasePatch(phase, data, evAt);
  let firstTime = false;
  const out = await writeRestore(
    projectId,
    data.restoreId,
    (existing) => {
      firstTime = !existing || !existing[patch.marker];
      const fill = fillOnly(existing, patch.fill);
      const own = firstTime ? Object.fromEntries(Object.entries(patch.phaseCols).filter(([, v]) => v !== undefined)) : {};
      const result = nextResult(existing?.result, firstTime ? phase : 'started');
      const changedResult = !existing || existing.result !== result;
      const dataOut = { ...fill, ...own, ...(changedResult ? { result } : {}) };
      return { data: dataOut, apply: !existing || Object.keys(dataOut).length > 0 };
    },
    'event'
  );
  if (!out.row) return 'stored';
  if (phase === 'failed' && firstTime && out.existing?.result === 'ok') {
    // Site team: restore_failed never follows restore_completed for one restoreId. Kept ok; reported as a site bug.
    log?.warn?.({ projectId, restoreId: data.restoreId, phase: data.phase, errorCode: data.errorCode }, 'Site bug: backup.restore_failed after restore_completed for the same restoreId (result kept ok)');
  }
  if (!firstTime) {
    log?.info?.({ projectId, restoreId: data.restoreId, phase, eventId: ev?.eventId }, 'Site restore phase already stored (re-sent event); gaps filled only');
    return 'stale';
  }
  let row = await syncDataGap(out.row);
  try {
    await reconcileAfterSwap(row, phase, { now, log });
  } catch (err) {
    log?.warn?.({ err: { message: err?.message }, projectId, restoreId: data.restoreId }, 'Site restore: orphan marking failed');
  }
  if (phase === 'completed' && isDbScope(row.scope) && row.countersRaised === false) {
    // §41.4: the site raises cursor / review / entry after a database restore. It says it did not: a
    // COUNTER_REGRESSION ("Re-pair needed") may follow. Logged loudly, never hidden.
    log?.warn?.({ projectId, restoreId: data.restoreId }, 'Site restore completed WITHOUT raised counters (bridge.countersRaised=false): expect COUNTER_REGRESSION; tell the site team');
  }
  // A restore_started delivered after its own completion / failure (re-sent from the restored database) is stored but
  // never announced as "started".
  const lateStart = phase === 'started' && row.result !== 'running';
  // e2e O-C191-5: a files / files-subset restore sends started and completed back to back (no restart, no pause): the
  // started alert is held and the completion (or failure) is the one alert. If neither ever comes, the leader-only hourly
  // sweep (sweepHeldRestoreStarts) sends the held "started" alert, so nothing is lost.
  // S-C191-1: a held feed event keeps its own time; a restore_started older than an hour when it arrives is history,
  // not news (its completion / failure, delivered with it, alerts instead; the sweep covers the rest).
  const heldStart =
    phase === 'started' &&
    (!isDbScope(row.scope) || now.getTime() - Date.parse(evAt) > RESTORE_START_ALERT_MAX_AGE_MS);
  if (alert && !lateStart && !heldStart) {
    const { alertRestore } = await import('./securityAlerts.js');
    alertRestore(project, phase, row, { now, log }).catch((err) => log?.warn?.({ err: { message: err?.message }, restoreId: data.restoreId }, 'Site restore alert failed'));
  }
  return 'applied';
}

/**
 * backup-status / security-status `backups.restore` (origin pull; absent below 1.9.1 → nothing happens). Fills what
 * the events did not bring (a restore whose events were lost), keeps `rollbackAvailableUntil` current and records the
 * active phase. Never alerts (alerts ride on events). Returns the sanitized state or null.
 */
export async function recordRestoreState(projectId, raw, { now = new Date(), log } = {}) {
  // Idempotent: an already sanitized state passes unchanged.
  const state = sanitizeRestoreState(raw);
  if (!state) return null;
  const l = state.lastRestore;
  if (l) {
    // lastRestore.at is when the RESTORE finished, also for result rolled_back (the rollback time comes only from the
    // restore_rolled_back event's `at`); rollbackAvailableUntil is null on a rolled_back record.
    const terminal = l.result === 'ok' || l.result === 'rolled_back' ? { completedAt: toDate(l.at) } : l.result === 'failed' ? { failedAt: toDate(l.at) } : {};
    const out = await writeRestore(
      projectId,
      l.restoreId,
      (existing) => {
        const fill = fillOnly(existing, { scope: l.scope, pointInTime: toDate(l.pointInTime), ...sourceCols(l.source), byRole: l.byRole, ...terminal });
        const result = existing?.result === 'rolled_back' ? 'rolled_back' : existing?.result === 'ok' && l.result === 'failed' ? 'ok' : l.result;
        const until = toDate(l.rollbackAvailableUntil);
        const sameUntil = (existing?.rollbackAvailableUntil ? new Date(existing.rollbackAvailableUntil).getTime() : null) === (until ? until.getTime() : null);
        const data = { ...fill, ...(!existing || existing.result !== result ? { result } : {}), ...(!sameUntil ? { rollbackAvailableUntil: until } : {}) };
        return { data, apply: !existing || Object.keys(data).length > 0 };
      },
      'pull'
    );
    if (out.changed && out.row) {
      const row = await syncDataGap(out.row);
      // A database restore the OS learns about only from the pull (its events were lost): mark orphans once.
      const newlyOk = row.result === 'ok' && (!out.existing || out.existing.result !== 'ok') && !out.existing?.completedAt;
      if (newlyOk) await reconcileAfterSwap(row, 'completed', { now, log }).catch(() => {});
    }
  }
  const a = state.active;
  if (a) {
    await writeRestore(
      projectId,
      a.restoreId,
      (existing) => {
        const fill = fillOnly(existing, { scope: a.scope, startedAt: toDate(a.startedAt) });
        const phase = existing?.result && existing.result !== 'running' ? {} : existing?.phase === a.phase ? {} : { phase: a.phase };
        const data = { ...fill, ...phase };
        return { data, apply: !existing || Object.keys(data).length > 0 };
      },
      'pull'
    );
  }
  return state;
}

/** Health v2 / signals markers: `data_gap` windows overlapping [since, until] (staff views). */
export async function restoreDataGaps(projectId, { since = null, until = null } = {}) {
  const where = { projectId, dataGapFrom: { not: null }, dataGapTo: { not: null } };
  if (since) where.dataGapTo = { gte: new Date(since) };
  if (until) where.dataGapFrom = { lte: new Date(until) };
  const rows = await prisma.siteRestore.findMany({
    where,
    orderBy: { dataGapFrom: 'desc' },
    take: 20,
    select: { restoreId: true, scope: true, result: true, dataGapFrom: true, dataGapTo: true },
  });
  return rows.map((r) => ({
    kind: 'data_gap',
    reason: r.result === 'rolled_back' ? 'site_restore_rolled_back' : 'site_restore',
    from: iso(r.dataGapFrom),
    to: iso(r.dataGapTo),
    restoreId: r.restoreId,
  }));
}

/**
 * Is the site in (or just out of) a restore maintenance window? Used by the uptime prober so a 503 / restart around
 * the swap never pages on-call (§41.5). One indexed query, only after a failed probe of an EmDash site.
 */
export async function restoreMaintenanceWindow(projectId, now = new Date()) {
  const t = now.getTime();
  return prisma.siteRestore.findFirst({
    where: {
      projectId,
      OR: [
        { result: 'running', startedAt: { gte: new Date(t - RESTORE_MAINTENANCE_WINDOW_MS) } },
        { completedAt: { gte: new Date(t - RESTORE_AFTER_SWAP_GRACE_MS) } },
        { rolledBackAt: { gte: new Date(t - RESTORE_AFTER_SWAP_GRACE_MS) } },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    select: { restoreId: true, phase: true, result: true, startedAt: true },
  });
}

/** A restore_started older than this when it arrives is not announced on arrival (S-C191-1, held events). */
export const RESTORE_START_ALERT_MAX_AGE_MS = 60 * 60_000;
/** The hourly sweep announces a held "started" once the restore has been running this long without an outcome. */
export const RESTORE_HELD_START_GRACE_MS = 15 * 60_000;
/** A database restore still "running" this long after its start no longer holds back events-replay (lost completion). */
export const RESTORE_OPEN_MAX_MS = 2 * 60 * 60_000;

/**
 * Leader-only (hourly EmDash maintenance): restores still running ≥ 15 min after a start whose alert was held (files
 * scopes, or a start delivered late) get their "started" info alert now, worded as "no outcome yet". The alert key
 * restore:<restoreId>:started is claimed once, so a start that was announced on arrival is never sent twice.
 */
export async function sweepHeldRestoreStarts({ now = new Date(), log } = {}) {
  const rows = await prisma.siteRestore.findMany({
    where: { result: 'running', rollbackPoint: { not: null }, startedAt: { lte: new Date(now.getTime() - RESTORE_HELD_START_GRACE_MS), gte: new Date(now.getTime() - 7 * 86400_000) } },
    take: 50,
  });
  if (!rows.length) return 0;
  const { alertRestore } = await import('./securityAlerts.js');
  let sent = 0;
  for (const row of rows) {
    const project = await prisma.project.findUnique({ where: { id: row.projectId }, select: { id: true, name: true, leadPmId: true, clientId: true } });
    if (!project) continue;
    const out = await alertRestore(project, 'started', { ...row, noOutcomeYet: true }, { now, log }).catch(() => null);
    if (out?.routed && out.routed !== 'deduped') sent += 1;
  }
  if (sent) log?.info?.({ sent }, 'Held site restore "started" alerts sent (no outcome yet)');
  return sent;
}

/**
 * e2e O-C191-2: a database restore is open on the site (restore_started stored, no completion / failure / rollback yet,
 * started ≤ 2 h ago). events-replay is skipped meanwhile: events pulled from a site paused for a restore can die with
 * the swapped-out database and their cursors are reused afterwards (root cause of S-C191-4). Pushed events are not
 * affected; the next replay after the restore picks up from the stored cursor.
 */
export async function openDatabaseRestore(projectId, now = new Date()) {
  return prisma.siteRestore.findFirst({
    where: { projectId, result: 'running', scope: { in: [...RESTORE_DB_SCOPES] }, startedAt: { gte: new Date(now.getTime() - RESTORE_OPEN_MAX_MS) } },
    orderBy: { startedAt: 'desc' },
    select: { restoreId: true, startedAt: true },
  });
}

/** The restore (if any) around a COUNTER_REGRESSION, for the log line (§41.4: it should not happen). */
export async function findRecentRestore(projectId, now = new Date()) {
  const since = new Date(now.getTime() - RESTORE_REGRESSION_LOOKBACK_MS);
  return prisma.siteRestore.findFirst({
    where: { projectId, OR: [{ startedAt: { gte: since } }, { completedAt: { gte: since } }, { rolledBackAt: { gte: since } }] },
    orderBy: { updatedAt: 'desc' },
    select: { restoreId: true, scope: true, result: true, countersRaised: true, completedAt: true, rolledBackAt: true },
  });
}

/**
 * Where an EmDash entry missing from a full inventory went (lib/emdashSync.js): the latest database restore or
 * rollback the site finished. An entry last seen before that moment is `orphaned_by_restore`, not `deleted`.
 */
export async function latestDatabaseSwap(projectId) {
  const rows = await prisma.siteRestore.findMany({
    where: { projectId, scope: { in: [...RESTORE_DB_SCOPES] }, OR: [{ completedAt: { not: null } }, { rolledBackAt: { not: null } }] },
    orderBy: { updatedAt: 'desc' },
    take: 5,
    select: { restoreId: true, completedAt: true, rolledBackAt: true },
  });
  let best = null;
  for (const r of rows) {
    for (const at of [r.completedAt, r.rolledBackAt]) {
      if (at && (!best || new Date(at) > best.at)) best = { restoreId: r.restoreId, at: new Date(at) };
    }
  }
  return best;
}

// ---------------------------------------------------------------- views

/** Staff shape of one restore (agency only: ids, source, roles, counts, schema, bridge, gap, orphans). */
export function staffRestoreView(r, { labels = new Map(), now = Date.now() } = {}) {
  const until = r.rollbackAvailableUntil ? new Date(r.rollbackAvailableUntil) : null;
  return {
    restoreId: r.restoreId,
    scope: r.scope,
    result: r.result,
    phase: r.phase,
    pointInTime: iso(r.pointInTime),
    startedAt: iso(r.startedAt),
    completedAt: iso(r.completedAt),
    failedAt: iso(r.failedAt),
    durationMs: r.durationMs ?? null,
    source: r.sourceOwner
      ? { owner: r.sourceOwner, type: r.sourceType, destinationId: r.sourceDestinationId, label: r.sourceDestinationId ? labels.get(r.sourceDestinationId) || null : null }
      : null,
    byRole: r.byRole,
    rollbackPoint: r.rollbackPoint,
    preExport: r.preExport,
    rollbackAvailableUntil: iso(until),
    rollbackOpen: !!until && until.getTime() > now && r.result === 'ok',
    rollbackId: r.rollbackId,
    rolledBackAt: iso(r.rolledBackAt),
    rolledBackByRole: r.rolledBackByRole,
    errorCode: r.errorCode,
    retryable: r.retryable,
    counts: r.counts ?? null,
    schema: r.schemaFrom || r.schemaTo ? { from: r.schemaFrom, to: r.schemaTo } : null,
    bridge: r.countersRaised !== null && r.countersRaised !== undefined ? { countersRaised: r.countersRaised, eventsLostAfter: iso(r.eventsLostAfter) } : null,
    dataGap: r.dataGapFrom && r.dataGapTo ? { from: iso(r.dataGapFrom), to: iso(r.dataGapTo) } : null,
    orphanedLeads: r.orphanedLeads || 0,
    origin: r.origin,
  };
}

/**
 * Client tile (allow-list, built field by field): "Site restored to <pointInTime>" for the latest finished restore of
 * the last 30 days. Never a restoreId, destination id/type, role, error code, counts or a cost.
 */
export function clientRestoreTile(rows, { now = Date.now() } = {}) {
  const cutoff = now - CLIENT_RESTORE_TILE_DAYS * 86400_000;
  const done = (rows || [])
    .filter((r) => r.result === 'ok' || r.result === 'rolled_back')
    .map((r) => ({ r, at: new Date(r.result === 'rolled_back' ? r.rolledBackAt || r.completedAt : r.completedAt || 0).getTime() }))
    .filter((x) => Number.isFinite(x.at) && x.at >= cutoff)
    .sort((a, b) => b.at - a.at);
  if (!done.length) return null;
  const { r, at } = done[0];
  return {
    state: r.result === 'rolled_back' ? 'undone' : 'restored',
    pointInTime: iso(r.pointInTime),
    at: new Date(at).toISOString(),
    // database scopes change the content; files scopes only images / files
    content: isDbScope(r.scope),
  };
}

export async function loadRestores(projectId, { take = 20 } = {}) {
  return prisma.siteRestore.findMany({ where: { projectId }, orderBy: [{ updatedAt: 'desc' }], take });
}
