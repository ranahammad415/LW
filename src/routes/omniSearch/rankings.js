import { prisma } from '../../lib/prisma.js';
import { lookupSerpPosition } from '../../lib/omniSearch/serpProvider.js';

export default async function rankingsRoutes(app) {
  app.addHook('onRequest', async (request, reply) => {
    await app.omniSearchAuth(request, reply);
  });

  // ─── POST /rankings/track ─────────────────────────────────────────────────
  app.post('/rankings/track', async (request, reply) => {
    try {
      const { projectId, keywordId, keyword, country } = request.body || {};
      if (!projectId) {
        return reply.code(400).send({ success: false, error: 'projectId is required' });
      }

      let kw;
      if (keywordId) {
        kw = await prisma.omniSearchKeyword.update({
          where: { id: keywordId },
          data: { isTracked: true },
        });
      } else if (keyword) {
        // Find existing or create
        const existing = await prisma.omniSearchKeyword.findFirst({
          where: { projectId, keyword },
        });
        if (existing) {
          kw = await prisma.omniSearchKeyword.update({
            where: { id: existing.id },
            data: { isTracked: true },
          });
        } else {
          kw = await prisma.omniSearchKeyword.create({
            data: {
              projectId,
              keyword,
              country: country || 'US',
              isTracked: true,
            },
          });
        }
      } else {
        return reply.code(400).send({ success: false, error: 'keywordId or keyword is required' });
      }

      return { success: true, data: kw };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── GET /rankings/:projectId/positions ───────────────────────────────────
  app.get('/rankings/:projectId/positions', async (request, reply) => {
    try {
      const projectId = parseInt(request.params.projectId);
      const { page = 1, limit = 50, engine = 'google', device = 'desktop' } = request.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      const trackedKeywords = await prisma.omniSearchKeyword.findMany({
        where: { projectId, isTracked: true },
        skip,
        take,
        include: {
          rankHistory: {
            where: { engine, device },
            orderBy: { checkedAt: 'desc' },
            take: 2,
          },
        },
      });

      const total = await prisma.omniSearchKeyword.count({
        where: { projectId, isTracked: true },
      });

      const positions = trackedKeywords.map(kw => {
        const latest = kw.rankHistory[0] || null;
        const previous = kw.rankHistory[1] || null;
        const currentRank = latest?.position || null;
        const previousRank = previous?.position || null;
        const change = currentRank && previousRank ? previousRank - currentRank : 0;
        return {
          keyword: { id: kw.id, keyword: kw.keyword, volume: kw.volume, difficulty: kw.difficulty, country: kw.country },
          currentRank,
          previousRank,
          change,
          url: latest?.url || null,
        };
      });

      return { success: true, data: { positions, total } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── GET /rankings/:projectId/history ─────────────────────────────────────
  app.get('/rankings/:projectId/history', async (request, reply) => {
    try {
      const projectId = parseInt(request.params.projectId);
      const { keywordId, days = 30, engine = 'google' } = request.query;
      const since = new Date(Date.now() - parseInt(days) * 86400000);

      const where = {
        checkedAt: { gte: since },
        engine,
        keyword: { projectId, isTracked: true },
      };
      if (keywordId) {
        where.keywordId = parseInt(keywordId);
      }

      const history = await prisma.omniSearchRankHistory.findMany({
        where,
        orderBy: { checkedAt: 'asc' },
        include: { keyword: { select: { keyword: true, id: true } } },
      });

      const data = history.map(h => ({
        date: h.checkedAt,
        position: h.position,
        url: h.url,
        engine: h.engine,
        keywordId: h.keywordId,
        keyword: h.keyword.keyword,
      }));

      return { success: true, data: { history: data } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── POST /rankings/check-now ─────────────────────────────────────────────
  app.post('/rankings/check-now', async (request, reply) => {
    try {
      const { keywordId, projectId } = request.body || {};

      let keywords;
      if (keywordId) {
        const kw = await prisma.omniSearchKeyword.findUnique({
          where: { id: parseInt(keywordId) },
          include: { project: true },
        });
        if (!kw) return reply.code(404).send({ success: false, error: 'Keyword not found' });
        keywords = [kw];
      } else if (projectId) {
        keywords = await prisma.omniSearchKeyword.findMany({
          where: { projectId: parseInt(projectId), isTracked: true },
          include: { project: true },
        });
      } else {
        return reply.code(400).send({ success: false, error: 'keywordId or projectId is required' });
      }

      if (keywords.length === 0) {
        return { success: true, data: { checked: 0, results: [] } };
      }

      const results = [];
      for (const kw of keywords) {
        const lookup = await lookupSerpPosition({
          keyword: kw.keyword,
          domain: kw.project.domain,
          engine: 'google',
          country: kw.country || 'US',
        });

        const serpFeatures = lookup.raw?.organic_results
          ? JSON.stringify(extractSerpFeatures(lookup.raw))
          : null;

        const entry = await prisma.omniSearchRankHistory.create({
          data: {
            keywordId: kw.id,
            position: lookup.position,
            url: lookup.url,
            engine: 'google',
            device: 'desktop',
            serpFeatures,
            dataSource: lookup.dataSource,
          },
        });
        results.push({
          keywordId: kw.id,
          keyword: kw.keyword,
          position: lookup.position,
          url: lookup.url,
          dataSource: lookup.dataSource,
          entry,
        });
      }

      return { success: true, data: { checked: results.length, results } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── GET /rankings/share-of-voice ─────────────────────────────────────────
  app.get('/rankings/share-of-voice', async (request, reply) => {
    try {
      const { projectId } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });

      const keywords = await prisma.omniSearchKeyword.findMany({
        where: { projectId: parseInt(projectId), isTracked: true },
        include: {
          rankHistory: { orderBy: { checkedAt: 'desc' }, take: 1 },
        },
      });

      let top3 = 0, top10 = 0, top20 = 0, notRanking = 0;
      let totalWeightedRanking = 0, totalVolume = 0;

      for (const kw of keywords) {
        const pos = kw.rankHistory[0]?.position;
        const vol = kw.volume || 1;
        totalVolume += vol;

        if (!pos) { notRanking++; continue; }
        if (pos <= 3) { top3++; top10++; top20++; totalWeightedRanking += vol; }
        else if (pos <= 10) { top10++; top20++; totalWeightedRanking += vol; }
        else if (pos <= 20) { top20++; }
        else { notRanking++; }
      }

      const shareOfVoice = totalVolume > 0 ? Math.round((totalWeightedRanking / totalVolume) * 100) : 0;

      return { success: true, data: { shareOfVoice, top3, top10, top20, notRanking } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── DELETE /rankings/track/:keywordId ────────────────────────────────────
  app.delete('/rankings/track/:keywordId', async (request, reply) => {
    try {
      const keywordId = parseInt(request.params.keywordId);
      const kw = await prisma.omniSearchKeyword.update({
        where: { id: keywordId },
        data: { isTracked: false },
      });
      return { success: true, data: kw };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── GET /rankings/:projectId/changes ─────────────────────────────────────
  app.get('/rankings/:projectId/changes', async (request, reply) => {
    try {
      const projectId = parseInt(request.params.projectId);
      const { days = 7, minChange = 3 } = request.query;
      const minChangeNum = parseInt(minChange);

      const keywords = await prisma.omniSearchKeyword.findMany({
        where: { projectId, isTracked: true },
        include: {
          rankHistory: {
            orderBy: { checkedAt: 'desc' },
            take: 2,
          },
        },
      });

      const improved = [], declined = [], newRankings = [], lostRankings = [];

      for (const kw of keywords) {
        const latest = kw.rankHistory[0];
        const previous = kw.rankHistory[1];
        if (!latest) continue;

        const currentPos = latest.position;
        const prevPos = previous?.position || null;

        if (currentPos && !prevPos) {
          newRankings.push({ keyword: kw.keyword, keywordId: kw.id, position: currentPos });
        } else if (!currentPos && prevPos) {
          lostRankings.push({ keyword: kw.keyword, keywordId: kw.id, previousPosition: prevPos });
        } else if (currentPos && prevPos) {
          const change = prevPos - currentPos;
          if (Math.abs(change) >= minChangeNum) {
            const item = { keyword: kw.keyword, keywordId: kw.id, currentPosition: currentPos, previousPosition: prevPos, change };
            if (change > 0) improved.push(item);
            else declined.push(item);
          }
        }
      }

      return { success: true, data: { improved, declined, newRankings, lostRankings } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── GET /rankings/:projectId/serp-features ───────────────────────────────
  app.get('/rankings/:projectId/serp-features', async (request, reply) => {
    try {
      const projectId = parseInt(request.params.projectId);
      const { engine = 'google' } = request.query;

      const keywords = await prisma.omniSearchKeyword.findMany({
        where: { projectId, isTracked: true },
        include: {
          rankHistory: {
            where: { engine },
            orderBy: { checkedAt: 'desc' },
            take: 1,
          },
        },
      });

      const features = {};
      const keywordsWithFeatures = [];

      for (const kw of keywords) {
        const latest = kw.rankHistory[0];
        if (!latest?.serpFeatures) continue;

        let sf;
        try { sf = JSON.parse(latest.serpFeatures); } catch { continue; }
        if (!Array.isArray(sf)) continue;

        if (sf.length > 0) {
          keywordsWithFeatures.push({ keyword: kw.keyword, keywordId: kw.id, features: sf });
        }
        for (const f of sf) {
          features[f] = (features[f] || 0) + 1;
        }
      }

      return { success: true, data: { features, keywordsWithFeatures } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });
}

// ── helper: extract SERP features from SerpAPI/DataForSEO raw payload ──────
function extractSerpFeatures(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const features = new Set();
  if (raw.answer_box || raw.featured_snippet) features.add('featured_snippet');
  if (raw.related_questions || raw.people_also_ask) features.add('people_also_ask');
  if (raw.local_results || raw.local_pack) features.add('local_pack');
  if (raw.inline_videos || raw.videos) features.add('video');
  if (raw.inline_images || raw.images) features.add('images');
  if (raw.knowledge_graph || raw.knowledge_panel) features.add('knowledge_panel');
  if (raw.sitelinks) features.add('site_links');
  // DataForSEO style — item types within items
  const items = raw?.tasks?.[0]?.result?.[0]?.items || [];
  for (const item of items) {
    if (item.type === 'featured_snippet') features.add('featured_snippet');
    if (item.type === 'people_also_ask') features.add('people_also_ask');
    if (item.type === 'local_pack' || item.type === 'map') features.add('local_pack');
    if (item.type === 'video') features.add('video');
    if (item.type === 'images') features.add('images');
    if (item.type === 'knowledge_graph') features.add('knowledge_panel');
  }
  return Array.from(features);
}
