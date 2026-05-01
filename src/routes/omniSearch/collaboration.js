import { prisma } from '../../lib/prisma.js';

export default async function collaborationRoutes(app) {
  app.addHook('onRequest', async (request, reply) => {
    await app.omniSearchAuth(request, reply);
  });

  // ── GET /collaboration/versions — List content versions for a session ─────
  app.get('/collaboration/versions', async (request, reply) => {
    try {
      const { sessionId, page = 1, limit = 20 } = request.query;
      if (!sessionId) return reply.code(400).send({ success: false, error: 'sessionId is required' });

      const where = { sessionId: Number(sessionId) };
      const skip = (Number(page) - 1) * Number(limit);

      const [versions, total] = await Promise.all([
        prisma.omniSearchContentVersion.findMany({
          where,
          skip,
          take: Number(limit),
          orderBy: { savedAt: 'desc' },
        }),
        prisma.omniSearchContentVersion.count({ where }),
      ]);

      return { success: true, data: { versions, total, page: Number(page), limit: Number(limit) } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /collaboration/versions/:id — Get single version ──────────────────
  app.get('/collaboration/versions/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const version = await prisma.omniSearchContentVersion.findUnique({ where: { id: Number(id) } });
      if (!version) return reply.code(404).send({ success: false, error: 'Version not found' });
      return { success: true, data: version };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /collaboration/diff — Compare two versions ────────────────────────
  app.get('/collaboration/diff', async (request, reply) => {
    try {
      const { versionA, versionB } = request.query;
      if (!versionA || !versionB) {
        return reply.code(400).send({ success: false, error: 'versionA and versionB are required' });
      }

      const [a, b] = await Promise.all([
        prisma.omniSearchContentVersion.findUnique({ where: { id: Number(versionA) } }),
        prisma.omniSearchContentVersion.findUnique({ where: { id: Number(versionB) } }),
      ]);

      if (!a) return reply.code(404).send({ success: false, error: `Version ${versionA} not found` });
      if (!b) return reply.code(404).send({ success: false, error: `Version ${versionB} not found` });

      const wordCountA = a.wordCount || (a.content ? a.content.split(/\s+/).length : 0);
      const wordCountB = b.wordCount || (b.content ? b.content.split(/\s+/).length : 0);

      return {
        success: true,
        data: {
          versionA: { id: a.id, score: a.score, wordCount: wordCountA, savedAt: a.savedAt, changeNote: a.changeNote },
          versionB: { id: b.id, score: b.score, wordCount: wordCountB, savedAt: b.savedAt, changeNote: b.changeNote },
          diff: {
            wordCountChange: wordCountB - wordCountA,
            scoreChange: (b.score || 0) - (a.score || 0),
            contentLengthChange: (b.content?.length || 0) - (a.content?.length || 0),
          },
        },
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /collaboration/writer-stats — Aggregate writing stats ─────────────
  app.get('/collaboration/writer-stats', async (request, reply) => {
    try {
      const { days = 30 } = request.query;
      const since = new Date();
      since.setDate(since.getDate() - Number(days));

      const [totalSessions, totalVersions, versions, articles] = await Promise.all([
        prisma.omniSearchContentSession.count({ where: { createdAt: { gte: since } } }),
        prisma.omniSearchContentVersion.count({ where: { savedAt: { gte: since } } }),
        prisma.omniSearchContentVersion.findMany({
          where: { savedAt: { gte: since } },
          select: { sessionId: true, score: true },
          orderBy: { savedAt: 'asc' },
        }),
        prisma.omniSearchArticle.count({ where: { createdAt: { gte: since } } }),
      ]);

      // Calculate average score improvement per session
      const sessionScores = {};
      for (const v of versions) {
        if (!sessionScores[v.sessionId]) sessionScores[v.sessionId] = [];
        if (v.score !== null) sessionScores[v.sessionId].push(v.score);
      }

      let totalImprovement = 0;
      let sessionsWithImprovement = 0;
      for (const scores of Object.values(sessionScores)) {
        if (scores.length >= 2) {
          totalImprovement += scores[scores.length - 1] - scores[0];
          sessionsWithImprovement++;
        }
      }

      const avgScoreImprovement = sessionsWithImprovement > 0
        ? Math.round((totalImprovement / sessionsWithImprovement) * 100) / 100
        : 0;

      return {
        success: true,
        data: {
          stats: {
            totalSessions,
            totalVersions,
            avgScoreImprovement,
            articlesGenerated: articles,
          },
        },
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });
}
