import { prisma } from '../../lib/prisma.js';
import { generateRecommendations } from '../../lib/omniSearch/omniSearchAi.js';
import Anthropic from '@anthropic-ai/sdk';
import { AI_MODEL } from '../../lib/omniSearch/omniSearchConfig.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function advisorRoutes(app) {
  app.addHook('onRequest', async (request, reply) => {
    await app.omniSearchAuth(request, reply);
  });

  // ── Helper: gather project data ───────────────────────────────────────────
  async function gatherProjectData(pid) {
    const [project, keywords, latestAudit, backlinks, geoResponses, contentSessions] = await Promise.all([
      prisma.omniSearchProject.findUnique({ where: { id: pid } }),
      prisma.omniSearchKeyword.findMany({
        where: { projectId: pid },
        include: { rankHistory: { orderBy: { checkedAt: 'desc' }, take: 1 } },
        take: 100,
      }),
      prisma.omniSearchAudit.findFirst({ where: { projectId: pid }, orderBy: { createdAt: 'desc' } }),
      prisma.omniSearchBacklink.findMany({ where: { projectId: pid, isActive: true }, take: 100 }),
      prisma.omniSearchGeoResponse.findMany({
        where: { prompt: { projectId: pid } },
        orderBy: { checkedAt: 'desc' },
        take: 100,
      }),
      prisma.omniSearchContentSession.findMany({ where: { projectId: pid }, take: 50 }),
    ]);

    const rankedKeywords = keywords.map(k => ({
      keyword: k.keyword,
      volume: k.volume,
      difficulty: k.difficulty,
      position: k.rankHistory[0]?.position || null,
    }));

    const geoTotal = geoResponses.length;
    const geoMentioned = geoResponses.filter(r => r.brandMentioned).length;

    return {
      project,
      keywords: rankedKeywords,
      auditHealthScore: latestAudit?.healthScore || null,
      auditIssueCount: latestAudit?.issueCount || 0,
      backlinkCount: backlinks.length,
      avgDomainRating: backlinks.length > 0
        ? backlinks.filter(b => b.domainRating).reduce((a, b) => a + b.domainRating, 0) / backlinks.filter(b => b.domainRating).length
        : null,
      geoVisibilityRate: geoTotal > 0 ? geoMentioned / geoTotal : 0,
      contentSessionCount: contentSessions.length,
      avgContentScore: contentSessions.filter(s => s.nlpScore).length > 0
        ? contentSessions.filter(s => s.nlpScore).reduce((a, s) => a + s.nlpScore, 0) / contentSessions.filter(s => s.nlpScore).length
        : null,
    };
  }

  // ── GET /advisor/recommendations — AI-powered recommendations ─────────────
  app.get('/advisor/recommendations', async (request, reply) => {
    try {
      const { projectId, limit = 10 } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });

      const projectData = await gatherProjectData(Number(projectId));
      if (!projectData.project) return reply.code(404).send({ success: false, error: 'Project not found' });

      const result = await generateRecommendations(projectData);
      const recommendations = (result.priorities || []).slice(0, Number(limit)).map((r, i) => ({
        priority: i + 1,
        category: r.category || 'general',
        title: r.title,
        description: r.description,
        impact: r.impact || 'medium',
        effort: r.effort || 'medium',
        steps: r.steps || [],
      }));

      return { success: true, data: { recommendations } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /advisor/quick-wins — High-impact, low-effort recommendations ─────
  app.get('/advisor/quick-wins', async (request, reply) => {
    try {
      const { projectId } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });

      const projectData = await gatherProjectData(Number(projectId));
      if (!projectData.project) return reply.code(404).send({ success: false, error: 'Project not found' });

      const result = await generateRecommendations(projectData);
      const quickWins = (result.priorities || [])
        .filter(r => r.impact === 'high' && r.effort === 'low')
        .map(r => ({
          category: r.category,
          title: r.title,
          description: r.description,
          steps: r.steps || [],
        }));

      // Also include explicit quickWins from Claude
      const extraWins = (result.quickWins || []).map(w => (typeof w === 'string' ? { title: w, description: w } : w));

      return { success: true, data: { quickWins: [...quickWins, ...extraWins] } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /advisor/health-summary — Overall project health ──────────────────
  app.get('/advisor/health-summary', async (request, reply) => {
    try {
      const { projectId } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });
      const pid = Number(projectId);

      const projectData = await gatherProjectData(pid);
      if (!projectData.project) return reply.code(404).send({ success: false, error: 'Project not found' });

      // Calculate dimension scores
      const seo = projectData.auditHealthScore || 50;
      const content = projectData.avgContentScore || 50;

      // Technical: based on audit
      const technical = projectData.auditHealthScore
        ? Math.min(100, projectData.auditHealthScore + (projectData.auditIssueCount < 5 ? 10 : -10))
        : 50;

      // Backlinks: based on count and DR
      const backlinkScore = Math.min(100, (projectData.backlinkCount / 10) * 20 + (projectData.avgDomainRating || 0));

      // GEO: based on visibility rate
      const geo = Math.round(projectData.geoVisibilityRate * 100);

      const dimensions = { seo: Math.round(seo), content: Math.round(content), technical: Math.round(technical), backlinks: Math.round(Math.min(100, backlinkScore)), geo };
      const overall = Math.round(Object.values(dimensions).reduce((a, b) => a + b, 0) / Object.keys(dimensions).length);

      return { success: true, data: { overall, dimensions } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── POST /advisor/analyze — Deep analysis of specific area ────────────────
  app.post('/advisor/analyze', async (request, reply) => {
    try {
      const { projectId, focus } = request.body || {};
      if (!projectId || !focus) {
        return reply.code(400).send({ success: false, error: 'projectId and focus are required' });
      }
      const pid = Number(projectId);

      const projectData = await gatherProjectData(pid);
      if (!projectData.project) return reply.code(404).send({ success: false, error: 'Project not found' });

      const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 4096,
        system: `You are a senior SEO consultant. Perform a deep analysis on the specified focus area. Return ONLY valid JSON.

Output format:
{
  "focus": "...",
  "analysis": {
    "currentState": "...",
    "strengths": ["..."],
    "weaknesses": ["..."],
    "opportunities": ["..."],
    "threats": ["..."]
  },
  "actionItems": [
    { "priority": "high|medium|low", "title": "...", "description": "...", "estimatedImpact": "..." }
  ]
}`,
        messages: [{ role: 'user', content: `Deep analyze the "${focus}" area for project "${projectData.project.name}" (${projectData.project.domain}).\n\nProject data:\n${JSON.stringify(projectData)}` }],
      });

      const text = response.content[0]?.text || '{}';
      let result;
      try { result = JSON.parse(text); } catch { result = { raw: text }; }

      return { success: true, data: { analysis: result.analysis || result, actionItems: result.actionItems || [] } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });
}
