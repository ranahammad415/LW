/**
 * Live voice minute accounting, shared by the portal voice agent
 * (routes/client/voiceAgent.js) and public interview links
 * (routes/publicKnowledgeInterview.js).
 *
 * Limits come from the interview settings (owner decision D5): client override
 * → agency default → VOICE_AGENT_MONTHLY_MINUTES_PER_CLIENT env fallback.
 * Delegated (worker) sessions are VoiceInterviewSession rows on the same
 * clientId, so they count toward the same monthly cap (decision D3).
 *
 * Only mode VOICE sessions count. Text interviews have no audio cost.
 */
import { prisma } from './prisma.js';
import { resolveInterviewSettings } from './interviewSettings.js';

// Sessions older than this that never reported completion are treated as dead
// so a crashed tab can't permanently occupy a concurrency slot.
export const STALE_SESSION_MS = 60 * 60 * 1000;

export function startOfMonth(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export async function getUsage(clientId, { settings = null } = {}) {
  const effective = settings || (await resolveInterviewSettings(clientId));
  const limit = effective.monthlyMinutesPerClient;

  const [monthAgg, activeSessions] = await Promise.all([
    prisma.voiceInterviewSession.aggregate({
      where: { clientId, mode: 'VOICE', startedAt: { gte: startOfMonth() } },
      _sum: { durationSeconds: true },
    }),
    prisma.voiceInterviewSession.count({
      where: {
        clientId,
        mode: 'VOICE',
        status: 'ACTIVE',
        startedAt: { gte: new Date(Date.now() - STALE_SESSION_MS) },
      },
    }),
  ]);

  const usedSeconds = monthAgg._sum.durationSeconds || 0;
  const usedMinutes = Math.round(usedSeconds / 60);
  return {
    usedSeconds,
    usedMinutes,
    remainingMinutes: Math.max(0, limit - usedMinutes),
    remainingSeconds: Math.max(0, limit * 60 - usedSeconds),
    monthlyLimitMinutes: limit,
    activeSessions,
  };
}

/** Agency-wide voice minutes this month against the agency cap. */
export async function getAgencyUsage({ settings = null } = {}) {
  const effective = settings || (await resolveInterviewSettings(null));
  const agg = await prisma.voiceInterviewSession.aggregate({
    where: { mode: 'VOICE', startedAt: { gte: startOfMonth() } },
    _sum: { durationSeconds: true },
  });
  const usedSeconds = agg._sum.durationSeconds || 0;
  const limit = effective.agencyMonthlyMinutes;
  return {
    usedSeconds,
    usedMinutes: Math.round(usedSeconds / 60),
    limitMinutes: limit,
    remainingSeconds: Math.max(0, limit * 60 - usedSeconds),
  };
}

/** Per-client usage for the admin budget card. */
export async function getUsageByClient() {
  const rows = await prisma.voiceInterviewSession.groupBy({
    by: ['clientId'],
    where: { mode: 'VOICE', startedAt: { gte: startOfMonth() } },
    _sum: { durationSeconds: true },
  });
  return rows.map((r) => ({ clientId: r.clientId, usedSeconds: r._sum.durationSeconds || 0 }));
}

export function costPerMinuteUsd() {
  const n = Number(process.env.INTERVIEW_COST_PER_MINUTE_USD || 0.12);
  return Number.isFinite(n) && n >= 0 ? n : 0.12;
}
