/**
 * Handing interview questions to a colleague (plan §18–§19, owner decision D1).
 *
 * Only the ROOT respondent (respondentRole CLIENT, depth 0) can delegate, so
 * the tree is one level deep. A child invite is a normal invite row with its
 * own token, consent, expiry and minute budget; its minutes count against the
 * same client monthly cap (D3).
 *
 * Speech-initiated delegations are created as PENDING_CONFIRM and nothing is
 * emailed until the respondent taps Confirm on screen, so a misheard email is
 * never used. Landing-page delegations (typed and confirmed on screen) send at
 * once.
 */
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from './prisma.js';
import {
  dispatchInvite,
  logDispatch,
  placeholderHash,
  staffRecipientIds,
  CHILD_REMINDER_DAYS,
  TERMINAL_STATUSES,
} from './interviewInvites.js';
import { QUESTION_BANK } from './interviewQuestionBank.js';
import { sanitizeUserInputForPrompt } from './ai.js';

export const MAX_CLUSTER = 10;
export const MAX_DELEGATIONS_PER_SESSION = 3;
export const CHILD_MINUTES = 10;
export const CHILD_TTL_DAYS = 7;

export function maxDelegationsPerRoot() {
  const n = Number(process.env.INTERVIEW_MAX_DELEGATIONS_PER_ROOT || 5);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 20) : 5;
}

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com', 'tempmail.com',
  'temp-mail.org', 'yopmail.com', 'trashmail.com', 'getnada.com', 'sharklasers.com',
  'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com',
]);

export class DelegationError extends Error {
  constructor(message, status = 400, code = 'DELEGATION_INVALID') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const emailSchema = z.string().trim().toLowerCase().email().max(255);

export function validateWorkerEmail(raw, { rootEmail = null } = {}) {
  const parsed = emailSchema.safeParse(String(raw || ''));
  if (!parsed.success) throw new DelegationError('That email address does not look right. Please check it.', 400, 'EMAIL_INVALID');
  const email = parsed.data;
  const domain = email.split('@')[1];
  if (DISPOSABLE_DOMAINS.has(domain)) {
    throw new DelegationError('Please use a work email address for your colleague.', 400, 'EMAIL_DISPOSABLE');
  }
  if (rootEmail && email === String(rootEmail).trim().toLowerCase()) {
    throw new DelegationError('That is your own email. Enter your colleague\'s email instead.', 400, 'EMAIL_SELF');
  }
  return email;
}

function slug(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'topic';
}

function clean(text, max) {
  return sanitizeUserInputForPrompt(String(text || ''), max).replace(/\s+/g, ' ').trim();
}

/**
 * Builds the worker's question cluster (plan §19, server-side so a worker can
 * never widen their own scope):
 *   1. the questions the client deferred;
 *   2. other open agenda questions in the same folder (or same specific factType);
 *   3. bank questions matching the topic summary.
 * Capped at MAX_CLUSTER, deferred first.
 */
export function clusterQuestionsForWorker(agenda, questionIds = [], topicSummary = '') {
  const questions = Array.isArray(agenda?.questions) ? agenda.questions : [];
  const isOpen = (q) => !q.answeredBy && !q.delegatedTo;
  const wanted = new Set(Array.isArray(questionIds) ? questionIds : []);

  const deferred = questions.filter((q) => wanted.has(q.id) && isOpen(q));
  const folders = new Set(deferred.map((q) => q.folder));
  const factTypes = new Set(deferred.map((q) => q.factType).filter((t) => t && t !== 'fact'));
  const related = questions.filter(
    (q) => isOpen(q) && !wanted.has(q.id) && (folders.has(q.folder) || factTypes.has(q.factType))
  );

  const out = [...deferred, ...related];
  const topic = String(topicSummary || '').toLowerCase();
  if (topic) {
    const terms = topic.split(/[^a-z0-9]+/).filter((t) => t.length > 3);
    const ids = new Set(out.map((q) => q.id));
    const scored = QUESTION_BANK
      .filter((b) => !ids.has(b.id))
      .map((b) => {
        const hay = `${b.topic} ${b.prompt} ${b.folder}`.toLowerCase();
        return { b, score: terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    for (const { b } of scored) {
      out.push({ id: b.id, folder: b.folder, factType: b.factType, prompt: b.prompt, probe: b.probe, topic: b.topic, source: 'bank', kind: 'primary' });
    }
    if (!out.length) {
      const summary = clean(topicSummary, 200);
      out.push({
        id: `topic-${slug(summary)}`,
        folder: 'company',
        factType: 'fact',
        prompt: `${summary} — can you tell us about this?`,
        probe: 'Can you give a specific example, number or name?',
        topic: summary,
        source: 'delegation',
        kind: 'primary',
      });
    }
  }

  const seen = new Set();
  return out
    .filter((q) => (seen.has(q.id) ? false : seen.add(q.id)))
    .slice(0, MAX_CLUSTER)
    .map((q) => ({ ...q, kind: 'primary', answeredBy: undefined, delegatedTo: undefined }));
}

/** Marks (or clears) delegatedTo on the root agenda for the given question ids. */
async function setDelegatedTo(rootId, questionIds, childId) {
  const root = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: rootId }, select: { agenda: true } });
  if (!root?.agenda?.questions) return;
  const ids = new Set(questionIds);
  const agenda = {
    ...root.agenda,
    questions: root.agenda.questions.map((q) => {
      if (!ids.has(q.id)) return q;
      if (childId) return { ...q, delegatedTo: childId };
      const { delegatedTo: _d, ...rest } = q;
      return rest;
    }),
  };
  await prisma.knowledgeInterviewInvite.update({ where: { id: rootId }, data: { agenda } });
}

function emailDomain(email) {
  return String(email || '').split('@')[1]?.toLowerCase() || '';
}

/** Alert staff when the worker's domain matches neither the website nor any contact (plan §22). */
async function maybeAlertDomain(root, child) {
  const domain = emailDomain(child.sentToEmail);
  const client = await prisma.clientAccount.findUnique({
    where: { id: root.clientId },
    select: { agencyName: true, websiteUrl: true, clientUsers: { select: { user: { select: { email: true } } } } },
  }).catch(() => null);
  let siteHost = '';
  try {
    siteHost = new URL(client?.websiteUrl || '').hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    siteHost = '';
  }
  const contactDomains = new Set((client?.clientUsers || []).map((u) => emailDomain(u.user?.email)).filter(Boolean));
  if (root.sentToEmail) contactDomains.add(emailDomain(root.sentToEmail));
  const matches = (siteHost && (domain === siteHost || domain.endsWith(`.${siteHost}`))) || contactDomains.has(domain);
  if (matches) return;
  const { notify } = await import('./notificationService.js');
  await Promise.resolve(notify({
    slug: 'interview_delegated_staff',
    recipientIds: await staffRecipientIds(root.clientId),
    variables: {
      clientName: client?.agencyName || 'a client',
      delegatorName: root.recipientName || 'The client',
      workerName: child.recipientName || 'a colleague',
      workerDomain: domain,
      questionCount: String(Array.isArray(child.questionCluster) ? child.questionCluster.length : 0),
      domainNote: "This email domain doesn't match the client's website or contacts. Check it and revoke the invite if it looks wrong.",
    },
    actionUrl: '/portal/admin/interviews',
    metadata: { inviteId: child.id, rootInviteId: root.id },
  })).catch(() => {});
}

/**
 * Creates a child invite for a colleague.
 *
 * @param {object} p
 * @param {object} p.root           the root invite row (already resolved from its token)
 * @param {object|null} p.session   the voice/text session it came from, if any
 * @param {boolean} p.viaSpeech     true → PENDING_CONFIRM, nothing sent until confirm
 * @returns {Promise<{child: object, clusterSize: number, status: string, sent?: boolean}>}
 */
export async function createDelegation({
  root,
  session = null,
  workerName,
  workerEmail,
  workerRole = null,
  reason = '',
  questionIds = [],
  topicSummary = '',
  viaSpeech = false,
  now = new Date(),
}) {
  // D1: only the root respondent may delegate; workers never can.
  if (root.respondentRole !== 'CLIENT' || (root.delegationDepth || 0) > 0 || (root.rootInviteId && root.rootInviteId !== root.id)) {
    throw new DelegationError('Only the person who received the original invite can hand questions to a colleague.', 403, 'DELEGATION_FORBIDDEN');
  }
  const name = clean(workerName, 120);
  if (!name) throw new DelegationError("Please add your colleague's name.", 400, 'NAME_REQUIRED');
  const email = validateWorkerEmail(workerEmail, { rootEmail: root.sentToEmail });

  if (session) {
    const perSession = await prisma.knowledgeInterviewInvite.count({ where: { delegatedBySessionId: session.id } });
    if (perSession >= MAX_DELEGATIONS_PER_SESSION) {
      throw new DelegationError('You can hand questions to at most three colleagues per conversation.', 429, 'DELEGATION_SESSION_LIMIT');
    }
  }

  const duplicate = await prisma.knowledgeInterviewInvite.findFirst({
    where: { parentInviteId: root.id, sentToEmail: email, status: { notIn: TERMINAL_STATUSES } },
    select: { id: true },
  });
  if (duplicate) {
    throw new DelegationError('That colleague already has an open set of questions from you.', 409, 'DELEGATION_DUPLICATE');
  }

  const cluster = clusterQuestionsForWorker(root.agenda, questionIds, topicSummary);
  if (!cluster.length) {
    throw new DelegationError('Pick at least one topic to hand over.', 400, 'CLUSTER_EMPTY');
  }

  // CAS on the root counter so concurrent requests cannot exceed the cap.
  const max = maxDelegationsPerRoot();
  const claimed = await prisma.knowledgeInterviewInvite.updateMany({
    where: { id: root.id, delegationCount: { lt: max } },
    data: { delegationCount: { increment: 1 } },
  });
  if (claimed.count !== 1) {
    throw new DelegationError(`You can hand questions to at most ${max} colleagues.`, 429, 'DELEGATION_ROOT_LIMIT');
  }

  const id = crypto.randomUUID();
  const childExpiry = new Date(Math.min(
    now.getTime() + CHILD_TTL_DAYS * 24 * 60 * 60 * 1000,
    new Date(root.expiresAt).getTime() + CHILD_TTL_DAYS * 24 * 60 * 60 * 1000
  ));
  const business = await prisma.clientAccount.findUnique({ where: { id: root.clientId }, select: { agencyName: true } });

  let child = await prisma.knowledgeInterviewInvite.create({
    data: {
      id,
      clientId: root.clientId,
      projectId: root.projectId,
      tokenHash: placeholderHash(),
      createdById: root.createdById,
      recipientName: name,
      sentToEmail: email,
      status: viaSpeech ? 'PENDING_CONFIRM' : 'PENDING',
      expiresAt: childExpiry,
      campaignId: root.campaignId || null,
      templateKey: root.templateKey || 'CUSTOM',
      language: root.language || 'en',
      mode: root.mode || 'VOICE',
      agenda: {
        version: 1,
        templateKey: root.templateKey || 'CUSTOM',
        goals: [`Help ${business?.agencyName || 'the business'} with a few questions ${root.recipientName || 'your colleague'} handed to you.`],
        questions: cluster,
        doNotAsk: root.agenda?.doNotAsk || [],
        gaps: [],
        builtAt: now.toISOString(),
        estMinutes: Math.max(3, Math.round(cluster.length * 1.2)),
      },
      questionCluster: cluster,
      reminderDays: CHILD_REMINDER_DAYS,
      minutesBudget: CHILD_MINUTES,
      parentInviteId: root.id,
      rootInviteId: root.rootInviteId || root.id,
      delegationDepth: 1,
      delegatedBySessionId: session?.id || null,
      delegationReason: clean(reason, 500) || null,
      respondentRole: 'STAFF',
      respondentJobRole: workerRole ? clean(workerRole, 120) : null,
      autoApproveLowRisk: root.autoApproveLowRisk,
    },
  });

  // Root questions handed over are not asked again.
  const rootQuestionIds = new Set((root.agenda?.questions || []).map((q) => q.id));
  await setDelegatedTo(root.id, cluster.map((q) => q.id).filter((qid) => rootQuestionIds.has(qid)), child.id);
  await logDispatch({ inviteId: child.id, kind: 'DELEGATE', detail: `${cluster.length} questions${viaSpeech ? ' (awaiting confirm)' : ''}` });

  let sent;
  if (!viaSpeech) {
    sent = await dispatchInvite(child, { kind: 'SEND' });
    child = await prisma.knowledgeInterviewInvite.findUnique({ where: { id } });
    await maybeAlertDomain(root, child);
  }

  return { child, clusterSize: cluster.length, status: child.status, ...(sent ? { sent: sent.ok } : {}) };
}

async function findChild(root, childId) {
  const child = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: childId } });
  if (!child || child.parentInviteId !== root.id) throw new DelegationError('Delegation not found.', 404, 'NOT_FOUND');
  return child;
}

/** The on-screen Confirm tap for a speech-initiated delegation (plan §19). */
export async function confirmDelegation({ root, childId, workerEmail = null, workerName = null }) {
  const child = await findChild(root, childId);
  if (child.status !== 'PENDING_CONFIRM') {
    throw new DelegationError('This delegation has already been confirmed or cancelled.', 409, 'NOT_PENDING');
  }
  const data = { status: 'PENDING' };
  if (workerEmail) {
    const email = validateWorkerEmail(workerEmail, { rootEmail: root.sentToEmail });
    const duplicate = await prisma.knowledgeInterviewInvite.findFirst({
      where: { parentInviteId: root.id, sentToEmail: email, status: { notIn: TERMINAL_STATUSES }, NOT: { id: child.id } },
      select: { id: true },
    });
    if (duplicate) throw new DelegationError('That colleague already has an open set of questions from you.', 409, 'DELEGATION_DUPLICATE');
    data.sentToEmail = email;
  }
  if (workerName) data.recipientName = clean(workerName, 120) || child.recipientName;

  // CAS: exactly one confirm wins.
  const claimed = await prisma.knowledgeInterviewInvite.updateMany({
    where: { id: child.id, status: 'PENDING_CONFIRM' },
    data,
  });
  if (claimed.count !== 1) throw new DelegationError('This delegation has already been confirmed or cancelled.', 409, 'NOT_PENDING');

  const fresh = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: child.id } });
  await logDispatch({ inviteId: child.id, kind: 'CONFIRM_DELEGATION' });
  const sent = await dispatchInvite(fresh, { kind: 'SEND' });
  const after = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: child.id } });
  await maybeAlertDomain(root, after);
  return { child: after, sent: sent.ok, error: sent.error || null };
}

/** Respondent cancels a delegation they created (frees the agenda questions). */
export async function cancelDelegation({ root, childId, reason = 'cancelled' }) {
  const child = await findChild(root, childId);
  if (TERMINAL_STATUSES.includes(child.status)) return { child };
  const wasUnconfirmed = child.status === 'PENDING_CONFIRM';
  const updated = await prisma.knowledgeInterviewInvite.update({
    where: { id: child.id },
    data: { status: 'REVOKED', revokedAt: new Date(), statusReason: reason },
  });
  if (wasUnconfirmed) {
    await prisma.knowledgeInterviewInvite.updateMany({
      where: { id: root.id, delegationCount: { gt: 0 } },
      data: { delegationCount: { decrement: 1 } },
    });
  }
  await setDelegatedTo(root.id, (child.questionCluster || []).map((q) => q.id), null);
  await logDispatch({ inviteId: child.id, kind: 'REVOKE', detail: reason });
  return { child: updated };
}

/** "Not you?" from the delegation email (plan §19). */
export async function declineDelegation(child) {
  if (child.respondentRole !== 'STAFF' || !child.parentInviteId) {
    throw new DelegationError('Only a delegated invite can be declined.', 400, 'NOT_DELEGATED');
  }
  const claimed = await prisma.knowledgeInterviewInvite.updateMany({
    where: { id: child.id, status: { notIn: TERMINAL_STATUSES } },
    data: { status: 'DECLINED', declinedAt: new Date(), statusReason: 'declined by recipient' },
  });
  if (claimed.count !== 1) return { alreadyClosed: true };
  await setDelegatedTo(child.parentInviteId, (child.questionCluster || []).map((q) => q.id), null);
  await logDispatch({ inviteId: child.id, kind: 'DECLINE' });

  const [root, client] = await Promise.all([
    prisma.knowledgeInterviewInvite.findUnique({ where: { id: child.parentInviteId }, select: { recipientName: true } }),
    prisma.clientAccount.findUnique({ where: { id: child.clientId }, select: { agencyName: true } }),
  ]);
  const { notify } = await import('./notificationService.js');
  await Promise.resolve(notify({
    slug: 'interview_delegation_declined',
    recipientIds: await staffRecipientIds(child.clientId),
    variables: {
      clientName: client?.agencyName || 'a client',
      delegatorName: root?.recipientName || 'the client',
      workerName: child.recipientName || 'A colleague',
    },
    actionUrl: '/portal/admin/interviews',
    metadata: { inviteId: child.id },
  })).catch(() => {});
  return { declined: true };
}
