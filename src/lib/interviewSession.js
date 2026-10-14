/**
 * Helpers shared by the public interview routes for both voice and text
 * sessions: attribution, billing, digest refresh and prompt options.
 */
import { prisma } from './prisma.js';
import { buildKnowledgeDigest, contextMaxChars } from './interviewKnowledge.js';
import { respondentAllowFolders } from './interviewCapture.js';
import { MAX_SESSION_SECONDS, REALTIME_MODEL } from './realtimeVoice.js';
import { agencyDisplayName } from './interviewEmail.js';

/**
 * VoiceInterviewSession.userId is NOT NULL but public respondents have no
 * User row (plan §1 item 1): attribute to the invite's creator, falling back
 * to any active owner for legacy invites without a creator.
 */
export async function attributionUserId(invite) {
  if (invite.createdById) return invite.createdById;
  const owner = await prisma.user.findFirst({ where: { role: 'OWNER', isActive: true }, select: { id: true } });
  return owner?.id || null;
}

/** Seconds left on the invite's own minute budget. */
export function inviteRemainingSeconds(invite) {
  return Math.max(0, (Number(invite.minutesBudget) || 0) * 60 - (Number(invite.totalVoiceSeconds) || 0));
}

/** Plan §9: bill min(server span, client-reported, max). Text is never billed. */
export function billedSeconds(session, { clientSeconds = null, now = new Date() } = {}) {
  if (session.mode !== 'VOICE') return 0;
  const server = Math.max(0, Math.round((now.getTime() - new Date(session.startedAt).getTime()) / 1000));
  const client = Number.isFinite(clientSeconds) && clientSeconds > 0 ? Math.round(clientSeconds) : server;
  return Math.min(server, client, MAX_SESSION_SECONDS);
}

/**
 * Ends a session and charges it to the invite. Uses a CAS on status so a
 * double "complete" (or the reaper racing the browser) bills once.
 * @returns {Promise<{billed:number, closed:boolean}>}
 */
export async function closeSession(session, { status = 'COMPLETED', clientSeconds = null, summary = null, usage = null, now = new Date() } = {}) {
  const billed = billedSeconds(session, { clientSeconds, now });
  const draftCount = await prisma.okfDraftChange.count({ where: { sessionId: session.id } });
  const res = await prisma.voiceInterviewSession.updateMany({
    where: { id: session.id, status: 'ACTIVE' },
    data: {
      status,
      endedAt: now,
      durationSeconds: billed,
      ...(summary ? { summary: String(summary).slice(0, 4000) } : {}),
      ...(usage ? { usage } : {}),
      ...(draftCount > 0 ? { consolidationStatus: 'PENDING' } : {}),
    },
  });
  if (res.count !== 1) return { billed: 0, closed: false };
  if (session.inviteId && billed > 0) {
    await prisma.knowledgeInterviewInvite.update({
      where: { id: session.inviteId },
      data: { totalVoiceSeconds: { increment: billed } },
    });
  }
  if (usage && session.mode === 'VOICE') await logRealtimeUsage(session, usage);
  return { billed, closed: true };
}

/** Closes every ACTIVE session of an invite (resume, mode switch, finish). */
export async function closeActiveSessions(invite, { mode = null, status = 'ABANDONED', now = new Date() } = {}) {
  const active = await prisma.voiceInterviewSession.findMany({
    where: { inviteId: invite.id, status: 'ACTIVE', ...(mode ? { mode } : {}) },
  });
  let billed = 0;
  for (const s of active) {
    // An abandoned voice tab is billed up to its last heartbeat.
    const until = s.mode === 'VOICE' && s.lastHeartbeatAt ? new Date(s.lastHeartbeatAt) : now;
    const r = await closeSession(s, { status, now: until });
    billed += r.billed;
  }
  return { closed: active.length, billed };
}

/**
 * Realtime token usage, best effort (plan §12): one AiUsageLog row per voice
 * session with feature interview_realtime_voice.
 */
export async function logRealtimeUsage(session, usage) {
  try {
    const tokensIn = Number(usage?.input_tokens ?? usage?.inputTokens ?? 0) || 0;
    const tokensOut = Number(usage?.output_tokens ?? usage?.outputTokens ?? 0) || 0;
    await prisma.aiUsageLog.create({
      data: {
        model: String(session.model || REALTIME_MODEL).slice(0, 100),
        feature: 'interview_realtime_voice',
        userId: session.userId || null,
        clientId: session.clientId,
        tokensIn: Math.min(tokensIn, 2_000_000_000),
        tokensOut: Math.min(tokensOut, 2_000_000_000),
        latencyMs: 0,
        success: true,
      },
    });
  } catch {
    // Observability must never break the request.
  }
}

/**
 * Returns the knowledge digest for this respondent, rebuilding it when an
 * OkfVersion newer than agenda.digestAt exists (plan §21 a).
 */
export async function ensureDigest(invite) {
  const agenda = invite.agenda && typeof invite.agenda === 'object' ? invite.agenda : {};
  let latest = null;
  try {
    latest = await prisma.okfVersion.findFirst({
      where: { clientId: invite.clientId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
  } catch {
    latest = null;
  }
  const digestAt = agenda.digestAt ? Date.parse(agenda.digestAt) : 0;
  const fresh = agenda.knowledgeDigest && (!latest || latest.createdAt.getTime() <= digestAt);
  if (fresh) return agenda.knowledgeDigest;

  const { text, digestAt: at } = buildKnowledgeDigest(invite.clientId, {
    folders: respondentAllowFolders(invite),
    maxChars: contextMaxChars(),
  });
  // Re-read so we don't clobber concurrent agenda progress.
  const row = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: invite.id }, select: { agenda: true } });
  await prisma.knowledgeInterviewInvite.update({
    where: { id: invite.id },
    data: { agenda: { ...(row?.agenda || agenda), knowledgeDigest: text, digestAt: at } },
  });
  return text;
}

/** Name of the person who delegated to this worker (for prompts and the page). */
export async function delegatorName(invite) {
  if (!invite.parentInviteId) return null;
  const parent = await prisma.knowledgeInterviewInvite.findUnique({
    where: { id: invite.parentInviteId },
    select: { recipientName: true },
  });
  return parent?.recipientName || null;
}

/** Options for buildPublicInterviewInstructions / buildTextSystemPrompt. */
export async function buildPromptOptions(invite, { remainingSeconds = null, isResume = false } = {}) {
  const [client, agencyName, digest, captured, delegator, fresh] = await Promise.all([
    prisma.clientAccount.findUnique({ where: { id: invite.clientId }, select: { agencyName: true } }),
    agencyDisplayName(),
    ensureDigest(invite),
    prisma.okfDraftChange.findMany({
      where: { inviteId: invite.id, status: { not: 'REJECTED' } },
      select: { folder: true, filename: true, title: true },
      orderBy: { createdAt: 'asc' },
      take: 60,
    }),
    delegatorName(invite),
    prisma.knowledgeInterviewInvite.findUnique({ where: { id: invite.id }, select: { agenda: true } }),
  ]);
  const isWorker = invite.respondentRole === 'STAFF';
  return {
    agencyName,
    businessName: client?.agencyName || 'the business',
    respondent: {
      role: isWorker ? 'STAFF' : 'CLIENT',
      name: invite.recipientName || null,
      jobRole: invite.respondentJobRole || null,
      delegatorName: delegator,
    },
    agenda: fresh?.agenda || invite.agenda,
    knowledgeDigest: digest,
    capturedSoFar: captured,
    remainingMinutes: remainingSeconds !== null ? remainingSeconds / 60 : null,
    language: invite.language || 'en',
    canDelegate: !isWorker && (invite.delegationDepth || 0) === 0,
    isResume,
  };
}
