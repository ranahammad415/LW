/**
 * Realtime voice business agent.
 *
 * The browser connects to OpenAI over WebRTC directly, but only ever holds an
 * ephemeral client secret minted here. Facts the agent captures land in
 * OkfDraftChange for human review — nothing is written to OKF from this route.
 */
import { prisma } from '../../lib/prisma.js';
import { resolvePrimaryClientId } from '../../lib/clientContext.js';
import {
  isRealtimeVoiceConfigured,
  buildInterviewInstructions,
  mintRealtimeSession,
  REALTIME_TOOLS,
  REALTIME_MODEL,
  MAX_SESSION_SECONDS,
  MONTHLY_MINUTES_PER_CLIENT,
} from '../../lib/realtimeVoice.js';

const MAX_CONCURRENT_SESSIONS_PER_CLIENT = 2;
// Sessions older than this that never reported completion are treated as dead
// so a crashed tab can't permanently occupy a concurrency slot.
const STALE_SESSION_MS = 60 * 60 * 1000;

function startOfMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

async function getUsage(clientId) {
  const [monthAgg, activeSessions] = await Promise.all([
    prisma.voiceInterviewSession.aggregate({
      where: { clientId, startedAt: { gte: startOfMonth() } },
      _sum: { durationSeconds: true },
    }),
    prisma.voiceInterviewSession.count({
      where: {
        clientId,
        status: 'ACTIVE',
        startedAt: { gte: new Date(Date.now() - STALE_SESSION_MS) },
      },
    }),
  ]);

  const usedSeconds = monthAgg._sum.durationSeconds || 0;
  return {
    usedMinutes: Math.round(usedSeconds / 60),
    remainingMinutes: Math.max(0, MONTHLY_MINUTES_PER_CLIENT - Math.round(usedSeconds / 60)),
    monthlyLimitMinutes: MONTHLY_MINUTES_PER_CLIENT,
    activeSessions,
  };
}

export async function clientVoiceAgentRoutes(app) {
  // ── Usage + availability, for the UI to render before starting ────────────
  app.get(
    '/voice-agent/status',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const clientId = resolvePrimaryClientId(request);
      if (!clientId) return reply.status(403).send({ message: 'No client account linked' });

      const usage = await getUsage(clientId);
      return reply.send({
        configured: isRealtimeVoiceConfigured(),
        maxSessionSeconds: MAX_SESSION_SECONDS,
        model: REALTIME_MODEL,
        ...usage,
      });
    }
  );

  // ── Mint an ephemeral session ─────────────────────────────────────────────
  app.post(
    '/voice-agent/session',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
      schema: {
        body: {
          type: 'object',
          properties: { projectId: { type: 'string', nullable: true } },
        },
      },
    },
    async (request, reply) => {
      const clientId = resolvePrimaryClientId(request);
      if (!clientId) return reply.status(403).send({ message: 'No client account linked' });

      if (!isRealtimeVoiceConfigured()) {
        return reply.status(503).send({
          message: 'Live voice interviews are not configured. Set OPENAI_API_KEY in your .env file.',
        });
      }

      const usage = await getUsage(clientId);
      if (usage.remainingMinutes <= 0) {
        return reply.status(429).send({
          message: `You have used all ${MONTHLY_MINUTES_PER_CLIENT} live voice minutes for this month. Please use the text or recorded voice interview instead.`,
          code: 'VOICE_MONTHLY_LIMIT',
          ...usage,
        });
      }
      if (usage.activeSessions >= MAX_CONCURRENT_SESSIONS_PER_CLIENT) {
        return reply.status(429).send({
          message: 'Another live interview is already running for your account. End it before starting a new one.',
          code: 'VOICE_CONCURRENCY_LIMIT',
          ...usage,
        });
      }

      const client = await prisma.clientAccount.findUnique({
        where: { id: clientId },
        select: { id: true, agencyName: true, websiteUrl: true, industry: true },
      });
      if (!client) return reply.status(404).send({ message: 'Client not found' });

      let minted;
      try {
        const instructions = buildInterviewInstructions({
          clientId,
          agencyName: client.agencyName,
          websiteUrl: client.websiteUrl,
          industry: client.industry,
        });
        minted = await mintRealtimeSession({
          instructions,
          tools: REALTIME_TOOLS,
          userId: request.user.id,
        });
      } catch (err) {
        request.log.error({ err }, 'Failed to mint realtime voice session');
        return reply.status(502).send({ message: err.message || 'Could not start the voice session.' });
      }

      const session = await prisma.voiceInterviewSession.create({
        data: {
          clientId,
          projectId: request.body?.projectId || null,
          userId: request.user.id,
          status: 'ACTIVE',
          model: minted.model,
        },
      });

      return reply.send({
        sessionId: session.id,
        clientSecret: minted.clientSecret,
        expiresAt: minted.expiresAt,
        model: minted.model,
        voice: minted.voice,
        maxSessionSeconds: MAX_SESSION_SECONDS,
        remainingMinutes: usage.remainingMinutes,
      });
    }
  );

  // ── Persist the finished interview and queue its facts for review ─────────
  app.post(
    '/voice-agent/complete',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
      schema: {
        body: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            durationSeconds: { type: 'integer', minimum: 0 },
            summary: { type: 'string' },
            transcript: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string' },
                  content: { type: 'string' },
                  at: { type: 'string' },
                },
              },
            },
            facts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  folder: { type: 'string' },
                  filename: { type: 'string' },
                  title: { type: 'string' },
                  content: { type: 'string' },
                  confidence: { type: 'number' },
                },
                required: ['folder', 'filename', 'content'],
              },
            },
            gaps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  category: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['category', 'description'],
              },
            },
          },
          required: ['sessionId'],
        },
      },
    },
    async (request, reply) => {
      const clientId = resolvePrimaryClientId(request);
      if (!clientId) return reply.status(403).send({ message: 'No client account linked' });

      const {
        sessionId,
        durationSeconds = 0,
        summary = null,
        transcript = [],
        facts = [],
        gaps = [],
      } = request.body;

      const session = await prisma.voiceInterviewSession.findUnique({ where: { id: sessionId } });
      if (!session || session.clientId !== clientId) {
        return reply.status(404).send({ message: 'Voice session not found' });
      }
      if (session.status !== 'ACTIVE') {
        return reply.status(409).send({ message: 'This voice session has already been completed.' });
      }

      // Trust the wall-clock server span over the client-reported duration when
      // the client under-reports, since minutes are billed and capped.
      const serverSeconds = Math.round((Date.now() - session.startedAt.getTime()) / 1000);
      const billedSeconds = Math.min(
        Math.max(durationSeconds, 0) || serverSeconds,
        MAX_SESSION_SECONDS
      );

      const draftRows = facts
        .filter((f) => String(f.content || '').trim().length > 0)
        .map((f) => ({
          clientId,
          sessionId: session.id,
          folder: String(f.folder).slice(0, 255),
          filename: String(f.filename).replace(/\.md$/, '').slice(0, 255),
          title: String(f.title || f.filename).slice(0, 255),
          proposedMetadata: {
            type: 'voice-capture',
            title: f.title || f.filename,
            source: 'VOICE_AGENT',
            captured_at: new Date().toISOString(),
          },
          proposedBody: String(f.content),
          sourceType: 'VOICE_AGENT',
          confidence: typeof f.confidence === 'number' ? f.confidence : null,
          status: 'PENDING',
        }));

      await prisma.$transaction([
        prisma.voiceInterviewSession.update({
          where: { id: session.id },
          data: {
            status: 'COMPLETED',
            endedAt: new Date(),
            durationSeconds: billedSeconds,
            transcript: transcript.length ? transcript : undefined,
            extractedData: { facts, gaps },
            summary: summary ? String(summary).slice(0, 4000) : null,
          },
        }),
        ...(draftRows.length ? [prisma.okfDraftChange.createMany({ data: draftRows })] : []),
      ]);

      // Gaps are advisory notes for the SEO team rather than proposed content,
      // so they go on the activity feed instead of the draft queue.
      if (gaps.length) {
        await prisma.clientActivityLog.create({
          data: {
            clientId,
            userId: request.user.id,
            action: 'VOICE_INTERVIEW_GAPS',
            detail: gaps.map((g) => `${g.category}: ${g.description}`).join(' | ').slice(0, 1000),
            metadata: { sessionId: session.id, gaps },
          },
        }).catch(() => {});
      }

      return reply.send({
        success: true,
        sessionId: session.id,
        durationSeconds: billedSeconds,
        draftsQueued: draftRows.length,
        gapsFlagged: gaps.length,
      });
    }
  );

  // ── Abandon a session that never produced anything ────────────────────────
  app.post(
    '/voice-agent/abandon',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        body: {
          type: 'object',
          properties: { sessionId: { type: 'string' } },
          required: ['sessionId'],
        },
      },
    },
    async (request, reply) => {
      const clientId = resolvePrimaryClientId(request);
      if (!clientId) return reply.status(403).send({ message: 'No client account linked' });

      const session = await prisma.voiceInterviewSession.findUnique({
        where: { id: request.body.sessionId },
      });
      if (!session || session.clientId !== clientId) {
        return reply.status(404).send({ message: 'Voice session not found' });
      }
      if (session.status !== 'ACTIVE') return reply.send({ success: true });

      await prisma.voiceInterviewSession.update({
        where: { id: session.id },
        data: {
          status: 'ABANDONED',
          endedAt: new Date(),
          durationSeconds: Math.min(
            Math.round((Date.now() - session.startedAt.getTime()) / 1000),
            MAX_SESSION_SECONDS
          ),
        },
      });

      return reply.send({ success: true });
    }
  );

  // ── Past interviews for this client ───────────────────────────────────────
  app.get(
    '/voice-agent/sessions',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const clientId = resolvePrimaryClientId(request);
      if (!clientId) return reply.status(403).send({ message: 'No client account linked' });

      const sessions = await prisma.voiceInterviewSession.findMany({
        where: { clientId },
        orderBy: { startedAt: 'desc' },
        take: 25,
        select: {
          id: true,
          status: true,
          startedAt: true,
          endedAt: true,
          durationSeconds: true,
          summary: true,
          _count: { select: { drafts: true } },
        },
      });

      return reply.send({ sessions });
    }
  );
}
