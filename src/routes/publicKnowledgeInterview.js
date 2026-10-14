/**
 * Login-free knowledge interview, reached through a tokenised invite link.
 *
 * These routes are intentionally unauthenticated, so they:
 *   - resolve the client from the token alone and never trust a body-supplied id,
 *   - expose only a summary of the knowledge base, not file contents,
 *   - are rate limited per IP, with DB-held caps (sessions, minutes) that hold
 *     across PM2 instances,
 *   - require consent before any voice/text session (plan §5),
 *   - write to IntakeSubmission and the OKF draft queue, never straight to disk,
 *   - never log the token (no request params in log lines).
 *
 * Voice and text (owner decision D10) share one capture pipeline
 * (lib/interviewCapture.js). Only the root respondent may delegate (D1).
 * A COMPLETED invite opens in summary mode for 30 days (plan §20) instead of
 * returning 410; summary mode allows reading, correcting and withdrawing only.
 *
 * Legacy endpoints (/chat with client-held state, /submit) are kept unchanged
 * for pages already open in browsers.
 */
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { generateChat, isAiConfigured } from '../lib/ai.js';
import { listOkfIndex } from '../lib/okfIndexingService.js';
import { readOkfFile } from '../lib/knowledgeEngine.js';
import {
  isRealtimeVoiceConfigured,
  mintRealtimeSession,
  buildPublicInterviewInstructions,
  buildPublicInterviewTools,
  MAX_SESSION_SECONDS,
} from '../lib/realtimeVoice.js';
import {
  hashToken,
  CONSENT_VERSION,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  logDispatch,
  maskEmail,
  staffRecipientIds,
} from '../lib/interviewInvites.js';
import { buildInterviewAgenda, openQuestions } from '../lib/interviewAgenda.js';
import { folderLabel } from '../lib/interviewQuestionBank.js';
import {
  processInterviewTool,
  listInviteCaptures,
  mergeTranscript,
  respondentAllowFolders,
  applyChangeToBody,
} from '../lib/interviewCapture.js';
import {
  createDelegation,
  confirmDelegation,
  cancelDelegation,
  declineDelegation,
  DelegationError,
} from '../lib/interviewDelegation.js';
import { runTextTurn, openingMessage, MAX_TEXT_TURNS_PER_INVITE } from '../lib/interviewText.js';
import {
  attributionUserId,
  inviteRemainingSeconds,
  closeSession,
  closeActiveSessions,
  buildPromptOptions,
  delegatorName,
} from '../lib/interviewSession.js';
import { resolveInterviewSettings } from '../lib/interviewSettings.js';
import { getUsage, getAgencyUsage } from '../lib/voiceUsage.js';
import { agencyDisplayName, childStatusLabel } from '../lib/interviewEmail.js';
import { isFolderAllowed } from '../lib/interviewKnowledge.js';

const INTERVIEW_FIELDS = `1. websiteUrl: The business website URL.
2. primaryProduct: Main products or services offered.
3. keyMarkets: Main cities or regions targeted.
4. targetCustomer: Ideal client/customer persona.
5. uniqueSellingPoints: USPs, what sets the business apart.
6. primarySeoGoal: Allowed options: "traffic", "keywords", "competitors", "local", "ecommerce", "other".
7. competitors: List of top 1-5 competitors (names or URLs).
8. targetKeywords: Seed keywords they want to rank for.
9. geographicTarget: Allowed options: "local", "national", "international".
10. brandVoice: Allowed options: "professional", "friendly", "technical", "bold", "other".
11. topicsToAvoid: Sensitive topics or themes to bypass (optional).
12. seasonalEvents: Key dates or seasonal campaigns (optional).`;

const SYSTEM_PROMPT = `You are a friendly growth consultant interviewing a business owner so their marketing team can write accurately about them.

Collect these fields:
${INTERVIEW_FIELDS}

Read the history and the latest reply, then update "extractedData". Keep values you already have unless the user corrects them. Extract several fields at once when the user volunteers them.

Ask one brief, natural next question (max 2 sentences) about the most important missing field. When fields 1 to 10 are filled, set "isFinished" to true and thank them.

Respond with JSON only:
{"nextQuestion":"...","extractedData":{"websiteUrl":null,"primaryProduct":null,"keyMarkets":null,"targetCustomer":null,"uniqueSellingPoints":null,"primarySeoGoal":null,"competitors":[],"targetKeywords":null,"geographicTarget":null,"brandVoice":null,"topicsToAvoid":null,"seasonalEvents":null},"isFinished":false}`;

// Per-route limits (plan §9). Per-process; DB caps bound the real spend.
const RATE_LIMIT = { max: 40, timeWindow: '10 minutes' };
const CONSENT_LIMIT = { max: 10, timeWindow: '10 minutes' };
const SESSION_LIMIT = { max: 6, timeWindow: '10 minutes' };
const STREAM_LIMIT = { max: 120, timeWindow: '10 minutes' };
const COMPLETE_LIMIT = { max: 20, timeWindow: '10 minutes' };
const LOOKUP_LIMIT = { max: 60, timeWindow: '10 minutes' };
const DELEGATE_LIMIT = { max: 10, timeWindow: '1 hour' };
const FINISH_LIMIT = { max: 10, timeWindow: '10 minutes' };

export const SUMMARY_WINDOW_DAYS = 30;
export const MAX_SESSIONS_PER_INVITE = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves an invite from its plaintext token. Returns null after replying
 * with the reason. With allowSummary, a COMPLETED invite inside the 30-day
 * window resolves with summaryMode = true.
 *
 * @returns {Promise<{invite: object, summaryMode: boolean}|null>}
 */
async function resolveInvite(request, reply, { allowSummary = false } = {}) {
  const token = request.params?.token;
  if (!token || token.length < 20 || token.length > 200) {
    reply.status(404).send({ message: 'This link is not valid.' });
    return null;
  }

  const invite = await prisma.knowledgeInterviewInvite.findUnique({
    where: { tokenHash: hashToken(token) },
  });

  if (!invite || ['SCHEDULED', 'PENDING_CONFIRM'].includes(invite.status)) {
    reply.status(404).send({ message: 'This link is not valid.' });
    return null;
  }
  if (invite.status === 'REVOKED') {
    reply.status(410).send({ message: 'This link has been revoked. Ask your team for a new one.' });
    return null;
  }
  if (invite.status === 'DECLINED') {
    reply.status(410).send({ message: 'You let the team know this was not for you. Thank you.' });
    return null;
  }
  if (invite.status === 'COMPLETED') {
    const doneAt = (invite.completedAt || invite.updatedAt || new Date()).getTime();
    if (allowSummary && Date.now() - doneAt <= SUMMARY_WINDOW_DAYS * DAY_MS) {
      return { invite, summaryMode: true };
    }
    reply.status(410).send({ message: 'This interview has already been completed. Thank you!' });
    return null;
  }
  if (invite.status === 'EXPIRED' || invite.expiresAt.getTime() < Date.now()) {
    reply.status(410).send({ message: 'This link has expired. Ask your team for a new one.' });
    return null;
  }

  return { invite, summaryMode: false };
}

/** Write endpoints: no summary mode. */
async function resolveActive(request, reply) {
  const r = await resolveInvite(request, reply);
  return r ? r.invite : null;
}

function sendZodError(reply, err) {
  return reply.status(400).send({ message: err.issues?.[0]?.message || 'Invalid request', code: 'VALIDATION' });
}

function requireConsent(invite, reply) {
  if (!invite.consentAt) {
    reply.status(403).send({ message: 'Please accept the consent notice first.', code: 'CONSENT_REQUIRED' });
    return false;
  }
  return true;
}

async function markInProgress(invite) {
  if (['PENDING', 'SENT', 'OPENED', 'SEND_FAILED'].includes(invite.status) || !invite.startedAt) {
    await prisma.knowledgeInterviewInvite.update({
      where: { id: invite.id },
      data: {
        status: ACTIVE_STATUSES.includes(invite.status) ? 'IN_PROGRESS' : invite.status,
        startedAt: invite.startedAt || new Date(),
      },
    }).catch(() => {});
  }
}

/** Legacy invites (created before the scheduler) get an agenda on first open. */
async function ensureAgenda(invite) {
  if (invite.agenda?.questions) return invite.agenda;
  const agenda = await buildInterviewAgenda({ clientId: invite.clientId, templateKey: invite.templateKey || 'CUSTOM' });
  await prisma.knowledgeInterviewInvite.update({
    where: { id: invite.id },
    data: { agenda, rootInviteId: invite.rootInviteId || invite.id },
  }).catch(() => {});
  invite.agenda = agenda;
  return agenda;
}

async function loadSession(invite, sessionId, reply, { mode = 'VOICE' } = {}) {
  const session = await prisma.voiceInterviewSession.findUnique({ where: { id: String(sessionId || '') } });
  if (!session || session.inviteId !== invite.id || session.mode !== mode) {
    reply.status(404).send({ message: 'Session not found' });
    return null;
  }
  return session;
}

function topicStatus(q) {
  if (q.answeredBy) return 'answered';
  if (q.delegatedTo) return 'delegated';
  return 'open';
}

/** IDs whose captures this respondent may see: own; root also sees its tree (D4). */
async function visibleInviteIds(invite) {
  if (invite.respondentRole === 'STAFF' || (invite.delegationDepth || 0) > 0) return [invite.id];
  const children = await prisma.knowledgeInterviewInvite.findMany({
    where: { parentInviteId: invite.id },
    select: { id: true },
  });
  return [invite.id, ...children.map((c) => c.id)];
}

/** What the respondent sees for a capture: fragment for merged drafts, never other KB text. */
function publicCapture(c, draft) {
  const meta = draft?.proposedMetadata || {};
  const content = meta.change
    ? null
    : (meta.capture_fragment || c.content || '');
  return {
    id: c.id,
    title: c.title,
    folder: c.folder,
    folderLabel: folderLabel(c.folder),
    status: c.withdrawn ? 'WITHDRAWN' : c.status,
    changeKind: c.changeKind,
    change: c.change,
    content,
    respondentName: c.respondentName,
    respondentRole: c.respondentRole,
    clientCorrected: c.clientCorrected,
    own: c.inviteId === draft?.__viewerInviteId,
  };
}

async function capturesFor(invite) {
  const ids = await visibleInviteIds(invite);
  const list = await listInviteCaptures(ids);
  const drafts = await prisma.okfDraftChange.findMany({
    where: { id: { in: list.map((c) => c.id) } },
    select: { id: true, proposedMetadata: true },
  });
  const metaById = new Map(drafts.map((d) => [d.id, { ...d, __viewerInviteId: invite.id }]));
  return list.map((c) => publicCapture(c, metaById.get(c.id) || { __viewerInviteId: invite.id }));
}

async function delegationsFor(invite) {
  if (invite.respondentRole === 'STAFF') return [];
  const children = await prisma.knowledgeInterviewInvite.findMany({
    where: { parentInviteId: invite.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, recipientName: true, respondentJobRole: true, status: true, sentToEmail: true, questionCluster: true, statusReason: true },
  });
  return children.map((c) => ({
    id: c.id,
    name: c.recipientName,
    jobRole: c.respondentJobRole,
    status: c.status,
    statusLabel: c.status === 'PENDING_CONFIRM' ? 'waiting for your confirmation' : childStatusLabel(c.status),
    // The full email only while the respondent can still correct it on the confirm card.
    email: c.status === 'PENDING_CONFIRM' ? c.sentToEmail : maskEmail(c.sentToEmail),
    topics: (Array.isArray(c.questionCluster) ? c.questionCluster : []).map((q) => q.topic || q.prompt).slice(0, 10),
  }));
}

/** Transcript visibility follows the D7 settings. */
async function transcriptsFor(invite) {
  const settings = await resolveInterviewSettings(invite.clientId);
  const ids = [];
  if (settings.clientCanViewOwnTranscripts) ids.push(invite.id);
  if (settings.clientCanViewWorkerTranscripts && invite.respondentRole !== 'STAFF') {
    const kids = await prisma.knowledgeInterviewInvite.findMany({ where: { parentInviteId: invite.id }, select: { id: true } });
    ids.push(...kids.map((k) => k.id));
  }
  if (!ids.length) return null;
  const sessions = await prisma.voiceInterviewSession.findMany({
    where: { inviteId: { in: ids } },
    orderBy: { startedAt: 'asc' },
    select: { id: true, inviteId: true, mode: true, startedAt: true, transcript: true },
  });
  return sessions
    .filter((s) => Array.isArray(s.transcript) && s.transcript.length)
    .map((s) => ({ sessionId: s.id, own: s.inviteId === invite.id, mode: s.mode, startedAt: s.startedAt, turns: s.transcript }));
}

async function budgetFor(invite) {
  const settings = await resolveInterviewSettings(invite.clientId);
  const [usage, agency] = await Promise.all([getUsage(invite.clientId, { settings }), getAgencyUsage({ settings })]);
  const remainingSeconds = Math.min(inviteRemainingSeconds(invite), usage.remainingSeconds, agency.remainingSeconds);
  return {
    remainingSeconds,
    inviteRemainingSeconds: inviteRemainingSeconds(invite),
    voiceAvailable: isRealtimeVoiceConfigured() && remainingSeconds > 30 && (invite.sessionCount || 0) < MAX_SESSIONS_PER_INVITE,
    textAvailable: isAiConfigured(),
  };
}

function delegationErrorReply(reply, err) {
  if (err instanceof DelegationError) {
    return reply.status(err.status).send({ message: err.message, code: err.code });
  }
  throw err;
}

// ── Schemas (validated in handlers; the app bypasses Fastify's validator) ──

const consentSchema = z.object({
  accepted: z.literal(true),
  language: z.string().max(10).optional(),
});
const voiceSessionSchema = z.object({ language: z.string().max(10).optional() }).optional();
const captureSchema = z.object({
  calls: z.array(z.object({
    callId: z.string().max(100),
    tool: z.string().max(60),
    args: z.record(z.any()).optional().default({}),
    transcriptRef: z.object({ turnIndex: z.number().int().optional(), at: z.string().max(40).optional() }).optional().nullable(),
  })).min(1).max(10),
});
const transcriptSchema = z.object({
  turns: z.array(z.object({
    index: z.number().int().min(0).max(100000),
    role: z.enum(['user', 'assistant']),
    content: z.string().max(4000),
    at: z.string().max(40).optional(),
  })).max(50),
});
const completeSchema = z.object({
  durationSeconds: z.number().min(0).max(24 * 3600).optional(),
  summary: z.string().max(4000).optional().nullable(),
  usage: z.record(z.any()).optional().nullable(),
}).optional();
const lookupSchema = z.object({
  query: z.string().max(300).optional().default(''),
  folder: z.string().max(60).optional().nullable(),
  filename: z.string().max(200).optional().nullable(),
});
const textTurnSchema = z.object({ message: z.string().min(1).max(4000) });
const correctSchema = z.object({
  content: z.string().min(3).max(8000).optional(),
  title: z.string().min(1).max(255).optional(),
  newValue: z.string().min(1).max(1000).optional(),
}).refine((v) => v.content || v.newValue, { message: 'Nothing to correct' });
const delegateSchema = z.object({
  workerName: z.string().min(1).max(120),
  workerEmail: z.string().min(3).max(255),
  workerRole: z.string().max(120).optional().nullable(),
  reason: z.string().max(1000).optional().default(''),
  questionIds: z.array(z.string().max(120)).max(30).optional().default([]),
  topicSummary: z.string().max(300).optional().nullable(),
});
const confirmSchema = z.object({
  workerEmail: z.string().min(3).max(255).optional(),
  workerName: z.string().min(1).max(120).optional(),
}).optional();
const finishSchema = z.object({ summary: z.string().max(2000).optional().nullable() }).optional();

export async function publicKnowledgeInterviewRoutes(app) {
  // ── Page context (interview or summary mode) ──────────────────────────────
  app.get(
    '/knowledge-interview/:token',
    { config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const resolved = await resolveInvite(request, reply, { allowSummary: true });
      if (!resolved) return;
      const { invite, summaryMode } = resolved;
      const agenda = await ensureAgenda(invite);
      const isWorker = invite.respondentRole === 'STAFF';
      const allowFolders = respondentAllowFolders(invite);

      const [client, project, assets, agencyName, captured, delegations, delegator, budget] = await Promise.all([
        prisma.clientAccount.findUnique({
          where: { id: invite.clientId },
          select: { agencyName: true, websiteUrl: true, industry: true },
        }),
        invite.projectId
          ? prisma.project.findUnique({
            where: { id: invite.projectId },
            select: { name: true, projectType: true, status: true },
          })
          : Promise.resolve(null),
        listOkfIndex(invite.clientId, {}).catch(() => []),
        agencyDisplayName(),
        capturesFor(invite),
        delegationsFor(invite),
        delegatorName(invite),
        summaryMode ? Promise.resolve(null) : budgetFor(invite),
      ]);

      if (!summaryMode && ['PENDING', 'SENT', 'SEND_FAILED'].includes(invite.status)) {
        await prisma.knowledgeInterviewInvite
          .update({ where: { id: invite.id }, data: { lastOpenedAt: new Date(), status: 'OPENED' } })
          .catch(() => {});
      } else {
        await prisma.knowledgeInterviewInvite.update({ where: { id: invite.id }, data: { lastOpenedAt: new Date() } }).catch(() => {});
      }

      // Titles and folders only — an unauthenticated caller never sees bodies.
      // Workers only see the folders of their own questions (plan §18).
      const visibleAssets = assets.filter((a) => isFolderAllowed(a.folder, allowFolders));
      const byFolder = {};
      for (const asset of visibleAssets) byFolder[asset.folder] = (byFolder[asset.folder] || 0) + 1;

      const sessions = await prisma.voiceInterviewSession.count({ where: { inviteId: invite.id } });
      const questions = Array.isArray(agenda?.questions) ? agenda.questions : [];

      return reply.send({
        version: 2,
        mode: summaryMode ? 'summary' : 'interview',
        agencyName,
        client: {
          agencyName: client?.agencyName || 'your business',
          websiteUrl: client?.websiteUrl || null,
          industry: client?.industry || null,
        },
        project: project
          ? { name: project.name, projectType: project.projectType, status: project.status }
          : null,
        knowledgeBase: {
          fileCount: visibleAssets.length,
          folders: Object.entries(byFolder).map(([folder, count]) => ({ folder, count })),
          documents: visibleAssets.slice(0, 50).map((a) => ({
            title: a.title,
            folder: a.folder,
            type: a.type,
            lastModified: a.lastModified,
          })),
        },
        invite: {
          recipientName: invite.recipientName,
          expiresAt: invite.expiresAt,
          draftData: invite.draftData || null,
          status: invite.status,
          completedAt: invite.completedAt,
          summaryEditableUntil: summaryMode && invite.completedAt
            ? new Date(invite.completedAt.getTime() + SUMMARY_WINDOW_DAYS * DAY_MS)
            : null,
        },
        respondent: {
          role: isWorker ? 'STAFF' : 'CLIENT',
          name: invite.recipientName,
          jobRole: invite.respondentJobRole,
          delegatorName: delegator,
          delegationReason: isWorker ? invite.delegationReason : null,
        },
        agenda: {
          goals: agenda?.goals || [],
          estMinutes: agenda?.estMinutes || null,
          topics: questions
            .filter((q) => q.kind !== 'followup')
            .map((q) => ({ id: q.id, topic: q.topic || q.prompt, folder: q.folder, label: folderLabel(q.folder), status: topicStatus(q) })),
        },
        consent: {
          given: Boolean(invite.consentAt),
          version: invite.consentVersion,
          currentVersion: CONSENT_VERSION(),
        },
        language: invite.language || 'en',
        preferredMode: invite.mode === 'TEXT' ? 'TEXT' : 'VOICE',
        budget,
        captured,
        sessions: { count: sessions },
        canDelegate: !summaryMode && !isWorker && (invite.delegationDepth || 0) === 0,
        delegations,
        summary: summaryMode
          ? {
            openQuestions: openQuestions(agenda).map((q) => q.topic || q.prompt).slice(0, 12),
            transcripts: await transcriptsFor(invite),
          }
          : null,
      });
    }
  );

  // ── Consent (required before any session) ─────────────────────────────────
  app.post(
    '/knowledge-interview/:token/consent',
    { config: { rateLimit: CONSENT_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      const parsed = consentSchema.safeParse(request.body || {});
      if (!parsed.success) return sendZodError(reply, parsed.error);
      await prisma.knowledgeInterviewInvite.update({
        where: { id: invite.id },
        data: {
          consentAt: new Date(),
          consentVersion: CONSENT_VERSION(),
          consentIp: String(request.ip || '').slice(0, 64),
          consentUserAgent: String(request.headers['user-agent'] || '').slice(0, 500),
          ...(parsed.data.language ? { language: parsed.data.language } : {}),
        },
      });
      return reply.send({ success: true, version: CONSENT_VERSION() });
    }
  );

  // ── Voice: mint an ephemeral Realtime session ─────────────────────────────
  app.post(
    '/knowledge-interview/:token/voice/session',
    { config: { rateLimit: SESSION_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      if (!requireConsent(invite, reply)) return;
      const parsed = voiceSessionSchema.safeParse(request.body || undefined);
      if (!parsed.success) return sendZodError(reply, parsed.error);

      if (!isRealtimeVoiceConfigured()) {
        return reply.status(503).send({ message: 'Voice is not available right now. You can type your answers instead.', code: 'VOICE_UNAVAILABLE' });
      }
      const inviteLeft = inviteRemainingSeconds(invite);
      if (inviteLeft <= 30) {
        return reply.status(429).send({ message: 'The voice time for this interview is used up. You can carry on by typing.', code: 'INVITE_MINUTES_USED' });
      }
      const settings = await resolveInterviewSettings(invite.clientId);
      const [usage, agency] = await Promise.all([getUsage(invite.clientId, { settings }), getAgencyUsage({ settings })]);
      if (usage.remainingSeconds <= 30) {
        return reply.status(429).send({ message: 'Voice minutes for this month are used up. You can carry on by typing.', code: 'VOICE_MONTHLY_LIMIT' });
      }
      if (agency.remainingSeconds <= 30) {
        return reply.status(429).send({ message: 'Voice is busy right now. You can carry on by typing.', code: 'AGENCY_LIMIT' });
      }

      // Per-invite session cap, CAS so it holds across instances.
      const claimed = await prisma.knowledgeInterviewInvite.updateMany({
        where: { id: invite.id, sessionCount: { lt: MAX_SESSIONS_PER_INVITE } },
        data: { sessionCount: { increment: 1 } },
      });
      if (claimed.count !== 1) {
        return reply.status(429).send({ message: 'This link has reached its limit of voice sessions. You can carry on by typing.', code: 'INVITE_SESSION_LIMIT' });
      }

      // Concurrency 1 per invite: a reconnect (closed tab, new phone) ends the old session.
      await closeActiveSessions(invite, { status: 'ABANDONED' });

      const userId = await attributionUserId(invite);
      if (!userId) return reply.status(503).send({ message: 'This interview link is not fully set up.' });

      const priorSessions = await prisma.voiceInterviewSession.count({ where: { inviteId: invite.id } });
      const maxSessionSeconds = Math.max(60, Math.min(MAX_SESSION_SECONDS, inviteLeft, usage.remainingSeconds, agency.remainingSeconds));
      const fresh = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: invite.id } });
      const promptOpts = await buildPromptOptions(fresh, { remainingSeconds: maxSessionSeconds, isResume: priorSessions > 0 });

      let minted;
      try {
        minted = await mintRealtimeSession({
          instructions: buildPublicInterviewInstructions(promptOpts),
          tools: buildPublicInterviewTools({ canDelegate: promptOpts.canDelegate }),
          userId,
          safetyKey: invite.id,
        });
      } catch (err) {
        request.log.error({ err: err?.message }, 'Failed to mint public realtime session');
        await prisma.knowledgeInterviewInvite.updateMany({
          where: { id: invite.id, sessionCount: { gt: 0 } },
          data: { sessionCount: { decrement: 1 } },
        });
        return reply.status(502).send({ message: 'Could not start the voice session. You can type your answers instead.', code: 'VOICE_MINT_FAILED' });
      }

      const session = await prisma.voiceInterviewSession.create({
        data: {
          clientId: invite.clientId,
          projectId: invite.projectId,
          userId,
          inviteId: invite.id,
          mode: 'VOICE',
          status: 'ACTIVE',
          model: minted.model,
          language: parsed.data?.language || invite.language || 'en',
          lastHeartbeatAt: new Date(),
        },
      });
      await markInProgress(invite);

      return reply.send({
        sessionId: session.id,
        clientSecret: minted.clientSecret,
        expiresAt: minted.expiresAt,
        model: minted.model,
        voice: minted.voice,
        maxSessionSeconds,
        remainingSeconds: inviteLeft,
      });
    }
  );

  // ── Voice: per-tool-call capture (acked before the model is told) ─────────
  app.post(
    '/knowledge-interview/:token/voice/:sessionId/capture',
    { config: { rateLimit: STREAM_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      const session = await loadSession(invite, request.params.sessionId, reply);
      if (!session) return;
      if (session.status !== 'ACTIVE') return reply.status(409).send({ message: 'This voice session has ended.', code: 'SESSION_ENDED' });
      const parsed = captureSchema.safeParse(request.body || {});
      if (!parsed.success) return sendZodError(reply, parsed.error);

      const results = [];
      for (const call of parsed.data.calls) {
        const fresh = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: invite.id } });
        const { result, ack } = await processInterviewTool({
          invite: fresh,
          session,
          tool: call.tool,
          args: call.args,
          transcriptRef: call.transcriptRef || null,
        });
        results.push({ callId: call.callId, output: result, ack });
      }
      await prisma.voiceInterviewSession.update({ where: { id: session.id }, data: { lastHeartbeatAt: new Date() } }).catch(() => {});
      return reply.send({ results });
    }
  );

  // ── Voice: transcript turns (append-only by index) ────────────────────────
  app.post(
    '/knowledge-interview/:token/voice/:sessionId/transcript',
    { config: { rateLimit: STREAM_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      const session = await loadSession(invite, request.params.sessionId, reply);
      if (!session) return;
      const parsed = transcriptSchema.safeParse(request.body || {});
      if (!parsed.success) return sendZodError(reply, parsed.error);
      const transcript = mergeTranscript(session.transcript, parsed.data.turns);
      await prisma.voiceInterviewSession.update({
        where: { id: session.id },
        data: { transcript, ...(session.status === 'ACTIVE' ? { lastHeartbeatAt: new Date() } : {}) },
      });
      return reply.send({ success: true, turns: transcript.length });
    }
  );

  // ── Voice: heartbeat (keeps the reaper away, returns time left) ───────────
  app.post(
    '/knowledge-interview/:token/voice/:sessionId/heartbeat',
    { config: { rateLimit: STREAM_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      const session = await loadSession(invite, request.params.sessionId, reply);
      if (!session) return;
      if (session.status !== 'ACTIVE') return reply.send({ remainingSeconds: 0, stop: true });
      const now = new Date();
      await prisma.voiceInterviewSession.update({ where: { id: session.id }, data: { lastHeartbeatAt: now } });
      const elapsed = Math.round((now.getTime() - session.startedAt.getTime()) / 1000);
      const remainingSeconds = Math.max(0, Math.min(inviteRemainingSeconds(invite) - elapsed, MAX_SESSION_SECONDS - elapsed));
      return reply.send({ remainingSeconds, stop: remainingSeconds <= 0 });
    }
  );

  // ── Voice: complete / abandon ─────────────────────────────────────────────
  app.post(
    '/knowledge-interview/:token/voice/:sessionId/complete',
    { config: { rateLimit: COMPLETE_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      const session = await loadSession(invite, request.params.sessionId, reply);
      if (!session) return;
      const parsed = completeSchema.safeParse(request.body || undefined);
      if (!parsed.success) return sendZodError(reply, parsed.error);
      if (session.status !== 'ACTIVE') return reply.send({ success: true, alreadyClosed: true });
      const { billed } = await closeSession(session, {
        status: 'COMPLETED',
        clientSeconds: parsed.data?.durationSeconds ?? null,
        summary: parsed.data?.summary || null,
        usage: parsed.data?.usage || null,
      });
      return reply.send({ success: true, durationSeconds: billed });
    }
  );

  app.post(
    '/knowledge-interview/:token/voice/:sessionId/abandon',
    { config: { rateLimit: COMPLETE_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      const session = await loadSession(invite, request.params.sessionId, reply);
      if (!session) return;
      if (session.status !== 'ACTIVE') return reply.send({ success: true });
      await closeSession(session, { status: 'ABANDONED' });
      return reply.send({ success: true });
    }
  );

  // ── Voice: lookup_knowledge (token-gated, folder allow-list) ──────────────
  app.post(
    '/knowledge-interview/:token/voice/:sessionId/lookup',
    { config: { rateLimit: LOOKUP_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      const session = await loadSession(invite, request.params.sessionId, reply);
      if (!session) return;
      const parsed = lookupSchema.safeParse(request.body || {});
      if (!parsed.success) return sendZodError(reply, parsed.error);
      const { result } = await processInterviewTool({ invite, session, tool: 'lookup_knowledge', args: parsed.data });
      return reply.send(result);
    }
  );

  // ── Text mode (D10): same capture pipeline, server-held transcript ────────
  async function activeTextSession(invite, { create }) {
    const existing = await prisma.voiceInterviewSession.findFirst({
      where: { inviteId: invite.id, mode: 'TEXT', status: 'ACTIVE' },
      orderBy: { startedAt: 'desc' },
    });
    if (existing || !create) return existing;
    const userId = await attributionUserId(invite);
    if (!userId) return null;
    const prior = await prisma.voiceInterviewSession.count({ where: { inviteId: invite.id } });
    const agencyName = await agencyDisplayName();
    const fresh = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: invite.id } });
    const opening = openingMessage({ agencyName, respondentName: invite.recipientName, agenda: fresh.agenda, isResume: prior > 0 });
    return prisma.voiceInterviewSession.create({
      data: {
        clientId: invite.clientId,
        projectId: invite.projectId,
        userId,
        inviteId: invite.id,
        mode: 'TEXT',
        status: 'ACTIVE',
        language: invite.language || 'en',
        lastHeartbeatAt: new Date(),
        transcript: [{ index: 0, role: 'assistant', content: opening, at: new Date().toISOString() }],
      },
    });
  }

  app.post(
    '/knowledge-interview/:token/text/start',
    { config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      if (!requireConsent(invite, reply)) return;
      if (!isAiConfigured()) return reply.status(503).send({ message: 'The assistant is temporarily unavailable.', code: 'TEXT_UNAVAILABLE' });
      // Switching to text ends any live voice session cleanly (billing stops).
      await closeActiveSessions(invite, { mode: 'VOICE', status: 'COMPLETED' });
      await ensureAgenda(invite);
      const session = await activeTextSession(invite, { create: true });
      if (!session) return reply.status(503).send({ message: 'This interview link is not fully set up.' });
      await markInProgress(invite);
      return reply.send({
        sessionId: session.id,
        messages: (Array.isArray(session.transcript) ? session.transcript : []).map((t) => ({ index: t.index, role: t.role, content: t.content })),
      });
    }
  );

  app.post(
    '/knowledge-interview/:token/text/turn',
    { config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      if (!requireConsent(invite, reply)) return;
      const parsed = textTurnSchema.safeParse(request.body || {});
      if (!parsed.success) return sendZodError(reply, parsed.error);
      if (!isAiConfigured()) return reply.status(503).send({ message: 'The assistant is temporarily unavailable.', code: 'TEXT_UNAVAILABLE' });

      const session = await activeTextSession(invite, { create: true });
      if (!session) return reply.status(503).send({ message: 'This interview link is not fully set up.' });
      // Each turn stores a user and an assistant message.
      const turns = Array.isArray(session.transcript) ? session.transcript.length : 0;
      if (turns >= MAX_TEXT_TURNS_PER_INVITE * 2) {
        return reply.status(429).send({ message: 'This conversation is very long. Please finish, and your team will follow up.', code: 'TEXT_TURN_LIMIT' });
      }

      try {
        const fresh = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: invite.id } });
        const promptOpts = await buildPromptOptions(fresh, {});
        const result = await runTextTurn({ invite: fresh, session, message: parsed.data.message, promptOpts });
        await markInProgress(invite);
        return reply.send({ reply: result.reply, acks: result.acks, finished: result.finished });
      } catch (err) {
        request.log.error({ err: err?.message }, 'Public interview text turn failed');
        return reply.status(502).send({ message: 'The assistant is temporarily unavailable. Please try again.' });
      }
    }
  );

  app.post(
    '/knowledge-interview/:token/text/end',
    { config: { rateLimit: COMPLETE_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      const { closed } = await closeActiveSessions(invite, { mode: 'TEXT', status: 'COMPLETED' });
      return reply.send({ success: true, closed });
    }
  );

  // ── Captures: correct / withdraw (also in summary mode) ───────────────────
  async function loadEditableDraft(request, reply) {
    const resolved = await resolveInvite(request, reply, { allowSummary: true });
    if (!resolved) return null;
    const { invite } = resolved;
    const draft = await prisma.okfDraftChange.findUnique({ where: { id: String(request.params.draftId || '') } });
    const isRoot = invite.respondentRole !== 'STAFF' && (invite.delegationDepth || 0) === 0;
    // Own captures; the root client may also correct its workers' captures (D4).
    const allowed = draft && (draft.inviteId === invite.id || (isRoot && draft.rootInviteId === invite.id));
    if (!allowed) {
      reply.status(404).send({ message: 'Capture not found' });
      return null;
    }
    if (draft.status !== 'PENDING') {
      reply.status(409).send({ message: 'This item has already been reviewed by the team and can no longer be changed here.', code: 'ALREADY_REVIEWED' });
      return null;
    }
    return { invite, draft };
  }

  app.post(
    '/knowledge-interview/:token/captures/:draftId/correct',
    { config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const ctx = await loadEditableDraft(request, reply);
      if (!ctx) return;
      const { invite, draft } = ctx;
      const parsed = correctSchema.safeParse(request.body || {});
      if (!parsed.success) return sendZodError(reply, parsed.error);
      const meta = { ...(draft.proposedMetadata || {}) };
      const correction = {
        corrected_at: new Date().toISOString(),
        corrected_by: invite.recipientName || null,
        corrected_by_role: invite.respondentRole === 'STAFF' ? 'STAFF' : 'CLIENT',
      };
      let proposedBody = draft.proposedBody;

      if (meta.change && parsed.data.newValue) {
        let current = null;
        try {
          current = readOkfFile(draft.clientId, draft.folder, draft.filename);
        } catch {
          current = null;
        }
        proposedBody = applyChangeToBody(current?.body || '', {
          field: meta.change.field,
          oldValue: meta.change.old_value,
          newValue: parsed.data.newValue,
          effectiveFrom: meta.change.effective_from,
        }).body;
        meta.change = { ...meta.change, new_value: parsed.data.newValue, client_confirmed: true };
      } else if (parsed.data.content) {
        proposedBody = parsed.data.content;
        // A merged draft is re-merged by consolidation from the corrected fragment.
        delete meta.capture_fragment;
        delete meta.merged_into_current;
      } else {
        return reply.status(400).send({ message: 'Nothing to correct' });
      }
      meta.client_correction = correction;

      const updated = await prisma.okfDraftChange.update({
        where: { id: draft.id },
        data: {
          proposedBody,
          proposedMetadata: meta,
          clientCorrected: true,
          ...(parsed.data.title ? { title: parsed.data.title } : {}),
          ...(meta.change ? { changeSummary: `${meta.change.field}: ${meta.change.old_value || '(not on file)'} → ${meta.change.new_value}`.slice(0, 500) } : {}),
          dedupeHash: null,
          sourceQuote: draft.sourceQuote,
        },
      });
      // Re-run consolidation for the session so risk/merge reflect the correction.
      if (draft.sessionId) {
        await prisma.voiceInterviewSession.updateMany({
          where: { id: draft.sessionId, consolidationStatus: { in: ['DONE', 'FAILED'] } },
          data: { consolidationStatus: 'PENDING' },
        });
      }
      return reply.send({ success: true, capture: { id: updated.id, title: updated.title, status: updated.status, clientCorrected: true } });
    }
  );

  app.post(
    '/knowledge-interview/:token/captures/:draftId/retract',
    { config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const ctx = await loadEditableDraft(request, reply);
      if (!ctx) return;
      await prisma.okfDraftChange.update({
        where: { id: ctx.draft.id },
        data: { status: 'REJECTED', reviewedAt: new Date(), reviewNote: 'Withdrawn by respondent' },
      });
      return reply.send({ success: true });
    }
  );

  // ── Delegation (root respondent only, D1) ─────────────────────────────────
  app.post(
    '/knowledge-interview/:token/delegate',
    { config: { rateLimit: DELEGATE_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      if (invite.respondentRole === 'STAFF' || (invite.delegationDepth || 0) > 0) {
        return reply.status(403).send({ message: 'Only the person who received the original invite can hand questions to a colleague.', code: 'DELEGATION_FORBIDDEN' });
      }
      const parsed = delegateSchema.safeParse(request.body || {});
      if (!parsed.success) return sendZodError(reply, parsed.error);
      await ensureAgenda(invite);
      try {
        const res = await createDelegation({
          root: invite,
          workerName: parsed.data.workerName,
          workerEmail: parsed.data.workerEmail,
          workerRole: parsed.data.workerRole || null,
          reason: parsed.data.reason,
          questionIds: parsed.data.questionIds,
          topicSummary: parsed.data.topicSummary || '',
          viaSpeech: false,
        });
        return reply.status(201).send({ childInviteId: res.child.id, status: res.child.status, clusterSize: res.clusterSize, sent: res.sent ?? null });
      } catch (err) {
        return delegationErrorReply(reply, err);
      }
    }
  );

  app.post(
    '/knowledge-interview/:token/delegations/:childId/confirm',
    { config: { rateLimit: DELEGATE_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      const parsed = confirmSchema.safeParse(request.body || undefined);
      if (!parsed.success) return sendZodError(reply, parsed.error);
      try {
        const res = await confirmDelegation({
          root: invite,
          childId: request.params.childId,
          workerEmail: parsed.data?.workerEmail || null,
          workerName: parsed.data?.workerName || null,
        });
        return reply.send({ success: true, status: res.child.status, sent: res.sent, error: res.error });
      } catch (err) {
        return delegationErrorReply(reply, err);
      }
    }
  );

  app.post(
    '/knowledge-interview/:token/delegations/:childId/cancel',
    { config: { rateLimit: DELEGATE_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      try {
        const res = await cancelDelegation({ root: invite, childId: request.params.childId, reason: 'cancelled by respondent' });
        return reply.send({ success: true, status: res.child.status });
      } catch (err) {
        return delegationErrorReply(reply, err);
      }
    }
  );

  // "Not you?" — POST (not GET) so email link scanners cannot decline by prefetching.
  app.post(
    '/knowledge-interview/:token/decline',
    { config: { rateLimit: CONSENT_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      try {
        await declineDelegation(invite);
        return reply.send({ success: true });
      } catch (err) {
        return delegationErrorReply(reply, err);
      }
    }
  );

  // ── Finish ────────────────────────────────────────────────────────────────
  app.post(
    '/knowledge-interview/:token/finish',
    { config: { rateLimit: FINISH_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;
      const parsed = finishSchema.safeParse(request.body || undefined);
      if (!parsed.success) return sendZodError(reply, parsed.error);

      await closeActiveSessions(invite, { status: 'COMPLETED' });
      // A speech delegation the client never confirmed is dropped (plan §19).
      const unconfirmed = await prisma.knowledgeInterviewInvite.findMany({
        where: { parentInviteId: invite.id, status: 'PENDING_CONFIRM' },
        select: { id: true },
      });
      for (const c of unconfirmed) await cancelDelegation({ root: invite, childId: c.id, reason: 'unconfirmed' }).catch(() => {});

      const claimed = await prisma.knowledgeInterviewInvite.updateMany({
        where: { id: invite.id, status: { notIn: TERMINAL_STATUSES } },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      if (claimed.count !== 1) return reply.send({ success: true, alreadyCompleted: true });

      // Sessions with drafts that were never queued (e.g. text) get consolidated by the scheduler.
      const sessions = await prisma.voiceInterviewSession.findMany({ where: { inviteId: invite.id, consolidationStatus: 'NONE' }, select: { id: true } });
      for (const s of sessions) {
        const n = await prisma.okfDraftChange.count({ where: { sessionId: s.id, status: 'PENDING' } });
        if (n > 0) await prisma.voiceInterviewSession.update({ where: { id: s.id }, data: { consolidationStatus: 'PENDING' } });
      }
      if (parsed.data?.summary) {
        await prisma.knowledgeInterviewInvite.update({
          where: { id: invite.id },
          data: { draftData: { ...(invite.draftData || {}), closingNote: parsed.data.summary } },
        }).catch(() => {});
      }
      await logDispatch({ inviteId: invite.id, kind: 'FINISH', detail: invite.respondentRole });

      const [draftCount, client] = await Promise.all([
        prisma.okfDraftChange.count({ where: { inviteId: invite.id, status: 'PENDING' } }),
        prisma.clientAccount.findUnique({ where: { id: invite.clientId }, select: { agencyName: true } }),
      ]);
      try {
        const { notify } = await import('../lib/notificationService.js');
        await notify({
          slug: 'interview_completed_staff',
          recipientIds: await staffRecipientIds(invite.clientId),
          variables: {
            clientName: client?.agencyName || 'a client',
            respondentName: invite.recipientName || 'The respondent',
            draftCount: String(draftCount),
          },
          actionUrl: `/portal/pm/okf-review?inviteId=${invite.id}`,
          metadata: { inviteId: invite.id },
        });
      } catch {
        // Notifications are best-effort.
      }
      return reply.send({ success: true, draftCount });
    }
  );

  // ── Summary (root sees its workers' answers in full, D4) ──────────────────
  app.get(
    '/knowledge-interview/:token/summary',
    { config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const resolved = await resolveInvite(request, reply, { allowSummary: true });
      if (!resolved) return;
      const { invite, summaryMode } = resolved;
      const [captured, delegations] = await Promise.all([capturesFor(invite), delegationsFor(invite)]);
      return reply.send({
        mode: summaryMode ? 'summary' : 'interview',
        captured,
        delegations,
        openQuestions: openQuestions(invite.agenda).map((q) => q.topic || q.prompt).slice(0, 12),
        transcripts: await transcriptsFor(invite),
      });
    }
  );

  // ── Legacy text interview (kept for pages already open; unchanged) ────────
  app.post(
    '/knowledge-interview/:token/chat',
    { config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;

      if (!isAiConfigured()) {
        return reply.status(503).send({ message: 'The assistant is temporarily unavailable.' });
      }

      const { message, history, currentData } = request.body || {};
      if (typeof message !== 'string' || !Array.isArray(history)) {
        return reply.status(400).send({ message: 'Invalid request' });
      }

      try {
        const { parsed } = await generateChat({
          system: SYSTEM_PROMPT,
          messages: [
            ...history.slice(-60).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content || '').slice(0, 4000) })),
            {
              role: 'user',
              content: `Current extracted state: ${JSON.stringify(currentData || {})}\nLatest user message: ${message.slice(0, 4000)}`,
            },
          ],
          json: true,
          maxTokens: 1024,
          feature: 'knowledge_interview_public',
          clientId: invite.clientId,
        });

        const result = parsed || {
          nextQuestion: "Thanks. Could you tell me a bit more about who your ideal customer is?",
          extractedData: currentData,
          isFinished: false,
        };

        // Persist progress so a closed tab does not lose the conversation.
        await prisma.knowledgeInterviewInvite
          .update({
            where: { id: invite.id },
            data: { draftData: result.extractedData ?? currentData, status: 'IN_PROGRESS' },
          })
          .catch(() => {});

        return reply.send(result);
      } catch (err) {
        request.log.error({ err: err?.message }, 'Public knowledge interview turn failed');
        return reply.status(502).send({ message: 'The assistant is temporarily unavailable.' });
      }
    }
  );

  app.post(
    '/knowledge-interview/:token/submit',
    { config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const invite = await resolveActive(request, reply);
      if (!invite) return;

      const data = request.body?.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return reply.status(400).send({ message: 'Invalid request' });
      }

      const body = Object.entries(data)
        .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
        .map(([k, v]) => {
          const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
          return `### ${label}\n\n${Array.isArray(v) ? v.join(', ') : v}\n`;
        })
        .join('\n');

      await prisma.$transaction([
        // IntakeSubmission requires a submitter, and there is no logged-in user
        // here, so the answers are attributed to the admin who sent the invite.
        ...(invite.createdById
          ? [
            prisma.intakeSubmission.create({
              data: {
                clientId: invite.clientId,
                projectId: invite.projectId,
                submittedById: invite.createdById,
                data,
              },
            }),
          ]
          : []),
        prisma.okfDraftChange.create({
          data: {
            clientId: invite.clientId,
            folder: 'company',
            filename: `interview-${new Date().toISOString().slice(0, 10)}`,
            title: 'Knowledge interview',
            proposedMetadata: {
              type: 'client-interview',
              title: 'Knowledge interview',
              source: 'INTERVIEW_LINK',
              respondent: invite.recipientName || null,
              captured_at: new Date().toISOString(),
            },
            proposedBody: `# Knowledge interview\n\n${body}`,
            sourceType: 'INTERVIEW_LINK',
            status: 'PENDING',
            inviteId: invite.id,
            rootInviteId: invite.rootInviteId || invite.id,
            respondentRole: invite.respondentRole || 'CLIENT',
            respondentName: invite.recipientName || null,
          },
        }),
        prisma.knowledgeInterviewInvite.update({
          where: { id: invite.id },
          data: { status: 'COMPLETED', completedAt: new Date(), draftData: data },
        }),
      ]);

      return reply.send({ success: true });
    }
  );
}

export default publicKnowledgeInterviewRoutes;
