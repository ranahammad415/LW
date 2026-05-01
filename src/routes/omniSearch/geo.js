import { prisma } from '../../lib/prisma.js';
import { checkGeoVisibility } from '../../lib/omniSearch/omniSearchAi.js';
import {
  queryAiPlatform,
  analyzeGeoResponse,
} from '../../lib/omniSearch/aiQueryProvider.js';
import { hasRealAiQueryProvider } from '../../lib/omniSearch/omniSearchConfig.js';

const VALID_PLATFORMS = ['chatgpt', 'perplexity', 'gemini', 'claude', 'copilot', 'grok', 'meta_ai', 'deepseek'];

export default async function geoRoutes(app) {
  app.addHook('onRequest', async (request, reply) => {
    await app.omniSearchAuth(request, reply);
  });

  // ── POST /geo/prompts — Create a GEO prompt ──────────────────────────────
  app.post('/geo/prompts', async (request, reply) => {
    try {
      const { projectId, prompt, platform, frequency } = request.body || {};
      if (!projectId || !prompt || !platform) {
        return reply.code(400).send({ success: false, error: 'projectId, prompt, and platform are required' });
      }
      if (!VALID_PLATFORMS.includes(platform)) {
        return reply.code(400).send({ success: false, error: `Invalid platform. Must be one of: ${VALID_PLATFORMS.join(', ')}` });
      }
      const geoPrompt = await prisma.omniSearchGeoPrompt.create({
        data: {
          projectId: Number(projectId),
          prompt,
          platform,
          frequency: frequency || 'daily',
        },
      });
      return { success: true, data: geoPrompt };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /geo/prompts — List prompts with pagination ───────────────────────
  app.get('/geo/prompts', async (request, reply) => {
    try {
      const { projectId, platform, page = 1, limit = 20 } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });

      const where = { projectId: Number(projectId) };
      if (platform) where.platform = platform;

      const skip = (Number(page) - 1) * Number(limit);
      const [prompts, total] = await Promise.all([
        prisma.omniSearchGeoPrompt.findMany({
          where,
          skip,
          take: Number(limit),
          orderBy: { createdAt: 'desc' },
          include: {
            responses: {
              orderBy: { checkedAt: 'desc' },
              take: 1,
            },
          },
        }),
        prisma.omniSearchGeoPrompt.count({ where }),
      ]);

      return { success: true, data: { prompts, total, page: Number(page), limit: Number(limit) } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /geo/prompts/:id/responses — List responses for a prompt ──────────
  app.get('/geo/prompts/:id/responses', async (request, reply) => {
    try {
      const { id } = request.params;
      const { page = 1, limit = 20, days = 30 } = request.query;

      const since = new Date();
      since.setDate(since.getDate() - Number(days));

      const where = { promptId: Number(id), checkedAt: { gte: since } };
      const skip = (Number(page) - 1) * Number(limit);

      const [responses, total] = await Promise.all([
        prisma.omniSearchGeoResponse.findMany({
          where,
          skip,
          take: Number(limit),
          orderBy: { checkedAt: 'desc' },
        }),
        prisma.omniSearchGeoResponse.count({ where }),
      ]);

      return { success: true, data: { responses, total, page: Number(page), limit: Number(limit) } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── POST /geo/check-now — Run GEO check for prompt(s) ────────────────────
  app.post('/geo/check-now', async (request, reply) => {
    try {
      const { promptId, projectId } = request.body || {};
      if (!promptId && !projectId) {
        return reply.code(400).send({ success: false, error: 'promptId or projectId is required' });
      }

      let prompts;
      if (promptId) {
        const p = await prisma.omniSearchGeoPrompt.findUnique({
          where: { id: Number(promptId) },
          include: { project: true },
        });
        if (!p) return reply.code(404).send({ success: false, error: 'Prompt not found' });
        prompts = [p];
      } else {
        prompts = await prisma.omniSearchGeoPrompt.findMany({
          where: { projectId: Number(projectId), isActive: true },
          include: { project: true },
        });
      }

      const results = [];
      for (const gp of prompts) {
        const brandName = gp.project.name || gp.project.domain;
        const country = gp.project.country || 'US';

        let responseText;
        let brandMentioned;
        let citationUrl;
        let responseSource;
        let sentiment = null;
        let competitorsMentioned = null;
        let entityAccuracy = null;

        if (hasRealAiQueryProvider(gp.platform)) {
          // Real provider — call the actual AI platform, then analyze its answer.
          const ai = await queryAiPlatform({
            platform: gp.platform,
            prompt: gp.prompt,
            targetDomain: gp.project.domain,
            country,
          });
          responseText = ai.answer;
          brandMentioned = ai.mentioned;
          citationUrl = ai.citations?.[0]?.url || null;
          responseSource = ai.responseSource;

          const analysis = await analyzeGeoResponse({
            prompt: gp.prompt,
            brandName,
            answer: ai.answer,
          });
          sentiment = analysis.sentiment;
          competitorsMentioned = analysis.competitorsMentioned.length
            ? JSON.stringify(analysis.competitorsMentioned)
            : null;
          entityAccuracy = analysis.entityAccuracy;
        } else {
          // No real key for this platform — simulate with Claude (legacy path).
          const aiResult = await checkGeoVisibility(gp.prompt, brandName, gp.platform);
          responseText = aiResult.simulatedResponse || JSON.stringify(aiResult);
          brandMentioned = aiResult.brandMentioned || false;
          sentiment = aiResult.sentiment || null;
          citationUrl = aiResult.citationUrl || null;
          competitorsMentioned = aiResult.competitorsMentioned
            ? JSON.stringify(aiResult.competitorsMentioned)
            : null;
          entityAccuracy = aiResult.entityAccuracy || null;
          responseSource = 'simulated';
        }

        const response = await prisma.omniSearchGeoResponse.create({
          data: {
            promptId: gp.id,
            platform: gp.platform,
            response: responseText,
            brandMentioned,
            sentiment,
            citationUrl,
            competitorsMentioned,
            entityAccuracy,
            country,
            responseSource,
          },
        });
        results.push(response);
      }

      return { success: true, data: { checked: results.length, results } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /geo/metrics — Aggregate GEO metrics ─────────────────────────────
  app.get('/geo/metrics', async (request, reply) => {
    try {
      const { projectId, platform, days = 30 } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });

      const since = new Date();
      since.setDate(since.getDate() - Number(days));

      const promptWhere = { projectId: Number(projectId) };
      if (platform) promptWhere.platform = platform;

      const prompts = await prisma.omniSearchGeoPrompt.findMany({
        where: promptWhere,
        include: {
          responses: { where: { checkedAt: { gte: since } } },
        },
      });

      const allResponses = prompts.flatMap(p => p.responses);
      const total = allResponses.length;
      const mentioned = allResponses.filter(r => r.brandMentioned).length;
      const withCitation = allResponses.filter(r => r.citationUrl).length;
      const positiveSentiment = allResponses.filter(r => r.sentiment === 'positive').length;

      const mentionRate = total > 0 ? mentioned / total : 0;
      const citationRate = total > 0 ? withCitation / total : 0;
      const positiveSentimentRate = total > 0 ? positiveSentiment / total : 0;
      const overallBVI = (mentionRate * 40) + (positiveSentimentRate * 30) + (citationRate * 30);

      // Group by platform
      const platformMap = {};
      for (const r of allResponses) {
        if (!platformMap[r.platform]) platformMap[r.platform] = { total: 0, mentioned: 0, positive: 0, withCitation: 0 };
        platformMap[r.platform].total++;
        if (r.brandMentioned) platformMap[r.platform].mentioned++;
        if (r.sentiment === 'positive') platformMap[r.platform].positive++;
        if (r.citationUrl) platformMap[r.platform].withCitation++;
      }
      const platforms = {};
      for (const [plat, stats] of Object.entries(platformMap)) {
        const mr = stats.total > 0 ? stats.mentioned / stats.total : 0;
        const pr = stats.total > 0 ? stats.positive / stats.total : 0;
        const cr = stats.total > 0 ? stats.withCitation / stats.total : 0;
        platforms[plat] = { total: stats.total, mentionRate: mr, positiveSentimentRate: pr, citationRate: cr, bvi: (mr * 40) + (pr * 30) + (cr * 30) };
      }

      return { success: true, data: { metrics: { overallBVI: Math.round(overallBVI * 100) / 100, mentionRate, citationRate, positiveSentimentRate, totalChecked: total, platforms } } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /geo/brand-visibility — BVI with trend ────────────────────────────
  app.get('/geo/brand-visibility', async (request, reply) => {
    try {
      const { projectId, days = 30 } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });

      const since = new Date();
      since.setDate(since.getDate() - Number(days));

      const responses = await prisma.omniSearchGeoResponse.findMany({
        where: { prompt: { projectId: Number(projectId) }, checkedAt: { gte: since } },
        orderBy: { checkedAt: 'asc' },
      });

      const total = responses.length;
      const mentioned = responses.filter(r => r.brandMentioned).length;
      const withCitation = responses.filter(r => r.citationUrl).length;
      const positive = responses.filter(r => r.sentiment === 'positive').length;

      const mentionRate = total > 0 ? mentioned / total : 0;
      const citationRate = total > 0 ? withCitation / total : 0;
      const positiveSentimentRate = total > 0 ? positive / total : 0;
      const bvi = (mentionRate * 40) + (positiveSentimentRate * 30) + (citationRate * 30);

      // Build daily trend
      const dailyBuckets = {};
      for (const r of responses) {
        const day = r.checkedAt.toISOString().slice(0, 10);
        if (!dailyBuckets[day]) dailyBuckets[day] = { total: 0, mentioned: 0, positive: 0, cited: 0 };
        dailyBuckets[day].total++;
        if (r.brandMentioned) dailyBuckets[day].mentioned++;
        if (r.sentiment === 'positive') dailyBuckets[day].positive++;
        if (r.citationUrl) dailyBuckets[day].cited++;
      }
      const trend = Object.entries(dailyBuckets).map(([date, s]) => {
        const mr = s.total > 0 ? s.mentioned / s.total : 0;
        const pr = s.total > 0 ? s.positive / s.total : 0;
        const cr = s.total > 0 ? s.cited / s.total : 0;
        return { date, bvi: Math.round(((mr * 40) + (pr * 30) + (cr * 30)) * 100) / 100, checks: s.total };
      });

      return {
        success: true,
        data: {
          bvi: Math.round(bvi * 100) / 100,
          trend,
          breakdown: { mentionRate, positiveSentimentRate, citationRate, totalResponses: total },
        },
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /geo/entity-tracking — Entity accuracy analysis ───────────────────
  app.get('/geo/entity-tracking', async (request, reply) => {
    try {
      const { projectId } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });

      const responses = await prisma.omniSearchGeoResponse.findMany({
        where: { prompt: { projectId: Number(projectId) }, entityAccuracy: { not: null } },
        include: { prompt: { select: { prompt: true, platform: true } } },
        orderBy: { checkedAt: 'desc' },
      });

      const accuracies = responses.map(r => r.entityAccuracy).filter(Boolean);
      const avgAccuracy = accuracies.length > 0 ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length : 0;

      const details = responses.slice(0, 50).map(r => ({
        promptText: r.prompt.prompt,
        platform: r.platform,
        entityAccuracy: r.entityAccuracy,
        checkedAt: r.checkedAt,
      }));

      return { success: true, data: { accuracy: Math.round(avgAccuracy * 100) / 100, details } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /geo/shopping — Shopping-related GEO responses ────────────────────
  app.get('/geo/shopping', async (request, reply) => {
    try {
      const { projectId } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });

      const responses = await prisma.omniSearchGeoResponse.findMany({
        where: {
          prompt: {
            projectId: Number(projectId),
            prompt: { contains: 'buy' },
          },
        },
        include: { prompt: { select: { prompt: true, platform: true } } },
        orderBy: { checkedAt: 'desc' },
        take: 100,
      });

      // Also search for other shopping-related terms
      const shoppingTerms = ['shop', 'purchase', 'price', 'deal', 'product', 'recommend', 'best'];
      const additionalResponses = await prisma.omniSearchGeoResponse.findMany({
        where: {
          prompt: {
            projectId: Number(projectId),
            OR: shoppingTerms.map(term => ({ prompt: { contains: term } })),
          },
          id: { notIn: responses.map(r => r.id) },
        },
        include: { prompt: { select: { prompt: true, platform: true } } },
        orderBy: { checkedAt: 'desc' },
        take: 100,
      });

      const all = [...responses, ...additionalResponses];
      return {
        success: true,
        data: {
          shoppingVisibility: all.map(r => ({
            id: r.id,
            prompt: r.prompt.prompt,
            platform: r.prompt.platform,
            brandMentioned: r.brandMentioned,
            sentiment: r.sentiment,
            citationUrl: r.citationUrl,
            checkedAt: r.checkedAt,
          })),
        },
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /geo/algorithm-updates — Detect visibility swings ─────────────────
  app.get('/geo/algorithm-updates', async (request, reply) => {
    try {
      const { days = 90 } = request.query;
      const since = new Date();
      since.setDate(since.getDate() - Number(days));

      const responses = await prisma.omniSearchGeoResponse.findMany({
        where: { checkedAt: { gte: since } },
        orderBy: { checkedAt: 'asc' },
        include: { prompt: { select: { projectId: true } } },
      });

      // Bucket by week + platform
      const weekBuckets = {};
      for (const r of responses) {
        const weekStart = getWeekStart(r.checkedAt);
        const key = `${weekStart}_${r.platform}`;
        if (!weekBuckets[key]) weekBuckets[key] = { date: weekStart, platform: r.platform, total: 0, mentioned: 0 };
        weekBuckets[key].total++;
        if (r.brandMentioned) weekBuckets[key].mentioned++;
      }

      const weeks = Object.values(weekBuckets).sort((a, b) => a.date.localeCompare(b.date));
      const updates = [];

      // Compare consecutive weeks per platform
      const byPlatform = {};
      for (const w of weeks) {
        if (!byPlatform[w.platform]) byPlatform[w.platform] = [];
        byPlatform[w.platform].push(w);
      }

      for (const [platform, platWeeks] of Object.entries(byPlatform)) {
        for (let i = 1; i < platWeeks.length; i++) {
          const prev = platWeeks[i - 1];
          const curr = platWeeks[i];
          const prevRate = prev.total > 0 ? prev.mentioned / prev.total : 0;
          const currRate = curr.total > 0 ? curr.mentioned / curr.total : 0;
          if (prevRate === 0 && currRate === 0) continue;
          const changePct = prevRate > 0 ? ((currRate - prevRate) / prevRate) * 100 : (currRate > 0 ? 100 : 0);
          if (Math.abs(changePct) > 20) {
            updates.push({
              date: curr.date,
              platform,
              changePct: Math.round(changePct * 100) / 100,
              description: `Brand mention rate ${changePct > 0 ? 'increased' : 'decreased'} by ${Math.abs(Math.round(changePct))}% on ${platform}`,
            });
          }
        }
      }

      return { success: true, data: { updates } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── DELETE /geo/prompts/:id — Delete prompt and cascaded responses ────────
  app.delete('/geo/prompts/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      await prisma.omniSearchGeoPrompt.delete({ where: { id: Number(id) } });
      return { success: true };
    } catch (err) {
      if (err.code === 'P2025') return reply.code(404).send({ success: false, error: 'Prompt not found' });
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });
}

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}
