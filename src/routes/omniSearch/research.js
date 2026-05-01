import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../../lib/prisma.js';
import {
  analyzeKeywords,
  clusterKeywords,
  analyzeCompetitiveGap,
  generateTopicalMap,
} from '../../lib/omniSearch/omniSearchAi.js';
import { AI_MODEL } from '../../lib/omniSearch/omniSearchConfig.js';
import { fetchKeywordMetrics } from '../../lib/omniSearch/keywordDataProvider.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DEFAULT_MODEL = AI_MODEL;

export default async function researchRoutes(app) {
  // ── Auth guard on all routes ───────────────────────────────────────────────
  app.addHook('onRequest', async (request, reply) => {
    await app.omniSearchAuth(request, reply);
  });

  // ─── 1. GET /keywords/search ─────────────────────────────────────────────
  app.get('/keywords/search', async (request, reply) => {
    try {
      const { q, country = 'US', limit = 20, projectId } = request.query;
      if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });

      const result = await fetchKeywordMetrics(q, country, Number(limit));
      const keywords = result.keywords || [];
      const dataSource = result.dataSource;

      // Optionally save to DB
      if (projectId) {
        const pid = Number(projectId);
        for (const kw of keywords) {
          await prisma.omniSearchKeyword.create({
            data: {
              projectId: pid,
              keyword: kw.keyword,
              volume: kw.estimatedVolume ?? null,
              difficulty: kw.difficulty ?? null,
              cpc: kw.cpc ?? null,
              intent: kw.intent ?? null,
              country,
              dataSource,
            },
          });
        }
      }

      return { success: true, data: { keywords, total: keywords.length, dataSource } };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 2. GET /keywords/:id ────────────────────────────────────────────────
  app.get('/keywords/:id', async (request, reply) => {
    try {
      const keyword = await prisma.omniSearchKeyword.findUnique({
        where: { id: Number(request.params.id) },
        include: {
          rankHistory: {
            orderBy: { checkedAt: 'desc' },
            take: 30,
          },
        },
      });
      if (!keyword) return reply.status(404).send({ success: false, error: 'Keyword not found' });
      return { success: true, data: keyword };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 3. POST /keywords/cluster ───────────────────────────────────────────
  app.post('/keywords/cluster', async (request, reply) => {
    try {
      const { keywordIds, keywords: rawKeywords } = request.body || {};

      let keywordStrings = [];
      let dbKeywords = [];

      if (keywordIds && keywordIds.length > 0) {
        dbKeywords = await prisma.omniSearchKeyword.findMany({
          where: { id: { in: keywordIds.map(Number) } },
        });
        keywordStrings = dbKeywords.map((k) => k.keyword);
      } else if (rawKeywords && rawKeywords.length > 0) {
        keywordStrings = rawKeywords;
      } else {
        return reply.status(400).send({ success: false, error: 'Provide keywordIds or keywords array' });
      }

      const result = await clusterKeywords(keywordStrings);
      const clusters = result.clusters || [];

      // Save clusters and update keywords if we have DB keywords
      if (dbKeywords.length > 0 && clusters.length > 0) {
        const projectId = dbKeywords[0].projectId;
        for (const cluster of clusters) {
          const saved = await prisma.omniSearchKeywordCluster.create({
            data: {
              name: cluster.name || cluster.pillarKeyword || 'Unnamed Cluster',
              theme: cluster.intent || null,
              projectId,
            },
          });
          // Update keywords that belong to this cluster
          const clusterKwLower = (cluster.keywords || []).map((k) => k.toLowerCase());
          const matchingIds = dbKeywords
            .filter((kw) => clusterKwLower.includes(kw.keyword.toLowerCase()))
            .map((kw) => kw.id);

          if (matchingIds.length > 0) {
            await prisma.omniSearchKeyword.updateMany({
              where: { id: { in: matchingIds } },
              data: { clusterId: saved.id },
            });
          }
          cluster.id = saved.id;
        }
      }

      return { success: true, data: { clusters } };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 4. GET /keywords/:id/questions ──────────────────────────────────────
  app.get('/keywords/:id/questions', async (request, reply) => {
    try {
      const keyword = await prisma.omniSearchKeyword.findUnique({
        where: { id: Number(request.params.id) },
      });
      if (!keyword) return reply.status(404).send({ success: false, error: 'Keyword not found' });

      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 2048,
        system: `You are an SEO expert specializing in People Also Ask (PAA) expansion. Given a keyword, generate related questions that users commonly search for. Return ONLY valid JSON.

Output format:
{
  "keyword": "...",
  "questions": [
    { "question": "...", "intent": "informational|transactional|navigational|commercial", "difficulty": "easy|medium|hard" }
  ]
}`,
        messages: [{ role: 'user', content: `Generate People Also Ask questions for the keyword: "${keyword.keyword}"` }],
      });

      const text = response.content[0]?.text || '{}';
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      return { success: true, data: { questions: data.questions || [] } };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 5. POST /research/gap ───────────────────────────────────────────────
  app.post('/research/gap', async (request, reply) => {
    try {
      const { domain, competitors, projectId } = request.body || {};
      if (!domain || !competitors || !competitors.length) {
        return reply.status(400).send({ success: false, error: 'domain and competitors[] are required' });
      }

      const result = await analyzeCompetitiveGap(domain, competitors);
      return {
        success: true,
        data: {
          gaps: result.keywordGaps || result.gaps || [],
          opportunities: result.contentGaps || result.opportunities || [],
          overlap: result.strengthAreas || result.overlap || [],
        },
      };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 6. POST /research/topical-map ───────────────────────────────────────
  app.post('/research/topical-map', async (request, reply) => {
    try {
      const { domain, seedTopics, projectId } = request.body || {};
      if (!domain || !seedTopics || !seedTopics.length) {
        return reply.status(400).send({ success: false, error: 'domain and seedTopics[] are required' });
      }

      const result = await generateTopicalMap(domain, seedTopics);
      return {
        success: true,
        data: {
          pillars: result.pillars || [],
          clusters: result.pillars?.flatMap((p) => p.clusters || []) || [],
        },
      };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 7. GET /research/trending ───────────────────────────────────────────
  app.get('/research/trending', async (request, reply) => {
    try {
      const { country = 'US', category = 'general', limit = 20 } = request.query;

      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 4096,
        system: `You are an SEO trend analyst. Suggest currently trending topics and keywords that content creators should target. Return ONLY valid JSON.

Output format:
{
  "trending": [
    { "topic": "...", "keyword": "...", "estimatedVolume": <number>, "trend": "rising|breakout|stable", "category": "...", "reason": "..." }
  ]
}`,
        messages: [{ role: 'user', content: `Suggest ${limit} trending topics/keywords in the "${category}" category for ${country}.` }],
      });

      const text = response.content[0]?.text || '{}';
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      return { success: true, data: { trending: data.trending || [] } };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 8. GET /projects/:projectId/keywords ────────────────────────────────
  app.get('/projects/:projectId/keywords', async (request, reply) => {
    try {
      const projectId = Number(request.params.projectId);
      const { page = 1, limit = 50, sort = 'createdAt', order = 'desc', search } = request.query;
      const take = Math.min(Number(limit), 100);
      const skip = (Number(page) - 1) * take;

      const where = { projectId };
      if (search) {
        where.keyword = { contains: search };
      }

      const allowedSort = ['keyword', 'volume', 'difficulty', 'cpc', 'createdAt'];
      const orderByField = allowedSort.includes(sort) ? sort : 'createdAt';
      const orderDir = order === 'asc' ? 'asc' : 'desc';

      const [keywords, total] = await Promise.all([
        prisma.omniSearchKeyword.findMany({
          where,
          orderBy: { [orderByField]: orderDir },
          skip,
          take,
          include: {
            rankHistory: {
              orderBy: { checkedAt: 'desc' },
              take: 1,
            },
            cluster: true,
          },
        }),
        prisma.omniSearchKeyword.count({ where }),
      ]);

      return {
        success: true,
        data: {
          keywords,
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

  // ─── 9. POST /projects/:projectId/keywords ──────────────────────────────
  app.post('/projects/:projectId/keywords', async (request, reply) => {
    try {
      const projectId = Number(request.params.projectId);
      const { keywords } = request.body || {};
      if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
        return reply.status(400).send({ success: false, error: 'keywords[] array is required' });
      }

      const data = keywords.map((kw) => ({
        projectId,
        keyword: kw.keyword,
        volume: kw.volume ?? null,
        difficulty: kw.difficulty ?? null,
        cpc: kw.cpc ?? null,
        intent: kw.intent ?? null,
        country: kw.country || 'US',
      }));

      const result = await prisma.omniSearchKeyword.createMany({ data });
      return { success: true, data: { created: result.count } };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // ─── 10. DELETE /keywords/:id ────────────────────────────────────────────
  app.delete('/keywords/:id', async (request, reply) => {
    try {
      const id = Number(request.params.id);
      const keyword = await prisma.omniSearchKeyword.findUnique({ where: { id } });
      if (!keyword) return reply.status(404).send({ success: false, error: 'Keyword not found' });

      // Cascade: rank history is auto-deleted via onDelete: Cascade in schema
      await prisma.omniSearchKeyword.delete({ where: { id } });
      return { success: true, data: { deleted: true } };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
