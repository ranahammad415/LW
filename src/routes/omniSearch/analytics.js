import { prisma } from '../../lib/prisma.js';
import Anthropic from '@anthropic-ai/sdk';
import { AI_MODEL } from '../../lib/omniSearch/omniSearchConfig.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function analyticsRoutes(app) {
  app.addHook('onRequest', async (request, reply) => {
    await app.omniSearchAuth(request, reply);
  });

  // ── GET /analytics/dashboard — Aggregate overview ─────────────────────────
  app.get('/analytics/dashboard', async (request, reply) => {
    try {
      const { projectId } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });
      const pid = Number(projectId);

      const [
        keywordCount,
        rankHistory,
        contentSessions,
        latestAudit,
        backlinkCount,
        geoResponses,
      ] = await Promise.all([
        prisma.omniSearchKeyword.count({ where: { projectId: pid } }),
        prisma.omniSearchRankHistory.findMany({
          where: { keyword: { projectId: pid } },
          orderBy: { checkedAt: 'desc' },
          take: 500,
        }),
        prisma.omniSearchContentSession.count({ where: { projectId: pid } }),
        prisma.omniSearchAudit.findFirst({ where: { projectId: pid }, orderBy: { createdAt: 'desc' } }),
        prisma.omniSearchBacklink.count({ where: { projectId: pid, isActive: true } }),
        prisma.omniSearchGeoResponse.findMany({
          where: { prompt: { projectId: pid } },
          orderBy: { checkedAt: 'desc' },
          take: 200,
        }),
      ]);

      const positions = rankHistory.filter(r => r.position !== null).map(r => r.position);
      const avgRank = positions.length > 0 ? positions.reduce((a, b) => a + b, 0) / positions.length : null;

      const geoTotal = geoResponses.length;
      const geoMentioned = geoResponses.filter(r => r.brandMentioned).length;
      const geoPositive = geoResponses.filter(r => r.sentiment === 'positive').length;
      const geoCited = geoResponses.filter(r => r.citationUrl).length;
      const mentionRate = geoTotal > 0 ? geoMentioned / geoTotal : 0;
      const posRate = geoTotal > 0 ? geoPositive / geoTotal : 0;
      const citRate = geoTotal > 0 ? geoCited / geoTotal : 0;
      const geoBVI = (mentionRate * 40) + (posRate * 30) + (citRate * 30);

      return {
        success: true,
        data: {
          overview: {
            totalKeywords: keywordCount,
            avgRank: avgRank ? Math.round(avgRank * 10) / 10 : null,
            contentSessions,
            auditHealthScore: latestAudit?.healthScore || null,
            backlinkCount,
            geoBVI: Math.round(geoBVI * 100) / 100,
          },
        },
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── POST /analytics/reports — Generate and save a report ──────────────────
  app.post('/analytics/reports', async (request, reply) => {
    try {
      const { projectId, type, title, period, startDate, endDate } = request.body || {};
      if (!projectId || !type || !title || !period) {
        return reply.code(400).send({ success: false, error: 'projectId, type, title, and period are required' });
      }
      const pid = Number(projectId);
      const validTypes = ['seo_overview', 'rank_report', 'content_report', 'geo_report', 'backlink_report', 'full_report'];
      if (!validTypes.includes(type)) {
        return reply.code(400).send({ success: false, error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
      }

      // Gather data based on type
      const reportData = {};
      if (type === 'seo_overview' || type === 'full_report') {
        reportData.keywords = await prisma.omniSearchKeyword.count({ where: { projectId: pid } });
        reportData.latestAudit = await prisma.omniSearchAudit.findFirst({ where: { projectId: pid }, orderBy: { createdAt: 'desc' } });
        reportData.backlinks = await prisma.omniSearchBacklink.count({ where: { projectId: pid } });
      }
      if (type === 'rank_report' || type === 'full_report') {
        reportData.rankings = await prisma.omniSearchRankHistory.findMany({
          where: { keyword: { projectId: pid } },
          orderBy: { checkedAt: 'desc' },
          take: 200,
          include: { keyword: { select: { keyword: true } } },
        });
      }
      if (type === 'content_report' || type === 'full_report') {
        reportData.contentSessions = await prisma.omniSearchContentSession.findMany({
          where: { projectId: pid },
          orderBy: { createdAt: 'desc' },
          take: 50,
        });
      }
      if (type === 'geo_report' || type === 'full_report') {
        reportData.geoResponses = await prisma.omniSearchGeoResponse.findMany({
          where: { prompt: { projectId: pid } },
          orderBy: { checkedAt: 'desc' },
          take: 100,
        });
      }
      if (type === 'backlink_report' || type === 'full_report') {
        reportData.backlinks = await prisma.omniSearchBacklink.findMany({
          where: { projectId: pid },
          orderBy: { firstSeen: 'desc' },
          take: 100,
        });
      }

      // Use Claude to generate narrative
      const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 4096,
        system: `You are an SEO analytics report writer. Generate a professional, data-driven narrative report. Return ONLY valid JSON.

Output format:
{
  "narrative": "...",
  "keyFindings": ["..."],
  "recommendations": ["..."],
  "metrics": { "key": "value" }
}`,
        messages: [{ role: 'user', content: `Generate a ${type} report titled "${title}" for period ${period}.\n\nData:\n${JSON.stringify(reportData)}` }],
      });

      const text = response.content[0]?.text || '{}';
      let narrativeData;
      try { narrativeData = JSON.parse(text); } catch { narrativeData = { raw: text }; }

      const finalData = { ...reportData, narrative: narrativeData };
      const report = await prisma.omniSearchReport.create({
        data: {
          projectId: pid,
          type,
          title,
          data: JSON.stringify(finalData),
          period,
          startDate: startDate ? new Date(startDate) : null,
          endDate: endDate ? new Date(endDate) : null,
        },
      });

      return { success: true, data: report };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /analytics/reports — List reports ─────────────────────────────────
  app.get('/analytics/reports', async (request, reply) => {
    try {
      const { projectId, type, page = 1, limit = 20 } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });

      const where = { projectId: Number(projectId) };
      if (type) where.type = type;
      const skip = (Number(page) - 1) * Number(limit);

      const [reports, total] = await Promise.all([
        prisma.omniSearchReport.findMany({
          where,
          skip,
          take: Number(limit),
          orderBy: { createdAt: 'desc' },
          select: { id: true, type: true, title: true, period: true, startDate: true, endDate: true, format: true, createdAt: true },
        }),
        prisma.omniSearchReport.count({ where }),
      ]);

      return { success: true, data: { reports, total, page: Number(page), limit: Number(limit) } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /analytics/reports/:id — Get full report ──────────────────────────
  app.get('/analytics/reports/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const report = await prisma.omniSearchReport.findUnique({ where: { id: Number(id) } });
      if (!report) return reply.code(404).send({ success: false, error: 'Report not found' });

      let parsedData;
      try { parsedData = JSON.parse(report.data); } catch { parsedData = report.data; }

      return { success: true, data: { ...report, data: parsedData } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── DELETE /analytics/reports/:id — Delete report ─────────────────────────
  app.delete('/analytics/reports/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      await prisma.omniSearchReport.delete({ where: { id: Number(id) } });
      return { success: true };
    } catch (err) {
      if (err.code === 'P2025') return reply.code(404).send({ success: false, error: 'Report not found' });
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /analytics/traffic — Estimated traffic from rank positions ────────
  app.get('/analytics/traffic', async (request, reply) => {
    try {
      const { projectId, days = 30 } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });

      const since = new Date();
      since.setDate(since.getDate() - Number(days));

      const keywords = await prisma.omniSearchKeyword.findMany({
        where: { projectId: Number(projectId) },
        include: {
          rankHistory: {
            where: { checkedAt: { gte: since } },
            orderBy: { checkedAt: 'desc' },
            take: 1,
          },
        },
      });

      // CTR curve by position
      const ctrByPosition = {
        1: 0.316, 2: 0.241, 3: 0.186, 4: 0.131, 5: 0.095,
        6: 0.063, 7: 0.047, 8: 0.031, 9: 0.024, 10: 0.022,
      };

      let estimatedMonthlyTraffic = 0;
      const byKeyword = [];

      for (const kw of keywords) {
        const latestRank = kw.rankHistory[0];
        const position = latestRank?.position;
        const volume = kw.volume || 0;
        const ctr = position && position <= 10 ? (ctrByPosition[position] || 0.01) : (position && position <= 20 ? 0.005 : 0);
        const traffic = Math.round(volume * ctr);

        estimatedMonthlyTraffic += traffic;
        byKeyword.push({
          keyword: kw.keyword,
          volume,
          position,
          ctr: Math.round(ctr * 10000) / 100,
          estimatedTraffic: traffic,
        });
      }

      byKeyword.sort((a, b) => b.estimatedTraffic - a.estimatedTraffic);

      return { success: true, data: { estimatedMonthlyTraffic, byKeyword } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });
}
