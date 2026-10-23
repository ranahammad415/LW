/**
 * Security alert routing (plan §5.6), through the existing notify system (in-app + email) plus an optional Slack
 * webhook. Dedupe: one alert per key (check + state, destination + threshold, incident + phase) per 24 h, across PM2
 * instances (compare-and-set on SecurityAlertLog.sentAt). A check the site has acknowledged (v1.6.1 §37.5) does not
 * alert while the acknowledgement is active.
 *
 *   critical fail                         → agency on-call + every OWNER (immediate, Slack too)
 *   high fail                             → agency on-call (OWNERs when nobody is on call)
 *   medium/low fail, any warn             → daily digest (08:00 UTC, leader-only) to the project's PM
 *   backup failed/missed twice in a row   → project PM (in-app + email)
 *   ... 3 times for a client destination  → the client's users, slug security_backup_failed (their preferences apply)
 *   security.incident (any phase)         → OWNERs + project PM (Slack too)
 *
 * Site text in notifications is the agency summary (already redacted on ingest), HTML-escaped: templates render
 * variables into HTML. Evidence never leaves the OS UI.
 */
import { prisma } from '../prisma.js';
import { notify } from '../notificationService.js';
import { guardedFetch } from '../siteAdapters/netGuard.js';
import { ackMutes } from '../siteAdapters/security.js';

export const ALERT_DEDUPE_MS = 24 * 60 * 60 * 1000;
const BACKUP_PM_STREAK = 2;
const BACKUP_CLIENT_STREAK = 3;

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function isUniqueViolation(err) {
  return err && (err.code === 'P2002' || /Unique constraint/i.test(String(err.message || '')));
}

/**
 * Claim the right to send alert `key` for a project now. True at most once per window, also with several PM2
 * instances (an atomic updateMany on an old sentAt, or the unique create of the first row).
 */
export async function claimAlert(projectId, alertKey, { now = new Date(), windowMs = ALERT_DEDUPE_MS } = {}) {
  const key = String(alertKey).slice(0, 191);
  const res = await prisma.securityAlertLog.updateMany({
    where: { projectId, alertKey: key, sentAt: { lt: new Date(now.getTime() - windowMs) } },
    data: { sentAt: now, count: { increment: 1 } },
  });
  if (res.count > 0) return true;
  const existing = await prisma.securityAlertLog.findUnique({ where: { projectId_alertKey: { projectId, alertKey: key } } });
  if (existing) return false;
  try {
    await prisma.securityAlertLog.create({ data: { projectId, alertKey: key, sentAt: now } });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/** Human, active OWNERs (agent accounts never receive security alerts). */
export async function ownerIds() {
  const rows = await prisma.user.findMany({ where: { role: 'OWNER', isActive: true, isAgent: false }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Agency setting securityOnCallUserIds, limited to active human staff (OWNER / PM). */
export async function onCallUserIds() {
  const s = await prisma.agencySetting.findFirst({ select: { securityOnCallUserIds: true } }).catch(() => null);
  const ids = Array.isArray(s?.securityOnCallUserIds) ? s.securityOnCallUserIds.filter((x) => typeof x === 'string').slice(0, 20) : [];
  if (!ids.length) return [];
  const rows = await prisma.user.findMany({ where: { id: { in: ids }, isActive: true, isAgent: false, role: { in: ['OWNER', 'PM'] } }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** The project's PM: Project.leadPmId, else the client's lead / secondary PM. */
export async function projectPmIds(project) {
  const p = project?.leadPmId !== undefined && project?.clientId !== undefined
    ? project
    : await prisma.project.findUnique({ where: { id: project.id }, select: { id: true, leadPmId: true, clientId: true } });
  if (p?.leadPmId) return [p.leadPmId];
  if (!p?.clientId) return [];
  const c = await prisma.clientAccount.findUnique({ where: { id: p.clientId }, select: { leadPmId: true, secondaryPmId: true } });
  return [c?.leadPmId, c?.secondaryPmId].filter(Boolean);
}

async function projectName(project) {
  if (project?.name) return project.name;
  const p = await prisma.project.findUnique({ where: { id: project.id }, select: { name: true } });
  return p?.name || 'a project';
}

const securityUrl = (projectId) => `/portal/admin/projects/${projectId}?tab=security`;

/**
 * Optional Slack incoming webhook (SECURITY_SLACK_WEBHOOK_URL): https only, SSRF-guarded (guardedFetch refuses private
 * addresses at connect time and never follows redirects), 5 s timeout, never throws. Unset = no Slack.
 */
export async function sendSecuritySlack(text, { env = process.env, fetchImpl = guardedFetch, log } = {}) {
  const raw = String(env.SECURITY_SLACK_WEBHOOK_URL || '').trim();
  if (!raw) return { sent: false, reason: 'not_configured' };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { sent: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'https:' || url.username || url.password) return { sent: false, reason: 'https_only' };
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: String(text).slice(0, 3000) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      maxBytes: 64 * 1024,
    });
    if (res.status >= 300 && res.status < 400) return { sent: false, reason: 'redirect' };
    return { sent: res.ok, reason: res.ok ? null : `http_${res.status}` };
  } catch (err) {
    log?.warn?.({ code: err?.code || 'ERROR' }, 'Security Slack webhook failed');
    return { sent: false, reason: 'network' };
  }
}

/** Is the check acknowledged on the site for this state right now (§37.5)? */
async function acknowledged(projectId, checkId, state, now) {
  const row = await prisma.securityCheckState.findUnique({ where: { projectId_checkId: { projectId, checkId } }, select: { acknowledged: true } });
  return ackMutes(row?.acknowledged, state, now.getTime());
}

/**
 * Immediate routing for one new transition. Medium/low failures and warnings wait for the daily digest.
 * Returns what happened (for tests / logs).
 */
export async function alertForTransition(project, t, { now = new Date(), log, env = process.env } = {}) {
  // §38.9: a transition to or from n/a (a feature switched off / on) is never an alert.
  if (t.to === 'n/a' || t.from === 'n/a') return { routed: 'not_applicable' };
  if (t.to !== 'fail') return { routed: 'digest_or_none' };
  if (t.severity !== 'critical' && t.severity !== 'high') return { routed: 'digest' };
  if (await acknowledged(project.id, t.checkId, t.to, now)) return { routed: 'acknowledged' };
  if (!(await claimAlert(project.id, `check:${t.checkId}:${t.to}`, { now }))) return { routed: 'deduped' };
  const [oncall, owners] = await Promise.all([onCallUserIds(), ownerIds()]);
  const recipients = t.severity === 'critical' ? [...new Set([...oncall, ...owners])] : oncall.length ? oncall : owners;
  const name = await projectName(project);
  await notify({
    slug: 'security_alert',
    recipientIds: recipients,
    variables: {
      projectName: escapeHtml(name),
      title: escapeHtml(`${t.checkId} failed`),
      details: escapeHtml(t.summary || ''),
      severity: t.severity,
    },
    actionUrl: securityUrl(project.id),
    metadata: { projectId: project.id, checkId: t.checkId, kind: 'security' },
  });
  if (t.severity === 'critical') {
    await sendSecuritySlack(`:rotating_light: Critical security check failed on ${name}: ${t.checkId}. ${t.summary || ''}`, { env, log });
  }
  return { routed: t.severity, recipients };
}

/**
 * Backup failure streak per destination (newest first, failed / missed count; an ok run ends the streak).
 * Twice → the project PM; three times on a client destination → the client's users (security_backup_failed).
 */
export async function checkBackupFailures(project, destination, { now = new Date(), log } = {}) {
  const destId = destination?.id;
  if (!destId) return { streak: 0 };
  const runs = await prisma.securityBackupRun.findMany({
    where: { projectId: project.id, destinationId: destId, result: { in: ['ok', 'failed', 'missed'] } },
    orderBy: [{ createdAt: 'desc' }],
    take: 10,
    select: { result: true, owner: true, destinationLabel: true },
  });
  let streak = 0;
  for (const r of runs) {
    if (r.result === 'ok') break;
    streak += 1;
  }
  const owner = destination.owner || runs.find((r) => r.owner)?.owner || null;
  const label = destination.label || runs.find((r) => r.destinationLabel)?.destinationLabel || (owner === 'agency' ? 'the agency backup' : 'your backup destination');
  const name = await projectName(project);
  const out = { streak, pm: false, client: false };
  if (streak >= BACKUP_PM_STREAK && (await claimAlert(project.id, `backup:${destId}:pm`, { now }))) {
    await notify({
      slug: 'security_alert',
      recipientIds: await projectPmIds(project),
      variables: {
        projectName: escapeHtml(name),
        title: escapeHtml(`Backups to ${label} failed ${streak} times in a row`),
        details: escapeHtml(owner === 'client' ? 'This is a client-owned destination; the client is told after 3 failures.' : 'Check the backup job on the site.'),
        severity: 'high',
      },
      actionUrl: securityUrl(project.id),
      metadata: { projectId: project.id, kind: 'security_backup' },
    });
    out.pm = true;
  }
  if (streak >= BACKUP_CLIENT_STREAK && owner === 'client' && (await claimAlert(project.id, `backup:${destId}:client`, { now }))) {
    const p = await prisma.project.findUnique({ where: { id: project.id }, select: { clientId: true } });
    const users = p?.clientId
      ? await prisma.clientUser.findMany({ where: { clientId: p.clientId }, select: { userId: true } })
      : [];
    await notify({
      slug: 'security_backup_failed',
      recipientIds: users.map((u) => u.userId),
      variables: { projectName: escapeHtml(name), destination: escapeHtml(label), failures: String(streak) },
      actionUrl: `/portal/client/projects/${project.id}?tab=security`,
      metadata: { projectId: project.id, kind: 'security_backup' },
    });
    out.client = true;
  }
  log?.info?.({ projectId: project.id, streak, pm: out.pm, client: out.client }, 'Backup failure streak checked');
  return out;
}

/** security.incident (any phase): OWNERs + the project PM, Slack too. */
export async function alertIncident(project, data, { now = new Date(), log, env = process.env } = {}) {
  if (!(await claimAlert(project.id, `incident:${data.incidentId}:${data.phase}`, { now }))) return { routed: 'deduped' };
  const recipients = [...new Set([...(await ownerIds()), ...(await projectPmIds(project))])];
  const name = await projectName(project);
  await notify({
    slug: 'security_alert',
    recipientIds: recipients,
    variables: {
      projectName: escapeHtml(name),
      title: escapeHtml(`Security incident ${data.phase}`),
      details: escapeHtml(data.summary || ''),
      severity: data.severity,
    },
    actionUrl: securityUrl(project.id),
    metadata: { projectId: project.id, kind: 'security_incident' },
  });
  await sendSecuritySlack(`Security incident on ${name} (${data.severity}, ${data.phase}): ${data.summary || ''}`, { env, log });
  return { routed: 'incident', recipients };
}

// ---------------------------------------------------------------- v1.9.1 §41: site restores (alerting matrix §5.6)

/** Severity per restore phase (restore architecture §7.3). */
export const RESTORE_ALERT_SEVERITY = Object.freeze({ started: 'info', completed: 'info', failed: 'critical', rolled_back: 'high' });
/** One alert per restore and phase, ever (a re-sent restore_started never alerts twice). */
export const RESTORE_ALERT_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const SCOPE_WORDS = Object.freeze({ db: 'database', files: 'all files', 'files-subset': 'selected files', full: 'database and files' });

const utcStamp = (d) => (d ? `${new Date(d).toISOString().replace('T', ' ').slice(0, 16)} UTC` : 'an unknown time');
function minutesText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** Title / details of a restore alert (pure; OS wording, no site text, no ids beyond the scope words). */
export function restoreAlertText(phase, row) {
  const scope = SCOPE_WORDS[row.scope] || 'site';
  const point = utcStamp(row.pointInTime);
  const by = row.byRole ? `the site ${row.byRole}` : 'a site administrator';
  switch (phase) {
    case 'started':
      return {
        title: `Site restore started (${scope}, backup of ${point})`,
        details: `Started by ${by} at ${utcStamp(row.startedAt)}. ${
          row.noOutcomeYet ? 'No completion or failure has been reported yet; check the site admin. ' : ''
        }${
          row.scope === 'db' || row.scope === 'full'
            ? 'The public site may answer 503 for 1 to 3 minutes while it restarts; uptime alerts are held for this window. '
            : ''
        }Agency OS never starts or stops a restore: it is done in the site admin, Backups, Restore.`,
      };
    case 'completed': {
      const took = minutesText(row.durationMs);
      return {
        title: `Site restored to ${point} (${scope})`,
        details: `${took ? `Took ${took}. ` : ''}${row.rollbackAvailableUntil ? `Roll back is possible in the site admin until ${utcStamp(row.rollbackAvailableUntil)}. ` : ''}${row.dataGapFrom ? 'Site data between the backup and the restore is not comparable (data gap).' : ''}`.trim(),
      };
    }
    case 'failed':
      return {
        title: `Site restore FAILED (${scope}, phase ${row.phase || 'unknown'}, ${row.errorCode || 'INTERNAL'})`,
        details: `${row.retryable ? 'The site says it can be retried.' : 'The site says it cannot simply be retried.'} Check the site admin, Backups, Restore; Agency OS does not retry or roll back.`,
      };
    case 'rolled_back':
      return {
        title: 'Site restore rolled back',
        details: `${row.rolledBackByRole ? `Rolled back by the site ${row.rolledBackByRole}` : 'Rolled back'} at ${utcStamp(row.rolledBackAt)}; the site is back to its state before the restore.`,
      };
    default:
      return { title: 'Site restore', details: '' };
  }
}

/**
 * One alert per restore phase through the security path (`security_alert`, in-app + e-mail): started / completed →
 * info to on-call (OWNERs when nobody is on call); failed → critical to on-call + every OWNER (Slack too);
 * rolled_back → high to on-call (OWNERs when nobody is on call).
 */
export async function alertRestore(project, phase, row, { now = new Date(), log, env = process.env } = {}) {
  const severity = RESTORE_ALERT_SEVERITY[phase];
  if (!severity || !row?.restoreId) return { routed: 'none' };
  if (!(await claimAlert(project.id, `restore:${row.restoreId}:${phase}`.slice(0, 191), { now, windowMs: RESTORE_ALERT_WINDOW_MS }))) return { routed: 'deduped' };
  const [oncall, owners] = await Promise.all([onCallUserIds(), ownerIds()]);
  const recipients = severity === 'critical' ? [...new Set([...oncall, ...owners])] : oncall.length ? oncall : owners;
  const name = await projectName(project);
  const { title, details } = restoreAlertText(phase, row);
  await notify({
    slug: 'security_alert',
    recipientIds: recipients,
    variables: { projectName: escapeHtml(name), title: escapeHtml(title), details: escapeHtml(details), severity },
    actionUrl: securityUrl(project.id),
    metadata: { projectId: project.id, kind: 'site_restore', phase },
  });
  if (severity === 'critical') await sendSecuritySlack(`:rotating_light: ${title} on ${name}.`, { env, log });
  log?.info?.({ projectId: project.id, phase, severity, recipients: recipients.length }, 'Site restore alert sent');
  return { routed: severity, recipients };
}

/**
 * Daily digest (leader-only cron, 08:00 UTC): per project, the medium/low failures and every warning that started in
 * the last 24 h and are still in that state, minus acknowledged ones, to the project's PM. One digest per project per
 * UTC day (claim key digest:<date>).
 */
export async function runSecurityDigest({ now = new Date(), log } = {}) {
  const since = new Date(now.getTime() - ALERT_DEDUPE_MS);
  const rows = await prisma.securityTransition.findMany({
    where: { at: { gte: since }, OR: [{ toState: 'warn' }, { toState: 'fail', severity: { in: ['medium', 'low'] } }] },
    orderBy: { at: 'asc' },
    take: 2000,
    select: { projectId: true, checkId: true, toState: true, severity: true, summary: true },
  });
  const byProject = new Map();
  for (const r of rows) {
    if (!byProject.has(r.projectId)) byProject.set(r.projectId, new Map());
    byProject.get(r.projectId).set(r.checkId, r);
  }
  const day = now.toISOString().slice(0, 10);
  let sent = 0;
  for (const [projectId, checks] of byProject) {
    const current = await prisma.securityCheckState.findMany({ where: { projectId, checkId: { in: [...checks.keys()] } }, select: { checkId: true, state: true, acknowledged: true } });
    const live = new Map(current.map((c) => [c.checkId, c]));
    const items = [...checks.values()].filter((r) => {
      const c = live.get(r.checkId);
      return c && c.state === r.toState && !ackMutes(c.acknowledged, c.state, now.getTime());
    });
    if (!items.length) continue;
    if (!(await claimAlert(projectId, `digest:${day}`, { now, windowMs: 20 * 60 * 60 * 1000 }))) continue;
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, leadPmId: true, clientId: true, status: true } });
    if (!project || project.status === 'ARCHIVED') continue;
    const list = items.slice(0, 30).map((r) => `${r.checkId} (${r.severity} ${r.toState}): ${r.summary || ''}`);
    await notify({
      slug: 'security_digest',
      recipientIds: await projectPmIds(project),
      variables: { projectName: escapeHtml(project.name), count: String(items.length), items: list.map(escapeHtml).join('<br>') },
      actionUrl: securityUrl(project.id),
      metadata: { projectId: project.id, kind: 'security_digest' },
    });
    sent += 1;
  }
  if (sent) log?.info?.({ sent }, 'Security digest sent');
  return { projects: byProject.size, sent };
}
