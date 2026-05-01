import { prisma } from '../../lib/prisma.js';
import { analyzeContent, generateContentBrief } from '../../lib/omniSearch/omniSearchAi.js';
import {
  calculateContentScore,
  calculateReadability,
  analyzeTermFrequency,
} from '../../lib/omniSearch/omniSearchScoring.js';
import { analyzeUrl } from '../../lib/omniSearch/omniSearchCrawler.js';

export default async function contentRoutes(app) {
  // ── Auth guard on all routes ───────────────────────────────────────────────
  app.addHook('onRequest', async (request, reply) => {
    await app.omniSearchAuth(request, reply);
  });

  // ─── 1. POST /content/sessions ───────────────────────────────────────────
  app.post('/content/sessions', async (request, reply) => {
    try {
      const { projectId, targetKeyword, title } = request.body || {};
      if (!projectId || !targetKeyword) {
        return reply.status(400).send({ success: false, error: 'projectId and targetKeyword are required' });
      }

      const session = await prisma.omniSearchContentSession.create({
        data: {
          projectId: Number(projectId),
          targetKeyword,
          title: title || null,
          status: 'draft',
        },
      });

      return { success: true, data: session };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 2. GET /content/sessions ────────────────────────────────────────────
  app.get('/content/sessions', async (request, reply) => {
    try {
      const { projectId, page = 1, limit = 20, status } = request.query;
      const take = Math.min(Number(limit), 100);
      const skip = (Number(page) - 1) * take;

      const where = {};
      if (projectId) where.projectId = Number(projectId);
      if (status) where.status = status;

      const [sessions, total] = await Promise.all([
        prisma.omniSearchContentSession.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          skip,
          take,
          include: {
            project: { select: { id: true, name: true } },
          },
        }),
        prisma.omniSearchContentSession.count({ where }),
      ]);

      return {
        success: true,
        data: {
          sessions,
          total,
          page: Number(page),
          totalPages: Math.ceil(total / take),
        },
      };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 3. GET /content/sessions/:id ────────────────────────────────────────
  app.get('/content/sessions/:id', async (request, reply) => {
    try {
      const session = await prisma.omniSearchContentSession.findUnique({
        where: { id: Number(request.params.id) },
        include: {
          project: { select: { id: true, name: true } },
          versions: { orderBy: { savedAt: 'desc' }, take: 1 },
          articles: { orderBy: { createdAt: 'desc' } },
          _count: { select: { versions: true, articles: true } },
        },
      });
      if (!session) return reply.status(404).send({ success: false, error: 'Session not found' });

      return { success: true, data: session };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 4. PUT /content/sessions/:id ────────────────────────────────────────
  app.put('/content/sessions/:id', async (request, reply) => {
    try {
      const id = Number(request.params.id);
      const { content, title } = request.body || {};

      const session = await prisma.omniSearchContentSession.findUnique({ where: { id } });
      if (!session) return reply.status(404).send({ success: false, error: 'Session not found' });

      const updateData = {};
      if (title !== undefined) updateData.title = title;

      if (content !== undefined) {
        updateData.content = content;

        // Auto-calculate scores
        const scoreResult = calculateContentScore(content, session.targetKeyword);
        updateData.nlpScore = scoreResult.overallScore;

        const readability = calculateReadability(content);
        updateData.readabilityScore = readability.readingEase;

        const terms = analyzeTermFrequency(content);
        updateData.termData = JSON.stringify(terms);

        updateData.wordCount = content.split(/\s+/).filter(Boolean).length;

        // Determine next version number for this session
        const lastVersion = await prisma.omniSearchContentVersion.findFirst({
          where: { sessionId: id },
          orderBy: { versionNumber: 'desc' },
          select: { versionNumber: true },
        });
        const nextVersionNumber = (lastVersion?.versionNumber ?? 0) + 1;

        // Save a version snapshot
        await prisma.omniSearchContentVersion.create({
          data: {
            sessionId: id,
            content,
            score: scoreResult.overallScore,
            wordCount: updateData.wordCount,
            versionNumber: nextVersionNumber,
            semanticGrade: scoreToGrade(scoreResult.overallScore),
          },
        });
      }

      const updated = await prisma.omniSearchContentSession.update({
        where: { id },
        data: updateData,
        include: {
          _count: { select: { versions: true, articles: true } },
        },
      });

      return { success: true, data: updated };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 5. POST /content/sessions/:id/brief ─────────────────────────────────
  app.post('/content/sessions/:id/brief', async (request, reply) => {
    try {
      const session = await prisma.omniSearchContentSession.findUnique({
        where: { id: Number(request.params.id) },
      });
      if (!session) return reply.status(404).send({ success: false, error: 'Session not found' });

      let serpData = null;
      if (session.serpData) {
        try { serpData = JSON.parse(session.serpData); } catch { /* ignore */ }
      }

      const brief = await generateContentBrief(session.targetKeyword, serpData);
      return { success: true, data: { brief } };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 6. POST /content/sessions/:id/auto-optimize ────────────────────────
  app.post('/content/sessions/:id/auto-optimize', async (request, reply) => {
    try {
      const session = await prisma.omniSearchContentSession.findUnique({
        where: { id: Number(request.params.id) },
      });
      if (!session) return reply.status(404).send({ success: false, error: 'Session not found' });
      if (!session.content) {
        return reply.status(400).send({ success: false, error: 'Session has no content to optimize' });
      }

      const analysis = await analyzeContent(session.content, session.targetKeyword);
      return {
        success: true,
        data: {
          suggestions: analysis.recommendations || [],
          optimizedContent: null,
          scores: analysis.scores || {},
          overallScore: analysis.overallScore ?? null,
          missingTopics: analysis.missingTopics || [],
        },
      };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 7. GET /content/audit ───────────────────────────────────────────────
  app.get('/content/audit', async (request, reply) => {
    try {
      const { url } = request.query;
      if (!url) return reply.status(400).send({ success: false, error: 'url query parameter is required' });

      const pageData = await analyzeUrl(url);

      // We need the raw page text for scoring — re-fetch briefly through the crawler's crawlPage
      // Use the data from analyzeUrl which already includes wordCount info
      const score = calculateContentScore(
        `${pageData.title || ''}\n${pageData.headings?.h1 || ''}\n${(pageData.headings?.h2s || []).join('\n')}`,
        pageData.title || 'general'
      );

      const readability = calculateReadability(
        `${pageData.title || ''} ${pageData.headings?.h1 || ''}`
      );

      const terms = analyzeTermFrequency(
        `${pageData.title || ''} ${pageData.headings?.h1 || ''} ${(pageData.headings?.h2s || []).join(' ')}`
      );

      return {
        success: true,
        data: {
          url,
          score: score.overallScore,
          breakdown: score.breakdown,
          content: {
            wordCount: pageData.content?.wordCount || 0,
            readability,
            terms,
          },
          meta: {
            title: pageData.title,
            description: pageData.meta,
            statusCode: pageData.statusCode,
            loadTime: pageData.loadTime,
          },
        },
      };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 8. DELETE /content/sessions/:id ─────────────────────────────────────
  app.delete('/content/sessions/:id', async (request, reply) => {
    try {
      const id = Number(request.params.id);
      const session = await prisma.omniSearchContentSession.findUnique({ where: { id } });
      if (!session) return reply.status(404).send({ success: false, error: 'Session not found' });

      // Cascade: versions auto-deleted via onDelete: Cascade
      await prisma.omniSearchContentSession.delete({ where: { id } });
      return { success: true, data: { deleted: true } };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 9. GET /content/sessions/:id/versions ──────────────────────────────
  app.get('/content/sessions/:id/versions', async (request, reply) => {
    try {
      const sessionId = Number(request.params.id);
      const session = await prisma.omniSearchContentSession.findUnique({ where: { id: sessionId } });
      if (!session) return reply.status(404).send({ success: false, error: 'Session not found' });

      const versions = await prisma.omniSearchContentVersion.findMany({
        where: { sessionId },
        orderBy: { versionNumber: 'desc' },
      });

      return { success: true, data: { versions } };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 10. POST /content/sessions/:id/restore/:versionId ────────────────
  app.post('/content/sessions/:id/restore/:versionId', async (request, reply) => {
    try {
      const sessionId = Number(request.params.id);
      const versionId = Number(request.params.versionId);

      const [session, version] = await Promise.all([
        prisma.omniSearchContentSession.findUnique({ where: { id: sessionId } }),
        prisma.omniSearchContentVersion.findUnique({ where: { id: versionId } }),
      ]);
      if (!session) return reply.status(404).send({ success: false, error: 'Session not found' });
      if (!version || version.sessionId !== sessionId) {
        return reply.status(404).send({ success: false, error: 'Version not found for this session' });
      }

      const content = version.content;
      const scoreResult = calculateContentScore(content, session.targetKeyword);
      const readability = calculateReadability(content);
      const terms = analyzeTermFrequency(content);
      const wordCount = content.split(/\s+/).filter(Boolean).length;

      const last = await prisma.omniSearchContentVersion.findFirst({
        where: { sessionId },
        orderBy: { versionNumber: 'desc' },
        select: { versionNumber: true },
      });
      const nextVersionNumber = (last?.versionNumber ?? 0) + 1;

      await prisma.omniSearchContentVersion.create({
        data: {
          sessionId,
          content,
          score: scoreResult.overallScore,
          wordCount,
          versionNumber: nextVersionNumber,
          semanticGrade: scoreToGrade(scoreResult.overallScore),
        },
      });

      const updated = await prisma.omniSearchContentSession.update({
        where: { id: sessionId },
        data: {
          content,
          nlpScore: scoreResult.overallScore,
          readabilityScore: readability.readingEase,
          termData: JSON.stringify(terms),
          wordCount,
        },
      });

      return {
        success: true,
        data: { restoredFromVersion: version.versionNumber, session: updated },
      };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });
}

// Convert numeric score (0-100) to a letter grade used in the UI.
function scoreToGrade(score) {
  if (score == null) return null;
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}
