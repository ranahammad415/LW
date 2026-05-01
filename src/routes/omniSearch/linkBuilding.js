import { prisma } from '../../lib/prisma.js';
import Anthropic from '@anthropic-ai/sdk';
import { AI_MODEL } from '../../lib/omniSearch/omniSearchConfig.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function linkBuildingRoutes(app) {
  app.addHook('onRequest', async (request, reply) => {
    await app.omniSearchAuth(request, reply);
  });

  // ── POST /link-building/outreach — Create outreach record ─────────────────
  app.post('/link-building/outreach', async (request, reply) => {
    try {
      const { projectId, targetDomain, targetUrl, contactName, contactEmail, domainRating, notes } = request.body || {};
      if (!projectId || !targetDomain) {
        return reply.code(400).send({ success: false, error: 'projectId and targetDomain are required' });
      }
      const outreach = await prisma.omniSearchOutreach.create({
        data: {
          projectId: Number(projectId),
          targetDomain,
          targetUrl: targetUrl || null,
          contactName: contactName || null,
          contactEmail: contactEmail || null,
          domainRating: domainRating ? Number(domainRating) : null,
          notes: notes || null,
        },
      });
      return { success: true, data: outreach };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /link-building/outreach — List outreach records ───────────────────
  app.get('/link-building/outreach', async (request, reply) => {
    try {
      const { projectId, status, page = 1, limit = 20 } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });

      const where = { projectId: Number(projectId) };
      if (status) where.status = status;
      const skip = (Number(page) - 1) * Number(limit);

      const [records, total] = await Promise.all([
        prisma.omniSearchOutreach.findMany({
          where,
          skip,
          take: Number(limit),
          orderBy: { createdAt: 'desc' },
        }),
        prisma.omniSearchOutreach.count({ where }),
      ]);

      return { success: true, data: { outreach: records, total, page: Number(page), limit: Number(limit) } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /link-building/outreach/:id — Get single outreach record ──────────
  app.get('/link-building/outreach/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const outreach = await prisma.omniSearchOutreach.findUnique({ where: { id: Number(id) } });
      if (!outreach) return reply.code(404).send({ success: false, error: 'Outreach record not found' });
      return { success: true, data: outreach };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── PUT /link-building/outreach/:id — Update outreach record ──────────────
  app.put('/link-building/outreach/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { status, notes, contactName, contactEmail, targetUrl, domainRating, emailSubject, emailBody, sentAt, repliedAt } = request.body || {};
      const data = {};
      if (status !== undefined) data.status = status;
      if (notes !== undefined) data.notes = notes;
      if (contactName !== undefined) data.contactName = contactName;
      if (contactEmail !== undefined) data.contactEmail = contactEmail;
      if (targetUrl !== undefined) data.targetUrl = targetUrl;
      if (domainRating !== undefined) data.domainRating = Number(domainRating);
      if (emailSubject !== undefined) data.emailSubject = emailSubject;
      if (emailBody !== undefined) data.emailBody = emailBody;
      if (sentAt !== undefined) data.sentAt = new Date(sentAt);
      if (repliedAt !== undefined) data.repliedAt = new Date(repliedAt);

      const outreach = await prisma.omniSearchOutreach.update({ where: { id: Number(id) }, data });
      return { success: true, data: outreach };
    } catch (err) {
      if (err.code === 'P2025') return reply.code(404).send({ success: false, error: 'Outreach record not found' });
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── DELETE /link-building/outreach/:id — Delete outreach record ───────────
  app.delete('/link-building/outreach/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      await prisma.omniSearchOutreach.delete({ where: { id: Number(id) } });
      return { success: true };
    } catch (err) {
      if (err.code === 'P2025') return reply.code(404).send({ success: false, error: 'Outreach record not found' });
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── POST /link-building/discover — AI-powered prospect discovery ──────────
  app.post('/link-building/discover', async (request, reply) => {
    try {
      const { projectId, niche, count = 20 } = request.body || {};
      if (!projectId || !niche) {
        return reply.code(400).send({ success: false, error: 'projectId and niche are required' });
      }

      const project = await prisma.omniSearchProject.findUnique({ where: { id: Number(projectId) } });
      if (!project) return reply.code(404).send({ success: false, error: 'Project not found' });

      const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 4096,
        system: `You are a link building expert. Suggest high-quality link building prospects for the given domain and niche. Return ONLY valid JSON.

Output format:
{
  "prospects": [
    { "domain": "...", "domainRating": <0-100>, "contactEmail": "...", "reason": "...", "linkType": "guest_post|resource|broken_link|skyscraper|mention" }
  ]
}`,
        messages: [{ role: 'user', content: `Suggest ${count} link building prospects for "${project.domain}" in the "${niche}" niche.` }],
      });

      const text = response.content[0]?.text || '{}';
      let result;
      try { result = JSON.parse(text); } catch { result = { raw: text }; }

      return { success: true, data: { prospects: result.prospects || [] } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });
}
