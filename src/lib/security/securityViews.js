/**
 * Response shapes for the security platform (plan §5.5).
 *
 * CLIENT (O-4, decisions record): overall traffic light + a FIXED OS sentence, backup / scan tiles, and open items
 * built ONLY from clientSummary (client-visible checks) with the PM's OS-side note. Never a score, check id, evidence,
 * remediation, raw log, version, host, destination id/type, setting or acknowledgement. `clientSecurityView` is an
 * allow-list: it builds a new object field by field and never spreads a stored row.
 *
 * STAFF (OWNER, PM for their projects): fleet rows and the per-site drill-down with everything the OS stores.
 */
import { prisma } from '../prisma.js';
import { hasSecurity, hasBackups, hasSecurityConfig, backupOverdue } from './securitySync.js';
import { actorName, osUserNames } from './securityConfig.js';
import { ackMutes } from '../siteAdapters/security.js';

export const CLIENT_SENTENCES = Object.freeze({
  ok: 'Your site is protected and backed up.',
  warn_one: 'One item needs attention (the agency is on it).',
  warn_many: 'A few items need attention (the agency is on it).',
  fail: 'Action required. The agency is working on it.',
  unknown: 'We are still checking your site. The agency will update this soon.',
});

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const iso = (d) => (d ? new Date(d).toISOString() : null);

function latest(...vals) {
  const t = vals.filter(Boolean).map((v) => Date.parse(v)).filter(Number.isFinite);
  return t.length ? new Date(Math.max(...t)).toISOString() : null;
}
function oldest(...vals) {
  const t = vals.map((v) => (v ? Date.parse(v) : NaN));
  if (t.some((x) => !Number.isFinite(x))) return null; // one archive never succeeded: no "last full backup"
  return new Date(Math.min(...t)).toISOString();
}

/** Check ids the site does not run or score any more (security-status.disabled[], kept in step by the mirror). */
export function disabledSet(status) {
  return new Set(Array.isArray(status?.disabled) ? status.disabled.filter((x) => typeof x === 'string') : []);
}

/** Backup tile "ok": no last error and not overdue (the same rule as the server-side missed detection, O-R2-3). */
function archivesOk(dbArchive, filesArchive, now) {
  return !dbArchive?.lastError && !filesArchive?.lastError && !backupOverdue(dbArchive, now) && !backupOverdue(filesArchive, now);
}

/** Pure: stored rows → the client view. Exported for the "no non-client fields" tests. */
export function buildClientSecurityView({ status, checks }, { now = Date.now() } = {}) {
  const disabled = disabledSet(status);
  const items = (checks || [])
    .filter((c) => c.clientSummary && (c.state === 'fail' || c.state === 'warn') && !disabled.has(c.checkId))
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
    .slice(0, 50)
    .map((c) => ({
      text: String(c.clientSummary),
      state: c.state === 'fail' ? 'attention' : 'watch',
      since: iso(c.since),
      agencyNote: c.pmNote ? String(c.pmNote) : null,
      eta: iso(c.pmNoteEta),
    }));
  const overall = status?.overallState || 'unknown';
  let sentence = CLIENT_SENTENCES[overall] || CLIENT_SENTENCES.unknown;
  if (overall === 'warn') sentence = items.length > 1 ? CLIENT_SENTENCES.warn_many : CLIENT_SENTENCES.warn_one;
  const b = status?.backups && typeof status.backups === 'object' ? status.backups : null;
  const agency = b?.agency
    ? { lastOkAt: oldest(b.agency.db?.lastOkAt, b.agency.files?.lastOkAt) || latest(b.agency.db?.lastOkAt, b.agency.files?.lastOkAt), ok: archivesOk(b.agency.db, b.agency.files, now) }
    : null;
  const destinations = (b?.client || []).slice(0, 20).map((d) => ({
    label: d.label ? String(d.label) : 'Your backup destination',
    lastOkAt: oldest(d.db?.lastOkAt, d.files?.lastOkAt) || latest(d.db?.lastOkAt, d.files?.lastOkAt),
    ok: archivesOk(d.db, d.files, now),
  }));
  return {
    available: true,
    state: ['ok', 'warn', 'fail', 'unknown'].includes(overall) ? overall : 'unknown',
    sentence,
    tiles: {
      backup: b ? { agency, destinations } : null,
      lastScanAt: iso(status?.scansLastFullAt),
      uptime: null,
    },
    items,
    updatedAt: iso(status?.statusAt || status?.lastPullAt),
  };
}

export async function clientSecurityView(project) {
  if (!hasSecurity(project)) return { available: false };
  const [status, checks] = await Promise.all([
    prisma.securitySiteStatus.findUnique({ where: { projectId: project.id }, select: { overallState: true, backups: true, scansLastFullAt: true, statusAt: true, lastPullAt: true, disabled: true } }),
    prisma.securityCheckState.findMany({
      where: { projectId: project.id, state: { in: ['fail', 'warn'] }, clientSummary: { not: null } },
      select: { checkId: true, clientSummary: true, state: true, severity: true, since: true, pmNote: true, pmNoteEta: true },
    }),
  ]);
  return buildClientSecurityView({ status, checks });
}

function keyAgeDays(cred, now = Date.now()) {
  const t = cred?.rotatedAt || cred?.createdAt;
  return t ? Math.floor((now - new Date(t).getTime()) / 86400_000) : null;
}

function outboxState(health) {
  const o = health?.outbox;
  if (!o || typeof o !== 'object') return null;
  return {
    pending: Number.isInteger(o.pending) ? o.pending : null,
    failed: Number.isInteger(o.failed) ? o.failed : null,
    oldestPendingAt: o.oldestPendingAt || null,
    paused: !!o.paused,
  };
}

function lastBackupAt(backups) {
  if (!backups?.agency) return null;
  return latest(backups.agency.db?.lastOkAt, backups.agency.files?.lastOkAt);
}

/** Projects a staff user may see in the fleet: OWNER all; PM where they lead the project or the client. */
export async function fleetProjectWhere(user) {
  const base = { cmsType: 'EMDASH', cmsPairedAt: { not: null }, status: { not: 'ARCHIVED' } };
  if (user.role === 'OWNER') return base;
  const clients = await prisma.clientAccount.findMany({ where: { OR: [{ leadPmId: user.id }, { secondaryPmId: user.id }] }, select: { id: true } });
  return { ...base, OR: [{ leadPmId: user.id }, { clientId: { in: clients.map((c) => c.id) } }] };
}

export async function fleetView(user, { now = Date.now() } = {}) {
  const projects = await prisma.project.findMany({
    where: await fleetProjectWhere(user),
    select: {
      id: true,
      name: true,
      wpUrl: true,
      cmsCapabilities: true,
      cmsHealth: true,
      cmsPluginVersion: true,
      cmsType: true,
      client: { select: { id: true, agencyName: true } },
      cmsCredential: { select: { createdAt: true, rotatedAt: true } },
      securitySiteStatus: true,
    },
    orderBy: { name: 'asc' },
    take: 500,
  });
  const ids = projects.map((p) => p.id);
  // Per check (not groupBy) so disabled checks (not run, not scored) are left out of the counts (O-R2-4).
  const failing = ids.length
    ? await prisma.securityCheckState.findMany({ where: { projectId: { in: ids }, state: { in: ['fail', 'warn'] } }, select: { projectId: true, checkId: true, state: true }, take: 20000 })
    : [];
  const disabledByProject = new Map(projects.map((p) => [p.id, disabledSet(p.securitySiteStatus)]));
  const counts = new Map();
  for (const g of failing) {
    if (disabledByProject.get(g.projectId)?.has(g.checkId)) continue;
    const c = counts.get(g.projectId) || { fail: 0, warn: 0 };
    c[g.state] += 1;
    counts.set(g.projectId, c);
  }
  return projects
    .filter((p) => hasSecurity(p) || hasBackups(p))
    .map((p) => {
      const s = p.securitySiteStatus;
      const h = p.cmsHealth && typeof p.cmsHealth === 'object' ? p.cmsHealth : {};
      return {
        projectId: p.id,
        name: p.name,
        clientName: p.client?.agencyName || null,
        siteUrl: p.wpUrl || null,
        overall: s?.overallState || 'unknown',
        score: s?.score ?? null,
        failing: counts.get(p.id)?.fail || 0,
        warnings: counts.get(p.id)?.warn || 0,
        lastBackupAt: lastBackupAt(s?.backups),
        lastScanAt: iso(s?.scansLastFullAt),
        versions: {
          emdash: h.platform?.emdash ?? null,
          astro: h.platform?.astro ?? null,
          node: h.platform?.node ?? null,
          plugin: p.cmsPluginVersion ?? null,
          sentinel: s?.sentinelVersion ?? null,
        },
        contractRevision: h.contractRevision ?? null,
        keyAgeDays: keyAgeDays(p.cmsCredential, now),
        outbox: outboxState(h),
        lastPullAt: iso(s?.lastPullAt),
        lastPullError: s?.lastPullError ?? null,
        capabilities: { security: hasSecurity(p), backups: hasBackups(p), securityConfig: hasSecurityConfig(p) },
      };
    });
}

/** Per-site drill-down for staff (agency-only data: evidence, remediation, scores, notes, acknowledgements). */
export async function siteSecurityView(project, { days = 90 } = {}) {
  const since = new Date(Date.now() - Math.min(Math.max(days, 1), 400) * 86400_000).toISOString().slice(0, 10);
  const [status, checks, points, transitions, runs, incidents] = await Promise.all([
    prisma.securitySiteStatus.findUnique({ where: { projectId: project.id } }),
    prisma.securityCheckState.findMany({ where: { projectId: project.id }, orderBy: [{ checkId: 'asc' }] }),
    prisma.securityDailyPoint.findMany({ where: { projectId: project.id, date: { gte: since } }, orderBy: { date: 'asc' }, select: { date: true, overallState: true, score: true, counts: true, checks: true } }),
    prisma.securityTransition.findMany({ where: { projectId: project.id }, orderBy: { at: 'desc' }, take: 200 }),
    prisma.securityBackupRun.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, take: 60 }),
    prisma.securityIncident.findMany({ where: { projectId: project.id }, orderBy: { lastAt: 'desc' }, take: 50 }),
  ]);
  const noteAuthors = [...new Set(checks.map((c) => c.pmNoteById).filter(Boolean))];
  const users = noteAuthors.length ? await prisma.user.findMany({ where: { id: { in: noteAuthors } }, select: { id: true, name: true } }) : [];
  const names = new Map(users.map((u) => [u.id, u.name]));
  // "Acknowledged by <its user>" (§37.5, O-R2-2): the OS user behind the acknowledgement's actor.
  const ackNames = await osUserNames(checks.map((c) => c.acknowledged?.by));
  const disabled = disabledSet(status);
  const now = Date.now();
  const ackView = (c) => {
    const a = c.acknowledged && typeof c.acknowledged === 'object' ? c.acknowledged : null;
    if (!a) return null;
    return { ...a, active: ackMutes(a, c.state, now) && !disabled.has(c.checkId), byName: actorName(a.by, a.source, ackNames) };
  };
  // Counts from the stored checks without the disabled ones (the site's counts can predate a disable from the OS).
  // n/a checks (§38.9, a feature switched off) are counted apart (na), never as ok / warn / fail / unknown.
  const counts = checks.length ? { ok: 0, warn: 0, fail: 0, unknown: 0, disabled: 0, na: 0 } : status?.counts ?? null;
  if (checks.length) for (const c of checks) {
    if (disabled.has(c.checkId)) counts.disabled += 1;
    else if (c.state === 'n/a') counts.na += 1;
    else counts[c.state] = (counts[c.state] || 0) + 1;
  }
  if (checks.length && !counts.na) delete counts.na; // like the site's counts.na: present only when > 0
  return {
    available: hasSecurity(project) || hasBackups(project),
    capabilities: { security: hasSecurity(project), backups: hasBackups(project), securityConfig: hasSecurityConfig(project), logs: false },
    status: status
      ? {
          overall: status.overallState,
          score: status.score,
          counts,
          since: iso(status.overallSince),
          categories: status.categories,
          catalogueVersion: status.catalogueVersion,
          sentinelVersion: status.sentinelVersion,
          workerLastSeenAt: iso(status.workerLastSeenAt),
          lastFullScanAt: iso(status.scansLastFullAt),
          lastScan: status.lastScan,
          lastBuild: status.lastBuild,
          disabled: status.disabled,
          backups: status.backups,
          backupsReportedAt: iso(status.backupsReportedAt),
          lastRestoreTest: status.lastRestoreTest,
          statusAt: iso(status.statusAt),
          lastPullAt: iso(status.lastPullAt),
          lastPullError: status.lastPullError,
          retryAfterUntil: iso(status.retryAfterUntil),
        }
      : null,
    checks: checks.map((c) => ({
      id: c.checkId,
      category: c.category,
      severity: c.severity,
      state: c.state,
      reason: c.reason,
      source: c.source,
      frequency: c.frequency,
      checkedAt: iso(c.checkedAt),
      since: iso(c.since),
      summary: c.summary,
      clientSummary: c.clientSummary,
      clientVisible: !!c.clientSummary,
      remediation: c.remediation,
      evidence: c.evidence,
      evidenceAt: iso(c.evidenceAt),
      refs: c.refs,
      disabled: disabled.has(c.checkId),
      // §38.9: shown greyed out as "Not applicable (<reason>)" like disabled checks
      notApplicable: c.state === 'n/a',
      acknowledged: ackView(c),
      note: c.pmNote ? { text: c.pmNote, eta: iso(c.pmNoteEta), by: names.get(c.pmNoteById) || null, at: iso(c.pmNoteAt) } : null,
    })),
    trend: points.map((p) => ({ date: p.date, state: p.overallState, score: p.score, counts: p.counts, checks: p.checks })),
    changes: transitions.map((t) => ({ checkId: t.checkId, from: t.fromState, to: t.toState, at: iso(t.at), severity: t.severity, summary: t.summary, origin: t.origin })),
    backupRuns: runs.map((r) => ({
      runId: r.runId,
      kind: r.kind,
      owner: r.owner,
      destinationId: r.destinationId,
      destinationType: r.destinationType,
      destinationLabel: r.destinationLabel,
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.finishedAt),
      bytes: r.bytes == null ? null : Number(r.bytes),
      result: r.result,
      errorCode: r.errorCode,
      encrypted: r.encrypted,
      verified: r.verified,
      restoreTest: r.restoreTest,
      at: iso(r.finishedAt || r.startedAt || r.createdAt),
    })),
    incidents: incidents.map((i) => ({ incidentId: i.incidentId, phase: i.phase, severity: i.severity, summary: i.summary, openedAt: iso(i.openedAt), lastAt: iso(i.lastAt), by: i.by })),
  };
}
