/**
 * Interview invite lifecycle: tokens, creation, sending and the dispatch log.
 *
 * Tokens. Only sha256(token) is stored and used for lookup (unchanged rule).
 * New invites derive the plaintext token as HMAC-SHA256(secret, id:nonce)
 * with a random per-invite nonce, so the scheduler can re-send the SAME link
 * in reminders and in the summary email without ever storing the token.
 * Rotating the nonce (resend) kills the old link. Legacy invites (no nonce)
 * keep working through their stored hash.
 *
 * Secret: INTERVIEW_TOKEN_SECRET, falling back to JWT_ACCESS_SECRET (domain-
 * separated by the HMAC label). Changing the secret invalidates open links.
 */
import crypto from 'crypto';
import { prisma } from './prisma.js';
import { sendEmail } from './mailer.js';
import { notificationEmailsPaused, PAUSED_EMAIL_ERROR } from './notificationEmailPause.js';
import { buildInviteEmail, buildDelegationEmail, agencyDisplayName } from './interviewEmail.js';
import { buildInterviewAgenda, composeAgenda } from './interviewAgenda.js';
import { INTERVIEW_TEMPLATES } from './interviewQuestionBank.js';
import { buildRecipients } from './notifyRecipients.js';

export const DEFAULT_TTL_DAYS = 14;
export const MAX_TTL_DAYS = 90;
export const DEFAULT_REMINDER_DAYS = [3, 7];
export const CHILD_REMINDER_DAYS = [2, 5];
export const CONSENT_VERSION = () => process.env.INTERVIEW_CONSENT_VERSION || '2026-10-v1';

/** Statuses in which the respondent can still talk / type. */
export const ACTIVE_STATUSES = ['PENDING', 'SENT', 'OPENED', 'IN_PROGRESS', 'SEND_FAILED'];
/** Terminal statuses for tree finalisation. */
export const TERMINAL_STATUSES = ['COMPLETED', 'EXPIRED', 'REVOKED', 'DECLINED', 'ABANDONED'];

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function tokenSecret() {
  const s = process.env.INTERVIEW_TOKEN_SECRET || process.env.JWT_ACCESS_SECRET;
  if (!s) throw new Error('INTERVIEW_TOKEN_SECRET (or JWT_ACCESS_SECRET) must be set to mint interview links.');
  return s;
}

export function deriveToken(inviteId, nonce) {
  return crypto
    .createHmac('sha256', tokenSecret())
    .update(`lw-interview-link:v1:${inviteId}:${nonce}`)
    .digest('base64url');
}

/** New nonce + token + hash for an invite id. */
export function mintToken(inviteId) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const token = deriveToken(inviteId, nonce);
  return { nonce, token, tokenHash: hashToken(token) };
}

/** The current plaintext token, or null for legacy/unsent invites. */
export function currentToken(invite) {
  if (!invite?.tokenNonce) return null;
  return deriveToken(invite.id, invite.tokenNonce);
}

/** A hash nobody can match, for invites whose link has not been minted yet. */
export function placeholderHash() {
  return hashToken(`unsent:${crypto.randomBytes(32).toString('hex')}`);
}

export function frontendBase() {
  const raw = process.env.FRONTEND_URL || 'https://app.localwaves.ai';
  return raw.split(',')[0].trim().replace(/\/$/, '');
}

export function inviteUrl(token) {
  return `${frontendBase()}/knowledge-interview/${token}`;
}

/** Never leak hashes, nonces or lock owners to a browser. */
export function publicShape(invite) {
  if (!invite) return invite;
  const { tokenHash: _h, tokenNonce: _n, lockedBy: _l, dispatchKey: _d, ...rest } = invite;
  return rest;
}

export async function logDispatch({ inviteId = null, campaignId = null, kind, ok = true, detail = null, instance = null }) {
  try {
    await prisma.interviewDispatchLog.create({
      data: {
        inviteId,
        campaignId,
        kind: String(kind).slice(0, 30),
        ok: Boolean(ok),
        detail: detail ? String(detail).slice(0, 1000) : null,
        instance: instance ? String(instance).slice(0, 50) : null,
      },
    });
  } catch {
    // Audit logging must never break the caller.
  }
}

export function normaliseReminderDays(days, fallback = DEFAULT_REMINDER_DAYS) {
  if (!Array.isArray(days)) return fallback;
  const clean = [...new Set(days.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 60))].sort((a, b) => a - b);
  return clean.slice(0, 5);
}

async function loadNames(clientId) {
  const client = await prisma.clientAccount.findUnique({
    where: { id: clientId },
    select: { agencyName: true },
  });
  return { businessName: client?.agencyName || 'your business', agencyName: await agencyDisplayName() };
}

/**
 * Renders the email for an invite: delegation email for a worker's first
 * send, invite/reminder email otherwise.
 */
export async function renderInviteEmail(invite, { url, isReminder = false } = {}) {
  const { businessName, agencyName } = await loadNames(invite.clientId);
  if (invite.respondentRole === 'STAFF' && !isReminder) {
    let delegatorName = null;
    if (invite.parentInviteId) {
      const parent = await prisma.knowledgeInterviewInvite.findUnique({
        where: { id: invite.parentInviteId },
        select: { recipientName: true },
      });
      delegatorName = parent?.recipientName || null;
    }
    return {
      ...(await buildDelegationEmail({
        child: invite,
        businessName,
        agencyName,
        delegatorName,
        url,
        declineUrl: `${url}?decline=1`,
      })),
      agencyName,
    };
  }
  return { ...(await buildInviteEmail({ invite, businessName, agencyName, url, isReminder })), agencyName };
}

/**
 * Sends (or re-sends) an invite email and records the outcome.
 *
 * kind: SEND (first send; mints a token if none), RESEND (always rotates the
 * token so the old link dies), REMINDER (same link, no status change).
 *
 * @returns {Promise<{ok: boolean, url: string|null, error?: string, paused?: boolean}>}
 */
export async function dispatchInvite(invite, { kind = 'SEND', instance = null } = {}) {
  if (!invite.sentToEmail) return { ok: false, url: null, error: 'No email address on this invite' };

  if (notificationEmailsPaused()) {
    await logDispatch({ inviteId: invite.id, kind, ok: false, detail: PAUSED_EMAIL_ERROR, instance });
    return { ok: false, url: null, error: PAUSED_EMAIL_ERROR, paused: true };
  }

  let working = invite;
  if (kind === 'RESEND' || !invite.tokenNonce) {
    const minted = mintToken(invite.id);
    working = await prisma.knowledgeInterviewInvite.update({
      where: { id: invite.id },
      data: { tokenHash: minted.tokenHash, tokenNonce: minted.nonce },
    });
  }
  const url = inviteUrl(currentToken(working));
  const isReminder = kind === 'REMINDER';

  let result;
  try {
    const email = await renderInviteEmail(working, { url, isReminder });
    result = await sendEmail({
      to: working.sentToEmail,
      subject: email.subject,
      html: email.html,
      text: email.text,
      fromName: email.agencyName,
    });
  } catch (err) {
    result = { success: false, error: err?.message || 'Email render failed' };
  }

  const ok = Boolean(result?.success);
  if (!isReminder) {
    const keepStatus = ['OPENED', 'IN_PROGRESS'].includes(working.status) && kind !== 'RESEND';
    await prisma.knowledgeInterviewInvite.update({
      where: { id: working.id },
      data: ok
        ? { status: keepStatus ? working.status : 'SENT', sentAt: new Date(), sendError: null }
        : { status: keepStatus ? working.status : 'SEND_FAILED', sendError: String(result?.error || 'Send failed').slice(0, 500) },
    });
  }
  await logDispatch({ inviteId: working.id, kind, ok, detail: ok ? `to ${maskEmail(working.sentToEmail)}` : result?.error, instance });

  if (!ok) await notifySendFailed(working, result?.error).catch(() => {});
  return { ok, url, ...(ok ? {} : { error: result?.error || 'Send failed' }) };
}

export function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return `${user.slice(0, 2)}***@${domain}`;
}

/** Lead/secondary PM of the client plus all active owners (plan §11). */
export async function staffRecipientIds(clientId) {
  const [client, owners] = await Promise.all([
    prisma.clientAccount.findUnique({ where: { id: clientId }, select: { leadPmId: true, secondaryPmId: true } }),
    prisma.user.findMany({ where: { role: 'OWNER', isActive: true }, select: { id: true } }),
  ]);
  return buildRecipients(null, [client?.leadPmId, client?.secondaryPmId], owners.map((o) => o.id));
}

async function notifySendFailed(invite, error) {
  const { notify } = await import('./notificationService.js');
  const client = await prisma.clientAccount.findUnique({ where: { id: invite.clientId }, select: { agencyName: true } });
  const owners = await prisma.user.findMany({ where: { role: 'OWNER', isActive: true }, select: { id: true } });
  await notify({
    slug: 'interview_send_failed',
    recipientIds: [invite.createdById, ...owners.map((o) => o.id)].filter(Boolean),
    variables: {
      clientName: client?.agencyName || 'a client',
      recipient: maskEmail(invite.sentToEmail),
      error: String(error || 'unknown error').slice(0, 200),
    },
    actionUrl: '/portal/admin/interviews',
    metadata: { inviteId: invite.id },
  });
}

/**
 * Creates one root invite per recipient (plan §9 POST /invites).
 *
 * @returns {Promise<{invites: object[], urls: Array<{inviteId: string, url: string}>}>}
 */
export async function createInvites({
  clientId,
  projectId = null,
  createdById,
  templateKey = 'CUSTOM',
  recipients = [],
  scheduledSendAt = null,
  expiresInDays = DEFAULT_TTL_DAYS,
  agenda = null,
  agendaOverrides = null,
  emailSubject = null,
  emailIntro = null,
  reminderDays = DEFAULT_REMINDER_DAYS,
  minutesBudget = null,
  language = 'en',
  mode = 'VOICE',
  sendEmail: shouldSend = true,
  autoApproveLowRisk = null,
  instance = null,
  now = new Date(),
}) {
  const template = INTERVIEW_TEMPLATES[templateKey] ? templateKey : 'CUSTOM';
  const finalAgenda = agenda?.questions
    ? composeAgenda({ templateKey: template, assessment: {}, files: [], overrides: { questions: agenda.questions, goals: agenda.goals } })
    : await buildInterviewAgenda({ clientId, templateKey: template, overrides: agendaOverrides || {} });
  // Keep the KB-derived doNotAsk from a fresh build when the editor sent questions.
  if (agenda?.questions) {
    const fresh = await buildInterviewAgenda({ clientId, templateKey: template });
    finalAgenda.doNotAsk = fresh.doNotAsk;
  }

  const sendAt = scheduledSendAt ? new Date(scheduledSendAt) : null;
  const isFuture = sendAt && sendAt.getTime() > now.getTime() + 60 * 1000;
  const ttl = Math.min(Math.max(Number(expiresInDays) || DEFAULT_TTL_DAYS, 1), MAX_TTL_DAYS);
  const base = isFuture ? sendAt : now;
  const expiresAt = new Date(base.getTime() + ttl * 24 * 60 * 60 * 1000);
  const budget = Math.min(Math.max(Number(minutesBudget) || INTERVIEW_TEMPLATES[template].defaultMinutes || 20, 1), 120);
  const list = recipients.length ? recipients : [{ name: null, email: null }];

  const invites = [];
  const urls = [];
  for (const r of list) {
    const id = crypto.randomUUID();
    const email = r.email ? String(r.email).trim().toLowerCase().slice(0, 255) : null;
    const willSchedule = Boolean(shouldSend && email && isFuture);
    const minted = willSchedule ? null : mintToken(id);

    let invite = await prisma.knowledgeInterviewInvite.create({
      data: {
        id,
        clientId,
        projectId,
        tokenHash: minted ? minted.tokenHash : placeholderHash(),
        tokenNonce: minted ? minted.nonce : null,
        createdById,
        recipientName: r.name ? String(r.name).slice(0, 255) : null,
        sentToEmail: email,
        status: willSchedule ? 'SCHEDULED' : 'PENDING',
        expiresAt,
        templateKey: template,
        agenda: finalAgenda,
        mode: mode === 'TEXT' ? 'TEXT' : 'VOICE',
        language: String(language || 'en').slice(0, 10),
        emailSubject: emailSubject ? String(emailSubject).slice(0, 255) : null,
        emailIntro: emailIntro ? String(emailIntro).slice(0, 4000) : null,
        scheduledSendAt: willSchedule ? sendAt : null,
        reminderDays: normaliseReminderDays(reminderDays),
        minutesBudget: budget,
        autoApproveLowRisk: typeof autoApproveLowRisk === 'boolean' ? autoApproveLowRisk : null,
        rootInviteId: id,
        respondentRole: 'CLIENT',
      },
    });

    if (shouldSend && email && !willSchedule) {
      const sent = await dispatchInvite(invite, { kind: 'SEND', instance });
      invite = await prisma.knowledgeInterviewInvite.findUnique({ where: { id } });
      urls.push({ inviteId: id, url: sent.url || inviteUrl(minted.token), emailed: sent.ok, error: sent.error || null });
    } else if (minted) {
      urls.push({ inviteId: id, url: inviteUrl(minted.token), emailed: false, error: null });
    }
    invites.push(invite);
  }

  return { invites, urls };
}
