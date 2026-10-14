/**
 * Interview scheduler tick (plan §10, §20, §23). Registered in src/index.js as
 * a 5-minute node-cron job, guarded by INTERVIEW_SCHEDULER_ENABLED.
 *
 * PM2 cluster safety, two layers:
 *  1. Cheap leader: only the instance with NODE_APP_INSTANCE '0' (or unset in
 *     dev/single-process) runs the tick.
 *  2. Row-level compare-and-set claims (updateMany with the expected state,
 *     proceed only when count === 1), so even two concurrent ticks send each
 *     email, reminder and summary exactly once.
 *
 * Every step is wrapped in try/catch, bounded, and logged.
 */
import os from 'os';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import {
  dispatchInvite,
  logDispatch,
  currentToken,
  inviteUrl,
  staffRecipientIds,
  TERMINAL_STATUSES,
} from './interviewInvites.js';
import { cancelDelegation } from './interviewDelegation.js';
import { consolidateSession } from './interviewConsolidation.js';
import { buildSummaryEmail, agencyDisplayName } from './interviewEmail.js';
import { listInviteCaptures } from './interviewCapture.js';
import { openQuestions } from './interviewAgenda.js';
import { sendEmail } from './mailer.js';
import { notificationEmailsPaused } from './notificationEmailPause.js';
import { resolveInterviewSettings } from './interviewSettings.js';
import { MAX_SESSION_SECONDS } from './realtimeVoice.js';
import { billedSeconds } from './interviewSession.js';

const LOCK_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const VOICE_STALE_HEARTBEAT_MS = 10 * 60 * 1000;
const SESSION_MAX_AGE_MS = 60 * 60 * 1000;
const UNCONFIRMED_TTL_MS = 24 * 60 * 60 * 1000;
/** A RUNNING consolidation or PENDING summary older than this is retried (review fix M1). */
export const LEASE_TTL_MS = 15 * 60 * 1000;

export const EXPIRABLE_STATUSES = ['PENDING', 'SENT', 'SEND_FAILED', 'OPENED', 'IN_PROGRESS', 'PENDING_CONFIRM'];

export function instanceId() {
  return `${os.hostname()}:${process.env.NODE_APP_INSTANCE ?? 'x'}:${process.pid}`.slice(0, 100);
}

/** PM2 cluster leader: instance 0, or a single process with no PM2 id. */
export function isLeader(env = process.env) {
  return env.NODE_APP_INSTANCE === undefined || env.NODE_APP_INSTANCE === '' || env.NODE_APP_INSTANCE === '0';
}

export function isSchedulerEnabled(env = process.env) {
  return String(env.INTERVIEW_SCHEDULER_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function lockFree(now) {
  return { OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - LOCK_TTL_MS) } }] };
}

/** CAS-claims an invite row. Returns true only for the single winner. */
export async function claimInvite(id, expected, now, instance) {
  const res = await prisma.knowledgeInterviewInvite.updateMany({
    where: { id, ...expected, ...lockFree(now) },
    data: { lockedAt: now, lockedBy: instance },
  });
  return res.count === 1;
}

async function releaseInvite(id) {
  await prisma.knowledgeInterviewInvite.update({ where: { id }, data: { lockedAt: null, lockedBy: null } }).catch(() => {});
}

/** Which reminder (0-based) is due, or -1 (pure, exported for tests). */
export function dueReminderIndex(invite, now = new Date()) {
  const days = Array.isArray(invite.reminderDays) ? invite.reminderDays : [];
  const n = invite.reminderCount || 0;
  if (!invite.sentAt || n >= days.length) return -1;
  if (new Date(invite.expiresAt).getTime() <= now.getTime() + DAY_MS) return -1;
  const due = new Date(invite.sentAt).getTime() + Number(days[n]) * DAY_MS;
  return due <= now.getTime() ? n : -1;
}

/** Seconds to bill for a session that never reported completion (pure). */
export function reapBilledSeconds(session, now = new Date()) {
  // Same rules as interviewSession.billedSeconds (review fix H1): heartbeat
  // span + grace, or full wall-clock time when no heartbeat ever arrived.
  return billedSeconds(session, { now, reaped: true });
}

/** Whether a public session should be reaped now (pure). */
export function isSessionStale(session, now = new Date()) {
  const started = new Date(session.startedAt).getTime();
  const hb = session.lastHeartbeatAt ? new Date(session.lastHeartbeatAt).getTime() : null;
  if (session.mode === 'VOICE') {
    if (hb !== null) return now.getTime() - hb > VOICE_STALE_HEARTBEAT_MS;
    // Never heartbeated: give it the full session length plus 5 minutes.
    return now.getTime() - started > (MAX_SESSION_SECONDS + 300) * 1000;
  }
  const last = hb !== null ? hb : started;
  return now.getTime() - last > SESSION_MAX_AGE_MS;
}

// ── Steps ────────────────────────────────────────────────────────────────────

export async function sendScheduledInvites({ now, instance }) {
  const due = await prisma.knowledgeInterviewInvite.findMany({
    where: { status: 'SCHEDULED', scheduledSendAt: { lte: now } },
    orderBy: { scheduledSendAt: 'asc' },
    take: 50,
  });
  if (due.length && notificationEmailsPaused()) return { sent: 0, failed: 0, paused: due.length };
  let sent = 0;
  let failed = 0;
  for (const inv of due) {
    if (!(await claimInvite(inv.id, { status: 'SCHEDULED' }, now, instance))) continue;
    try {
      const fresh = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: inv.id } });
      if (fresh.status !== 'SCHEDULED') continue;
      const res = await dispatchInvite(fresh, { kind: 'SEND', instance });
      if (res.ok) sent++;
      else failed++;
    } finally {
      await releaseInvite(inv.id);
    }
  }
  // Landing-page delegations created while emails were paused stay PENDING
  // without a link; send them now (review LOW fix).
  const stuckChildren = await prisma.knowledgeInterviewInvite.findMany({
    where: { status: 'PENDING', respondentRole: 'STAFF', tokenNonce: null, sentToEmail: { not: null }, expiresAt: { gt: now } },
    take: 20,
  });
  for (const child of stuckChildren) {
    if (!(await claimInvite(child.id, { status: 'PENDING', tokenNonce: null }, now, instance))) continue;
    try {
      const res = await dispatchInvite(child, { kind: 'SEND', instance });
      if (res.ok) sent++;
      else failed++;
    } finally {
      await releaseInvite(child.id);
    }
  }
  return { sent, failed };
}

export async function sendReminders({ now, instance }) {
  // Don't consume reminderCount while emails are paused (review LOW fix).
  if (notificationEmailsPaused()) return { sent: 0, paused: true };
  const candidates = await prisma.knowledgeInterviewInvite.findMany({
    where: {
      status: { in: ['SENT', 'OPENED'] },
      sentAt: { not: null },
      tokenNonce: { not: null },
      sentToEmail: { not: null },
      expiresAt: { gt: new Date(now.getTime() + DAY_MS) },
    },
    take: 200,
  });
  let sent = 0;
  for (const inv of candidates) {
    const n = dueReminderIndex(inv, now);
    if (n < 0) continue;
    // CAS on reminderCount: exactly one instance sends reminder n.
    const claimed = await prisma.knowledgeInterviewInvite.updateMany({
      where: { id: inv.id, reminderCount: n, status: { in: ['SENT', 'OPENED'] } },
      data: { reminderCount: n + 1, lastReminderAt: now },
    });
    if (claimed.count !== 1) continue;
    // Re-read after the claim: a concurrent resend may have rotated the link.
    const fresh = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: inv.id } });
    if (!fresh || !['SENT', 'OPENED'].includes(fresh.status) || !fresh.tokenNonce) continue;
    const res = await dispatchInvite(fresh, { kind: 'REMINDER', instance });
    if (res.ok) sent++;
  }
  return { sent };
}

export async function expireInvites({ now, instance }) {
  const rows = await prisma.knowledgeInterviewInvite.findMany({
    where: { status: { in: EXPIRABLE_STATUSES }, expiresAt: { lt: now } },
    select: { id: true, status: true },
    take: 200,
  });
  if (!rows.length) return { expired: 0 };
  const res = await prisma.knowledgeInterviewInvite.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, status: { in: EXPIRABLE_STATUSES } },
    data: { status: 'EXPIRED', statusReason: 'expired' },
  });
  for (const r of rows) await logDispatch({ inviteId: r.id, kind: 'EXPIRE', detail: `from ${r.status}`, instance });
  return { expired: res.count };
}

export async function reapStaleSessions({ now, instance }) {
  const sessions = await prisma.voiceInterviewSession.findMany({
    where: {
      status: 'ACTIVE',
      // Only public interview-link sessions. Portal sessions (no invite) keep
      // their old behaviour, so sessions stuck ACTIVE before this feature are
      // never suddenly billed at the full maximum (review LOW fix).
      inviteId: { not: null },
    },
    take: 200,
  });
  let reaped = 0;
  for (const s of sessions) {
    if (!isSessionStale(s, now)) continue;

    const billed = reapBilledSeconds(s, now);
    const hasDrafts = s.inviteId ? (await prisma.okfDraftChange.count({ where: { sessionId: s.id } })) > 0 : false;
    const claimed = await prisma.voiceInterviewSession.updateMany({
      where: { id: s.id, status: 'ACTIVE' },
      data: {
        status: 'ABANDONED',
        endedAt: now,
        durationSeconds: billed,
        ...(hasDrafts ? { consolidationStatus: 'PENDING' } : {}),
      },
    });
    if (claimed.count !== 1) continue;
    reaped++;
    if (s.inviteId) {
      if (billed > 0) {
        await prisma.knowledgeInterviewInvite.update({
          where: { id: s.inviteId },
          data: { totalVoiceSeconds: { increment: billed } },
        }).catch(() => {});
      }
      await logDispatch({ inviteId: s.inviteId, kind: 'REAP', detail: `session ${s.id} billed ${billed}s`, instance });
    }
  }
  return { reaped };
}

export async function runConsolidation({ now, instance, log }) {
  // Recover sessions left RUNNING by a crash/restart: consolidatedAt doubles
  // as the claim time while RUNNING (review fix M1).
  await prisma.voiceInterviewSession.updateMany({
    where: { consolidationStatus: 'RUNNING', OR: [{ consolidatedAt: null }, { consolidatedAt: { lt: new Date(now.getTime() - LEASE_TTL_MS) } }] },
    data: { consolidationStatus: 'PENDING' },
  });
  const pending = await prisma.voiceInterviewSession.findMany({
    where: { consolidationStatus: 'PENDING' },
    orderBy: { startedAt: 'asc' },
    take: 3,
    select: { id: true, inviteId: true, clientId: true },
  });
  let done = 0;
  for (const s of pending) {
    const claimed = await prisma.voiceInterviewSession.updateMany({
      where: { id: s.id, consolidationStatus: 'PENDING' },
      data: { consolidationStatus: 'RUNNING', consolidatedAt: now },
    });
    if (claimed.count !== 1) continue;
    try {
      const result = await consolidateSession(s.id, { now });
      await prisma.voiceInterviewSession.update({
        where: { id: s.id },
        data: { consolidationStatus: 'DONE', consolidatedAt: new Date() },
      });
      done++;
      if (result.processed > 0) await notifyDraftsReady(s, result).catch(() => {});
    } catch (err) {
      log?.error?.({ err, sessionId: s.id }, 'Interview consolidation failed');
      await prisma.voiceInterviewSession.update({
        where: { id: s.id },
        data: { consolidationStatus: 'FAILED', consolidatedAt: new Date() },
      }).catch(() => {});
      if (s.inviteId) await logDispatch({ inviteId: s.inviteId, kind: 'CONSOLIDATE', ok: false, detail: err?.message, instance });
    }
  }
  return { consolidated: done };
}

async function notifyDraftsReady(session, result) {
  const { notify } = await import('./notificationService.js');
  const client = await prisma.clientAccount.findUnique({ where: { id: session.clientId }, select: { agencyName: true } });
  await notify({
    slug: 'interview_drafts_ready',
    recipientIds: await staffRecipientIds(session.clientId),
    variables: {
      clientName: client?.agencyName || 'a client',
      draftCount: String(result.processed),
      highCount: String(result.byRisk.HIGH || 0),
      mediumCount: String(result.byRisk.MEDIUM || 0),
      lowCount: String(result.byRisk.LOW || 0),
    },
    actionUrl: session.inviteId ? `/portal/pm/okf-review?inviteId=${session.inviteId}` : '/portal/pm/okf-review',
    metadata: { sessionId: session.id, inviteId: session.inviteId },
  });
}

/** PENDING_CONFIRM older than 24 h → REVOKED 'unconfirmed' (plan §19, §23). */
export async function cancelUnconfirmedDelegations({ now }) {
  const stale = await prisma.knowledgeInterviewInvite.findMany({
    where: { status: 'PENDING_CONFIRM', createdAt: { lt: new Date(now.getTime() - UNCONFIRMED_TTL_MS) } },
    take: 50,
  });
  let cancelled = 0;
  for (const child of stale) {
    const root = child.parentInviteId
      ? await prisma.knowledgeInterviewInvite.findUnique({ where: { id: child.parentInviteId } })
      : null;
    if (!root) continue;
    await cancelDelegation({ root, childId: child.id, reason: 'unconfirmed' });
    cancelled++;
  }
  return { cancelled };
}

/** Whether every invite and session in a root's tree has settled (pure). */
export function treeIsSettled({ root, children, sessions }) {
  if (!['COMPLETED', 'EXPIRED'].includes(root.status)) return false;
  if (children.some((c) => !TERMINAL_STATUSES.includes(c.status))) return false;
  if (sessions.some((s) => s.status === 'ACTIVE' || ['PENDING', 'RUNNING'].includes(s.consolidationStatus))) return false;
  return true;
}

/**
 * Sends exactly one summary per finished root (plan §20). CAS on
 * summaryStatus NONE → PENDING makes it once-only across instances.
 */
export async function finalizeRootInvites({ now, instance, log }) {
  // A summary claimed by an instance that then crashed is retried (review fix M1).
  await prisma.knowledgeInterviewInvite.updateMany({
    where: { summaryStatus: 'PENDING', OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - LEASE_TTL_MS) } }] },
    data: { summaryStatus: 'NONE', lockedAt: null, lockedBy: null },
  });
  // Least-recently-checked first, and unsettled roots are "touched" below, so
  // 20 roots waiting on colleagues can never starve the rest (review fix M1).
  const roots = await prisma.knowledgeInterviewInvite.findMany({
    where: {
      status: { in: ['COMPLETED', 'EXPIRED'] },
      summaryStatus: 'NONE',
      delegationDepth: 0,
      // Only new-flow invites: legacy rows have no derivable link to send.
      tokenNonce: { not: null },
    },
    orderBy: { updatedAt: 'asc' },
    take: 20,
  });
  let sent = 0;
  for (const root of roots) {
    const tree = await prisma.knowledgeInterviewInvite.findMany({
      where: { rootInviteId: root.id },
      select: { id: true, status: true, recipientName: true, respondentJobRole: true, parentInviteId: true },
    });
    const children = tree.filter((c) => c.id !== root.id);
    const sessions = await prisma.voiceInterviewSession.findMany({
      where: { inviteId: { in: tree.map((t) => t.id).concat(root.id) } },
      select: { id: true, status: true, consolidationStatus: true },
    });
    if (!treeIsSettled({ root, children, sessions })) {
      // Bumps updatedAt so the next tick looks at other roots first.
      await prisma.knowledgeInterviewInvite.update({ where: { id: root.id }, data: { statusReason: root.statusReason ?? null } }).catch(() => {});
      continue;
    }

    const claimed = await prisma.knowledgeInterviewInvite.updateMany({
      where: { id: root.id, summaryStatus: 'NONE' },
      data: { summaryStatus: 'PENDING', lockedAt: now, lockedBy: instance },
    });
    if (claimed.count !== 1) continue;

    try {
      const captures = await listInviteCaptures(tree.map((t) => t.id).concat(root.id));
      const capturesWithMeta = await prisma.okfDraftChange.findMany({
        where: { id: { in: captures.map((c) => c.id) } },
        select: { id: true, title: true, folder: true, proposedBody: true, respondentName: true, respondentRole: true, changeKind: true, status: true, proposedMetadata: true },
      });
      const token = currentToken(root);
      const shouldSend = Boolean(root.sentToEmail && token && (capturesWithMeta.length > 0 || sessions.length > 0));
      if (!shouldSend) {
        await prisma.knowledgeInterviewInvite.update({
          where: { id: root.id },
          data: { summaryStatus: 'SKIPPED', rootCompletedAt: now, lockedAt: null, lockedBy: null },
        });
        await logDispatch({ inviteId: root.id, kind: 'SUMMARY', detail: 'skipped (nothing captured or no email)', instance });
        continue;
      }
      if (notificationEmailsPaused()) {
        // Leave it for a later tick once emails are un-paused.
        await prisma.knowledgeInterviewInvite.update({
          where: { id: root.id },
          data: { summaryStatus: 'NONE', lockedAt: null, lockedBy: null },
        });
        continue;
      }
      const client = await prisma.clientAccount.findUnique({ where: { id: root.clientId }, select: { agencyName: true } });
      const agencyName = await agencyDisplayName();
      const email = await buildSummaryEmail({
        root,
        businessName: client?.agencyName || 'your business',
        agencyName,
        url: inviteUrl(token),
        captures: capturesWithMeta,
        children,
        openQuestions: openQuestions(root.agenda),
      });
      const result = await sendEmail({ to: root.sentToEmail, subject: email.subject, html: email.html, text: email.text, fromName: agencyName });
      await prisma.knowledgeInterviewInvite.update({
        where: { id: root.id },
        data: result.success
          ? { summaryStatus: 'SENT', summarySentAt: now, rootCompletedAt: now, lockedAt: null, lockedBy: null }
          : { summaryStatus: 'FAILED', rootCompletedAt: now, sendError: String(result.error || '').slice(0, 500), lockedAt: null, lockedBy: null },
      });
      await logDispatch({ inviteId: root.id, kind: 'SUMMARY', ok: result.success, detail: result.success ? `${capturesWithMeta.length} captures` : result.error, instance });
      if (result.success) sent++;
    } catch (err) {
      log?.error?.({ err, inviteId: root.id }, 'Interview summary failed');
      await prisma.knowledgeInterviewInvite.update({
        where: { id: root.id },
        data: { summaryStatus: 'FAILED', lockedAt: null, lockedBy: null },
      }).catch(() => {});
    }
  }
  return { summaries: sent };
}

let lastPurgeDay = null;

/** Daily transcript purge using each client's effective retention (D7). */
export async function purgeTranscripts({ now, instance, force = false }) {
  const day = now.toISOString().slice(0, 10);
  const due = force || (now.getHours() === 3 && now.getMinutes() >= 30 && lastPurgeDay !== day);
  if (!due) return { skipped: true };
  lastPurgeDay = day;
  const clients = await prisma.voiceInterviewSession.groupBy({
    by: ['clientId'],
    where: { transcript: { not: Prisma.DbNull } },
    orderBy: { clientId: 'asc' },
    take: 500,
  });
  let purged = 0;
  for (const { clientId } of clients) {
    const settings = await resolveInterviewSettings(clientId);
    const cutoff = new Date(now.getTime() - settings.transcriptRetentionDays * DAY_MS);
    const res = await prisma.voiceInterviewSession.updateMany({
      where: { clientId, startedAt: { lt: cutoff }, transcript: { not: Prisma.DbNull } },
      data: { transcript: Prisma.DbNull },
    });
    purged += res.count;
  }
  if (purged) await logDispatch({ kind: 'PURGE', detail: `${purged} transcripts`, instance });
  return { purged };
}

/**
 * One scheduler tick. Returns a per-step summary (errors are captured per step).
 */
export async function runInterviewSchedulerTick({ now = new Date(), log = null, force = false } = {}) {
  if (!force && !isLeader()) return { skipped: 'not-leader' };
  const instance = instanceId();
  const ctx = { now, instance, log };
  const steps = {
    sendScheduledInvites,
    sendReminders,
    expireInvites,
    reapStaleSessions,
    runConsolidation,
    cancelUnconfirmedDelegations,
    finalizeRootInvites,
    purgeTranscripts,
  };
  const summary = {};
  for (const [name, fn] of Object.entries(steps)) {
    try {
      summary[name] = await fn(ctx);
    } catch (err) {
      summary[name] = { error: err?.message || String(err) };
      log?.error?.({ err, step: name }, 'Interview scheduler step failed');
    }
  }
  return summary;
}
