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

/** Seconds added after the last heartbeat (heartbeats arrive every 20 s). */
export const HEARTBEAT_GRACE_SECONDS = 30;
/** Every voice session that was minted is charged at least this much. */
export const MIN_CHARGE_SECONDS = 30;

/**
 * Seconds to bill for a voice session (review fix H1). The browser cannot
 * lower the bill: we take the LARGEST of the server wall-clock span, the
 * client-reported duration and the heartbeat span, then cap at the session
 * maximum. Text is never billed.
 *
 *  - reaped=false (complete/abandon called by the browser): max(server span,
 *    client, heartbeat span + grace).
 *  - reaped=true (reaper, or a new mint/finish closing a dead tab): the
 *    heartbeat span + grace when a post-mint heartbeat arrived; otherwise the
 *    full server span (a client that never heartbeats pays wall-clock time).
 */
export function billedSeconds(session, { clientSeconds = null, now = new Date(), reaped = false } = {}) {
  if (session.mode !== 'VOICE') return 0;
  const started = new Date(session.startedAt).getTime();
  const serverSpan = Math.max(0, Math.round((now.getTime() - started) / 1000));
  const hb = session.lastHeartbeatAt ? new Date(session.lastHeartbeatAt).getTime() : null;
  const hbSpan = hb !== null ? Math.max(0, Math.round((hb - started) / 1000)) + HEARTBEAT_GRACE_SECONDS : 0;
  const client = Number.isFinite(clientSeconds) && clientSeconds > 0 ? Math.round(clientSeconds) : 0;
  let billed;
  if (reaped) billed = hb !== null ? Math.min(hbSpan, serverSpan) : serverSpan;
  else billed = Math.max(serverSpan, client, hbSpan);
  return Math.min(Math.max(billed, MIN_CHARGE_SECONDS), MAX_SESSION_SECONDS);
}

/**
 * Ends a session and charges it to the invite. Uses a CAS on status so a
 * double "complete" (or the reaper racing the browser) bills once.
 * @returns {Promise<{billed:number, closed:boolean}>}
 */
export async function closeSession(session, { status = 'COMPLETED', clientSeconds = null, summary = null, usage = null, now = new Date(), reaped = false } = {}) {
  const billed = billedSeconds(session, { clientSeconds, now, reaped });
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
    // Nobody reported this session's end: bill it like the reaper would.
    const r = await closeSession(s, { status, now, reaped: true });
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
