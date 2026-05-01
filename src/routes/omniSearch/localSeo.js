import { prisma } from '../../lib/prisma.js';
import Anthropic from '@anthropic-ai/sdk';
import { AI_MODEL } from '../../lib/omniSearch/omniSearchConfig.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function localSeoRoutes(app) {
  app.addHook('onRequest', async (request, reply) => {
    await app.omniSearchAuth(request, reply);
  });

  // ── POST /local/citations — Create a local citation ───────────────────────
  app.post('/local/citations', async (request, reply) => {
    try {
      const { projectId, platform, listingUrl, businessName, address, phone } = request.body || {};
      if (!projectId || !platform) {
        return reply.code(400).send({ success: false, error: 'projectId and platform are required' });
      }
      const citation = await prisma.omniSearchLocalCitation.create({
        data: {
          projectId: Number(projectId),
          platform,
          listingUrl: listingUrl || null,
          businessName: businessName || null,
          address: address || null,
          phone: phone || null,
        },
      });
      return { success: true, data: citation };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /local/citations — List citations with NAP stats ──────────────────
  app.get('/local/citations', async (request, reply) => {
    try {
      const { projectId, page = 1, limit = 20 } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });

      const where = { projectId: Number(projectId) };
      const skip = (Number(page) - 1) * Number(limit);

      const [citations, total] = await Promise.all([
        prisma.omniSearchLocalCitation.findMany({ where, skip, take: Number(limit), orderBy: { createdAt: 'desc' } }),
        prisma.omniSearchLocalCitation.count({ where }),
      ]);

      const consistent = citations.filter(c => c.napConsistency).length;
      const inconsistent = citations.filter(c => !c.napConsistency).length;

      return {
        success: true,
        data: { citations, total, napStats: { consistent, inconsistent }, page: Number(page), limit: Number(limit) },
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── PUT /local/citations/:id — Update citation ────────────────────────────
  app.put('/local/citations/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { platform, listingUrl, businessName, address, phone, napConsistency, rating, reviewCount, isVerified } = request.body || {};
      const data = {};
      if (platform !== undefined) data.platform = platform;
      if (listingUrl !== undefined) data.listingUrl = listingUrl;
      if (businessName !== undefined) data.businessName = businessName;
      if (address !== undefined) data.address = address;
      if (phone !== undefined) data.phone = phone;
      if (napConsistency !== undefined) data.napConsistency = napConsistency;
      if (rating !== undefined) data.rating = rating;
      if (reviewCount !== undefined) data.reviewCount = reviewCount;
      if (isVerified !== undefined) data.isVerified = isVerified;

      const citation = await prisma.omniSearchLocalCitation.update({ where: { id: Number(id) }, data });
      return { success: true, data: citation };
    } catch (err) {
      if (err.code === 'P2025') return reply.code(404).send({ success: false, error: 'Citation not found' });
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── DELETE /local/citations/:id — Delete citation ─────────────────────────
  app.delete('/local/citations/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      await prisma.omniSearchLocalCitation.delete({ where: { id: Number(id) } });
      return { success: true };
    } catch (err) {
      if (err.code === 'P2025') return reply.code(404).send({ success: false, error: 'Citation not found' });
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /local/nap-check — Check NAP consistency across citations ─────────
  app.get('/local/nap-check', async (request, reply) => {
    try {
      const { projectId } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });

      const citations = await prisma.omniSearchLocalCitation.findMany({
        where: { projectId: Number(projectId) },
        orderBy: { createdAt: 'desc' },
      });

      if (citations.length === 0) {
        return { success: true, data: { consistent: 0, inconsistent: 0, details: [] } };
      }

      // Use the first citation as the reference (canonical NAP)
      const ref = citations[0];
      const details = [];
      let consistent = 0;
      let inconsistent = 0;

      for (const c of citations) {
        const nameMatch = (c.businessName || '').toLowerCase().trim() === (ref.businessName || '').toLowerCase().trim();
        const addressMatch = (c.address || '').toLowerCase().trim() === (ref.address || '').toLowerCase().trim();
        const phoneMatch = (c.phone || '').replace(/\D/g, '') === (ref.phone || '').replace(/\D/g, '');
        const isConsistent = nameMatch && addressMatch && phoneMatch;

        if (isConsistent) consistent++;
        else inconsistent++;

        details.push({
          id: c.id,
          platform: c.platform,
          businessName: c.businessName,
          address: c.address,
          phone: c.phone,
          nameMatch,
          addressMatch,
          phoneMatch,
          isConsistent,
        });

        // Update napConsistency flag
        if (c.napConsistency !== isConsistent) {
          await prisma.omniSearchLocalCitation.update({
            where: { id: c.id },
            data: { napConsistency: isConsistent, lastChecked: new Date() },
          });
        }
      }

      return { success: true, data: { consistent, inconsistent, details } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── POST /local/optimize — GBP optimization suggestions via Claude ────────
  app.post('/local/optimize', async (request, reply) => {
    try {
      const { projectId } = request.body || {};
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });

      const [project, citations] = await Promise.all([
        prisma.omniSearchProject.findUnique({ where: { id: Number(projectId) } }),
        prisma.omniSearchLocalCitation.findMany({ where: { projectId: Number(projectId) } }),
      ]);

      if (!project) return reply.code(404).send({ success: false, error: 'Project not found' });

      const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 4096,
        system: `You are a local SEO expert specializing in Google Business Profile optimization. Analyze the citation data and provide actionable optimization suggestions. Return ONLY valid JSON.

Output format:
{
  "suggestions": [
    { "category": "...", "title": "...", "description": "...", "priority": "high|medium|low", "impact": "...", "steps": ["..."] }
  ]
}`,
        messages: [{
          role: 'user',
          content: `Optimize local SEO for "${project.name}" (${project.domain}).\n\nCurrent citations:\n${JSON.stringify(citations, null, 2)}`,
        }],
      });

      const text = response.content[0]?.text || '{}';
      let suggestions;
      try { suggestions = JSON.parse(text); } catch { suggestions = { raw: text }; }

      return { success: true, data: suggestions };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });
}
