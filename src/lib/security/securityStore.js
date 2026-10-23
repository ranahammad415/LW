/**
 * Security platform storage (contract v1.6.0 §36, plan §5.4). The site is the source of truth; the OS keeps:
 *   - every state transition per check (SecurityTransition, deduped on project+check+to+at),
 *   - the current state per check (SecurityCheckState) with the latest full evidence ONLY while the check is not ok,
 *   - one daily summary point per site (SecurityDailyPoint),
 *   - backup runs (SecurityBackupRun) and incidents (SecurityIncident, read-only).
 * Everything that reaches these functions has already been validated, bounded and redacted by
 * lib/siteAdapters/security.js. Alerts are raised from here (lib/security/securityAlerts.js) and are deduped there.
 */
import { prisma } from '../prisma.js';
import { J } from './jsonNull.js';
import { sanitizeSecurityEventData, sanitizeStatus, sanitizeHistory, sanitizeBackups, sanitizeRun, isoOrNull, ackEndedBy, SECURITY_NA } from '../siteAdapters/security.js';

const toDate = (v) => (v ? new Date(v) : null);
const utcDay = (d = new Date()) => new Date(d).toISOString().slice(0, 10);

function isUniqueViolation(err) {
  return err && (err.code === 'P2002' || /Unique constraint/i.test(String(err.message || '')));
}

/** Lazy import so the store stays testable without the notification stack. */
async function alerts() {
  return import('./securityAlerts.js');
}

/**
 * Record one transition (idempotent). Returns true when it is new (first time this project/check/to/at is seen).
 */
export async function recordTransition(projectId, t, origin) {
  if (!t?.checkId || !t.to || !t.at) return false;
  try {
    await prisma.securityTransition.create({
      data: {
        projectId,
        checkId: t.checkId,
        fromState: t.from ?? null,
        toState: t.to,
        at: new Date(t.at),
        severity: t.severity || 'low',
        summary: t.summary ?? null,
        clientSummary: t.clientSummary ?? null,
        origin,
      },
    });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/**
 * Apply one check change to the current-state row. Only moves forward in time: a change older than the stored
 * lastChangedAt never rolls the state back. Evidence: kept while not ok, cleared when the check is ok.
 */
export async function applyCheckChange(projectId, change, { category = null, evidence, remediation, keepEvidence = false, siteChanged = false } = {}) {
  const at = change.at ? new Date(change.at) : new Date();
  const existing = await prisma.securityCheckState.findUnique({ where: { projectId_checkId: { projectId, checkId: change.checkId } } });
  if (existing?.lastChangedAt && new Date(existing.lastChangedAt).getTime() > at.getTime()) return { applied: false, previous: existing.state };
  const nonOk = change.to !== 'ok';
  // §38.9: n/a = the feature is switched off. Nothing of the old state may survive (O-R3-2: a check that went n/a kept
  // "The agency backup is overdue", severity critical): summary = the site's n/a text, no evidence / fix / client text.
  const na = change.to === SECURITY_NA;
  // §37.5: any state change ends a site acknowledgement (a new problem needs a new one). `siteChanged`: the event
  // itself is a state change on the site (check_failed, a status_changed entry), also when the OS never saw the
  // state in between (fail → ok → fail merged away: stored fail, incoming fail). O-R2-1.
  const endsAck = !!existing?.acknowledged && (existing.state !== change.to || (siteChanged && ackEndedBy(existing.acknowledged, at.toISOString())));
  const data = {
    ...(existing && (existing.state !== change.to || endsAck) ? { acknowledged: null } : {}),
    severity: change.severity,
    state: change.to,
    since: existing && existing.state === change.to && existing.since ? existing.since : at,
    lastChangedAt: at,
    ...(change.summary != null ? { summary: change.summary } : {}),
    // clientSummary rides only on client-visible checks; a change without it keeps the stored text.
    ...(change.clientSummary != null ? { clientSummary: change.clientSummary } : {}),
    ...(remediation != null ? { remediation } : {}),
    ...(nonOk && evidence !== undefined ? { evidence, evidenceAt: at } : {}),
    ...(!nonOk && !keepEvidence ? { evidence: null, evidenceAt: null } : {}),
    ...(na
      ? { summary: change.summary ?? null, reason: change.reason || 'disabled', clientSummary: null, remediation: null, evidence: null, evidenceAt: null, acknowledged: null }
      : {}),
  };
  if (existing) {
    await prisma.securityCheckState.update({ where: { id: existing.id }, data: J(data) });
  } else {
    await prisma.securityCheckState.create({
      data: J({
        projectId,
        checkId: change.checkId,
        category: category || change.checkId.split('.')[0].slice(0, 32),
        firstSeenAt: at,
        ...data,
      }),
    });
  }
  if (endsAck) await endMirrorAck(projectId, change.checkId);
  return { applied: true, previous: existing?.state ?? null, ackEnded: endsAck };
}

/** The settings mirror's copy of an acknowledgement ends with it (display only; alerts read the check state). */
async function endMirrorAck(projectId, checkId) {
  try {
    const { endMirrorAcknowledgement } = await import('./securityConfig.js');
    await endMirrorAcknowledgement(projectId, checkId);
  } catch {
    // display only: the next security-config-get replaces the mirror anyway
  }
}

async function upsertSiteStatus(projectId, data) {
  await prisma.securitySiteStatus.upsert({ where: { projectId }, update: J(data), create: J({ projectId, ...data }) });
}

/**
 * security.* / backup.* event → storage + alerts. Returns the receipt outcome ('applied' | 'stored').
 * The event was validated by validateEvent (validateSecurityEvent); unknown types are stored as plain receipts.
 */
export async function applySecurityEvent(project, ev, { log } = {}) {
  // v1.6.1 config events (security.config_changed / security.acknowledged) are mirrored by securityConfig.js.
  if (ev.type === 'security.config_changed' || ev.type === 'security.acknowledged') {
    const { applySecurityConfigEvent } = await import('./securityConfig.js');
    return applySecurityConfigEvent(project, ev, { log });
  }
  const { data } = sanitizeSecurityEventData(ev.type, ev.data);
  if (!data) return 'stored';
  const projectId = project.id;
  const evAt = isoOrNull(ev.at) || new Date().toISOString();
  const raised = [];

  switch (ev.type) {
    case 'security.status_changed': {
      if (data.droppedChanges > 0) {
        log?.warn?.({ projectId, eventId: ev.id, sent: data.changes.length + data.droppedChanges, dropped: data.droppedChanges }, 'security.status_changed: changes dropped by the sanitizer');
      }
      for (const c of data.changes) {
        const t = { checkId: c.id, from: c.from, to: c.to, at: c.at || evAt, severity: c.severity, summary: c.summary, clientSummary: c.clientSummary, ...(c.reason ? { reason: c.reason } : {}) };
        const isNew = await recordTransition(projectId, t, 'event');
        await applyCheckChange(projectId, t, { siteChanged: true });
        if (isNew) raised.push(t);
      }
      const st = await prisma.securitySiteStatus.findUnique({ where: { projectId } });
      if (!st?.statusAt || new Date(st.statusAt).getTime() <= Date.parse(evAt)) {
        await upsertSiteStatus(projectId, {
          overallState: data.after.state,
          score: data.after.score,
          statusAt: new Date(evAt),
          ...(st?.overallState !== data.after.state ? { overallSince: new Date(evAt) } : {}),
        });
      }
      break;
    }
    case 'security.check_failed': {
      const prev = await prisma.securityCheckState.findUnique({ where: { projectId_checkId: { projectId, checkId: data.id } } });
      // O-R2-6: the event's own previous state when a site sends it; else the stored one (an ok the OS never saw
      // stays fail → fail, known-issues).
      const t = { checkId: data.id, from: data.from ?? prev?.state ?? null, to: 'fail', at: data.at || evAt, severity: data.severity, summary: data.summary, clientSummary: data.clientSummary };
      const isNew = await recordTransition(projectId, t, 'event');
      // A check_failed is a state change on the site: it ends an older acknowledgement before the alert decision.
      await applyCheckChange(projectId, t, { evidence: data.evidence, remediation: data.remediation, siteChanged: true });
      if (isNew) raised.push(t);
      break;
    }
    case 'security.scan_completed': {
      await upsertSiteStatus(projectId, {
        lastScan: { ...data, at: evAt },
        ...(data.catalogueVersion ? { catalogueVersion: data.catalogueVersion } : {}),
        ...(data.kind !== 'build' && !data.partial ? { scansLastFullAt: new Date(evAt) } : {}),
      });
      // v1.6.1 §37.4: a "Run now" from the OS ends its pending marker when the same scanId completes.
      if (data.source === 'os' || data.kind === 'manual') {
        const { completePendingScan } = await import('./securityConfig.js');
        await completePendingScan(projectId, data.scanId).catch(() => {});
      }
      break;
    }
    case 'security.incident': {
      const existing = await prisma.securityIncident.findUnique({ where: { projectId_incidentId: { projectId, incidentId: data.incidentId } } });
      if (existing && new Date(existing.lastAt).getTime() > Date.parse(evAt)) return 'stale';
      const row = { phase: data.phase, severity: data.severity, summary: data.summary, openedAt: toDate(data.openedAt), lastAt: new Date(evAt), by: data.by };
      if (existing) await prisma.securityIncident.update({ where: { id: existing.id }, data: J(row) });
      else await prisma.securityIncident.create({ data: J({ projectId, incidentId: data.incidentId, ...row }) });
      (await alerts()).alertIncident(project, data, { log }).catch((err) => log?.warn?.({ err: { message: err?.message } }, 'security incident alert failed'));
      return 'applied';
    }
    case 'backup.completed':
    case 'backup.failed': {
      const ok = ev.type === 'backup.completed';
      await upsertRun(projectId, {
        runId: data.runId,
        kind: data.kind,
        owner: data.owner,
        destinationId: streakId(data.owner, data.kind, data.destination.id),
        destinationType: data.destination.type,
        destinationLabel: data.destination.label,
        finishedAt: new Date(evAt),
        result: ok ? 'ok' : 'failed',
        errorCode: ok ? null : data.errorCode,
        ...(ok ? { bytes: data.bytes, sha256: data.sha256, encrypted: data.encrypted, verified: data.verified } : {}),
      }, 'event');
      if (!ok) (await alerts()).checkBackupFailures(project, { ...data.destination, id: streakId(data.owner, data.kind, data.destination.id), owner: data.owner }, { log }).catch((err) => log?.warn?.({ err: { message: err?.message } }, 'backup failure alert failed'));
      return 'applied';
    }
    case 'backup.verified': {
      const existing = await prisma.securityBackupRun.findUnique({ where: { projectId_runId: { projectId, runId: data.runId } } });
      if (existing) await prisma.securityBackupRun.update({ where: { id: existing.id }, data: { verified: data.restoreTest.result === 'ok', restoreTest: data.restoreTest } });
      else await upsertRun(projectId, { runId: data.runId, result: 'ok', verified: data.restoreTest.result === 'ok', restoreTest: data.restoreTest, finishedAt: new Date(evAt) }, 'event');
      await upsertSiteStatus(projectId, { lastRestoreTest: { at: data.restoreTest.at, result: data.restoreTest.result } });
      return 'applied';
    }
    case 'backup.restore_started':
    case 'backup.restore_completed':
    case 'backup.restore_failed':
    case 'backup.restore_rolled_back': {
      // v1.9.1 §41: keyed on restoreId, idempotent per restoreId and phase (lib/security/restoreStore.js).
      const { applyRestoreEvent } = await import('./restoreStore.js');
      return applyRestoreEvent(project, ev.type, data, ev, { log });
    }
    case 'backup.missed': {
      // A synthetic run row so the destination's failure streak counts it (and the admin backups tab shows it).
      await upsertRun(projectId, {
        runId: `missed:${data.destination.id}:${data.expectedAt}`.slice(0, 160),
        destinationId: data.destination.id,
        destinationType: data.destination.type,
        destinationLabel: data.destination.label,
        startedAt: new Date(data.expectedAt),
        result: 'missed',
      }, 'event');
      (await alerts()).checkBackupFailures(project, data.destination, { log }).catch((err) => log?.warn?.({ err: { message: err?.message } }, 'backup missed alert failed'));
      return 'applied';
    }
    default:
      return 'stored';
  }

  if (raised.length) {
    const a = await alerts();
    for (const t of raised) await a.alertForTransition(project, t, { log }).catch((err) => log?.warn?.({ err: { message: err?.message }, checkId: t.checkId }, 'security alert failed'));
  }
  return 'applied';
}

/**
 * The key a backup failure streak is counted on: each client destination on its own; the agency archives per kind
 * (agency-db / agency-files), whatever destination id the agency path reports (events vs. backup-status runs).
 */
export function streakId(owner, kind, destinationId) {
  if (owner === 'agency') return `agency-${kind || 'db'}`;
  return destinationId || null;
}

async function upsertRun(projectId, row, origin) {
  const data = { ...row, bytes: row.bytes == null ? undefined : BigInt(row.bytes), origin };
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  const existing = await prisma.securityBackupRun.findUnique({ where: { projectId_runId: { projectId, runId: row.runId } } });
  if (existing) {
    // A pulled run never downgrades a final result written by an event (and vice versa the newest final wins).
    if (existing.result !== 'running' && data.result === 'running') delete data.result;
    await prisma.securityBackupRun.update({ where: { id: existing.id }, data: J(data) });
    return { created: false, previous: existing };
  }
  try {
    await prisma.securityBackupRun.create({ data: J({ projectId, ...data }) });
    return { created: true };
  } catch (err) {
    if (isUniqueViolation(err)) return { created: false };
    throw err;
  }
}

/**
 * Store a security-status pull (detail full or summary). Detects transitions against the stored check states,
 * records them, refreshes the current state (evidence only for non-ok checks), the site status and today's point.
 * A stored check missing from a `full` status is not run there any more: it becomes unknown (never ok).
 * Returns the new transitions (for alerts).
 */
export async function recordStatusPull(projectId, rawStatus, { now = new Date(), log } = {}) {
  const status = sanitizeStatus(rawStatus);
  if (!status) return { ok: false, transitions: [] };
  if (status.droppedChecks > 0) {
    log?.warn?.({ projectId, sent: status.sentChecks, stored: status.checks.length, dropped: status.droppedChecks }, 'Security status: checks dropped by the sanitizer');
  }
  const stored = await prisma.securityCheckState.findMany({ where: { projectId } });
  const byId = new Map(stored.map((r) => [r.checkId, r]));
  const transitions = [];
  const seen = new Set();
  for (const c of status.checks) {
    seen.add(c.id);
    const prev = byId.get(c.id);
    const at = c.since || c.lastChangedAt || c.checkedAt || now.toISOString();
    const changed = !prev || prev.state !== c.state;
    if (changed) {
      const t = { checkId: c.id, from: prev?.state ?? null, to: c.state, at, severity: c.severity, summary: c.summary, clientSummary: c.clientSummary };
      if (await recordTransition(projectId, t, 'pull')) transitions.push(t);
    }
    // evidence only for checks that are in play (n/a = switched off, §38.9: nothing to show)
    const na = c.state === SECURITY_NA;
    const nonOk = c.state !== 'ok' && !na;
    const data = {
      category: c.category,
      severity: c.severity,
      state: c.state,
      reason: c.reason,
      source: c.source,
      frequency: c.frequency,
      checkedAt: toDate(c.checkedAt),
      since: toDate(c.since) || (changed ? new Date(at) : prev?.since ?? null),
      lastChangedAt: toDate(c.lastChangedAt) || (changed ? new Date(at) : prev?.lastChangedAt ?? null),
      summary: c.summary,
      // A full status is authoritative for client visibility: no clientSummary = not client-visible (any more).
      // n/a (§38.9): never client-visible, no fix text.
      clientSummary: na ? null : c.clientSummary,
      remediation: na ? null : c.remediation,
      refs: c.refs,
      // A transition stored by this pull that happened after the acknowledgement ends it (§37.5, O-R2-1), whatever
      // `active` the site computed when it answered.
      acknowledged: ackEndedBy(c.acknowledged, changed ? at : c.lastChangedAt || c.since) ? null : c.acknowledged,
      ...(status.detail === 'full'
        ? nonOk && c.evidence !== undefined
          ? { evidence: c.evidence, evidenceAt: now }
          : { evidence: null, evidenceAt: null }
        : nonOk ? {} : { evidence: null, evidenceAt: null }),
    };
    if (prev) await prisma.securityCheckState.update({ where: { id: prev.id }, data: J(data) });
    else await prisma.securityCheckState.create({ data: J({ projectId, checkId: c.id, firstSeenAt: toDate(c.firstSeenAt) || now, ...data }) });
  }
  if (status.detail === 'full') {
    for (const prev of stored) {
      if (seen.has(prev.checkId) || prev.state === 'unknown') continue;
      const t = { checkId: prev.checkId, from: prev.state, to: 'unknown', at: now.toISOString(), severity: prev.severity, summary: 'No longer reported by the site (not run there).', clientSummary: null };
      if (await recordTransition(projectId, t, 'pull')) transitions.push(t);
      // The old summary / fix text go too (O-R3-2: "The agency backup is overdue" stayed on a check the site no longer runs).
      await prisma.securityCheckState.update({ where: { id: prev.id }, data: J({ state: 'unknown', reason: 'not_run', since: now, lastChangedAt: now, summary: t.summary, remediation: null, evidence: null, evidenceAt: null, clientSummary: null, acknowledged: null }) });
    }
  }
  const st = await prisma.securitySiteStatus.findUnique({ where: { projectId } });
  await upsertSiteStatus(projectId, {
    overallState: status.overall.state,
    score: status.overall.score,
    counts: status.overall.counts,
    overallSince: toDate(status.overall.since),
    categories: status.categories,
    catalogueVersion: status.catalogueVersion,
    sentinelVersion: status.sentinel?.version ?? null,
    workerLastSeenAt: toDate(status.sentinel?.workerLastSeenAt),
    scansLastFullAt: toDate(status.scans.lastFullAt) ?? st?.scansLastFullAt ?? null,
    lastBuild: status.scans.lastBuild,
    disabled: status.disabled,
    statusAt: toDate(status.generatedAt) || now,
    ...(status.backups ? { backups: status.backups } : {}),
    lastPullAt: now,
    lastPullError: null,
  });
  await upsertDailyPoint(projectId, utcDay(now), { overallState: status.overall.state, score: status.overall.score, counts: status.overall.counts });
  await recordRestoreFromBackups(projectId, status.backups, { now, log });
  return { ok: true, transitions, status };
}

/**
 * v1.9.1 §41.2: `backups.restore` (backup-status and securityStatus.backups). Absent below 1.9.1: nothing happens.
 * A failure here never fails the pull (logged).
 */
async function recordRestoreFromBackups(projectId, backups, { now, log } = {}) {
  if (!backups?.restore) return null;
  try {
    const { recordRestoreState } = await import('./restoreStore.js');
    return await recordRestoreState(projectId, backups.restore, { now, log });
  } catch (err) {
    log?.warn?.({ err: { message: err?.message }, projectId }, 'Site restore state from the pull not stored');
    return null;
  }
}

export async function upsertDailyPoint(projectId, date, { overallState, score, counts = undefined, checks = undefined }) {
  const data = { overallState, score, ...(counts !== undefined ? { counts } : {}), ...(checks !== undefined ? { checks } : {}) };
  await prisma.securityDailyPoint.upsert({ where: { projectId_date: { projectId, date } }, update: J(data), create: J({ projectId, date, ...data }) });
}

/** security-history points → daily points (keeps a stored `counts`, adds the per-check states). */
export async function recordHistory(projectId, rawPoints) {
  const points = sanitizeHistory(rawPoints);
  for (const p of points) await upsertDailyPoint(projectId, p.date, { overallState: p.overallState, score: p.score, checks: p.checks });
  return points.length;
}

/**
 * backup-status → site status backups + runs. Returns failed runs that were new to the OS (for alerts).
 */
export async function recordBackupStatus(projectId, res, { now = new Date(), log } = {}) {
  const backups = sanitizeBackups(res?.backups);
  await upsertSiteStatus(projectId, {
    backups,
    backupsReportedAt: toDate(isoOrNull(res?.reportedAt)) || now,
    ...(backups?.lastRestoreTest ? { lastRestoreTest: backups.lastRestoreTest } : {}),
  });
  await recordRestoreFromBackups(projectId, backups, { now, log });
  const labels = new Map((backups?.client || []).map((d) => [d.destinationId, d]));
  const newFailures = [];
  const runs = (Array.isArray(res?.runs) ? res.runs : []).slice(0, 30).map(sanitizeRun).filter(Boolean);
  for (const r of runs) {
    const dest = r.destinationId ? labels.get(r.destinationId) : null;
    const out = await upsertRun(projectId, {
      runId: r.runId,
      kind: r.kind,
      owner: r.owner,
      destinationId: streakId(r.owner, r.kind, r.destinationId),
      destinationType: dest?.type ?? null,
      destinationLabel: dest?.label ?? null,
      startedAt: toDate(r.startedAt),
      finishedAt: toDate(r.finishedAt),
      bytes: r.bytes,
      sha256: r.sha256,
      result: r.result,
      errorCode: r.errorCode,
    }, 'pull');
    if (r.result === 'failed' && (out.created || out.previous?.result === 'running')) {
      newFailures.push({ id: streakId(r.owner, r.kind, r.destinationId), type: dest?.type ?? null, label: dest?.label ?? null, owner: r.owner });
    }
  }
  return { backups, newFailures };
}

/**
 * Retention (plan §5.4, admin setting securityRetentionDays, default 400): leader-only, batched deletes (≤ 5000 rows
 * per table per run). Monthly reports and incidents are kept indefinitely.
 */
export async function purgeSecurityHistory({ now = new Date(), days = null } = {}) {
  let keepDays = days;
  if (!keepDays) {
    const s = await prisma.agencySetting.findFirst({ select: { securityRetentionDays: true } }).catch(() => null);
    keepDays = Number.isInteger(s?.securityRetentionDays) && s.securityRetentionDays >= 30 ? s.securityRetentionDays : 400;
  }
  const cutoff = new Date(now.getTime() - keepDays * 86400_000);
  const cutoffDay = utcDay(cutoff);
  const out = {};
  const batch = async (model, where) => {
    const rows = await prisma[model].findMany({ where, select: { id: true }, take: 5000 });
    if (!rows.length) return 0;
    const r = await prisma[model].deleteMany({ where: { id: { in: rows.map((x) => x.id) } } });
    return r.count;
  };
  out.transitions = await batch('securityTransition', { at: { lt: cutoff } });
  out.dailyPoints = await batch('securityDailyPoint', { date: { lt: cutoffDay } });
  out.backupRuns = await batch('securityBackupRun', { createdAt: { lt: cutoff } });
  out.alertLogs = await batch('securityAlertLog', { sentAt: { lt: cutoff } });
  // Evidence of a check that has been non-ok for longer than the retention keeps only the latest snapshot anyway;
  // drop evidence older than the retention window.
  const ev = await prisma.securityCheckState.updateMany({ where: { evidenceAt: { lt: cutoff } }, data: J({ evidence: null, evidenceAt: null }) });
  out.evidence = ev.count;
  return out;
}
