import { prisma } from '../../lib/prisma.js';
import Anthropic from '@anthropic-ai/sdk';
import { AI_MODEL as OMNISEARCH_AI_MODEL } from '../../lib/omniSearch/omniSearchConfig.js';
import { fetchBacklinks } from '../../lib/omniSearch/backlinkProvider.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const AI_MODEL = OMNISEARCH_AI_MODEL;

export default async function backlinksRoutes(app) {
  app.addHook('onRequest', async (request, reply) => {
    await app.omniSearchAuth(request, reply);
  });

  // ─── GET /backlinks/:domain ───────────────────────────────────────────────
  app.get('/backlinks/:domain', async (request, reply) => {
    try {
      const domain = request.params.domain;
      const { page = 1, limit = 50, sort = 'domainRating', order = 'desc' } = request.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      // Find project by domain
      const project = await prisma.omniSearchProject.findFirst({ where: { domain: { contains: domain } } });
      if (!project) return reply.code(404).send({ success: false, error: 'Project not found for this domain' });

      const orderBy = {};
      orderBy[sort] = order;

      const [backlinks, total] = await Promise.all([
        prisma.omniSearchBacklink.findMany({ where: { projectId: project.id }, skip, take, orderBy }),
        prisma.omniSearchBacklink.count({ where: { projectId: project.id } }),
      ]);

      // Calculate summary
      const allBacklinks = await prisma.omniSearchBacklink.findMany({
        where: { projectId: project.id },
        select: { domainRating: true, isDoFollow: true, sourceDomain: true, isActive: true },
      });

      const doFollow = allBacklinks.filter(b => b.isDoFollow).length;
      const noFollow = allBacklinks.length - doFollow;
      const avgDomainRating = allBacklinks.length > 0
        ? Math.round(allBacklinks.reduce((sum, b) => sum + (b.domainRating || 0), 0) / allBacklinks.length)
        : 0;
      const uniqueDomains = new Set(allBacklinks.map(b => b.sourceDomain)).size;

      return {
        success: true,
        data: {
          backlinks,
          total,
          summary: { totalBacklinks: allBacklinks.length, doFollow, noFollow, avgDomainRating, uniqueDomains },
        },
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── GET /backlinks/:domain/new-links ─────────────────────────────────────
  app.get('/backlinks/:domain/new-links', async (request, reply) => {
    try {
      const domain = request.params.domain;
      const { days = 30, page = 1, limit = 50 } = request.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);
      const since = new Date(Date.now() - parseInt(days) * 86400000);

      const project = await prisma.omniSearchProject.findFirst({ where: { domain: { contains: domain } } });
      if (!project) return reply.code(404).send({ success: false, error: 'Project not found for this domain' });

      const where = { projectId: project.id, firstSeen: { gte: since } };
      const [newLinks, total] = await Promise.all([
        prisma.omniSearchBacklink.findMany({ where, skip, take, orderBy: { firstSeen: 'desc' } }),
        prisma.omniSearchBacklink.count({ where }),
      ]);

      return { success: true, data: { newLinks, total } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── GET /backlinks/:domain/lost-links ────────────────────────────────────
  app.get('/backlinks/:domain/lost-links', async (request, reply) => {
    try {
      const domain = request.params.domain;
      const { days = 30, page = 1, limit = 50 } = request.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);
      const since = new Date(Date.now() - parseInt(days) * 86400000);

      const project = await prisma.omniSearchProject.findFirst({ where: { domain: { contains: domain } } });
      if (!project) return reply.code(404).send({ success: false, error: 'Project not found for this domain' });

      const where = { projectId: project.id, isActive: false, lastSeen: { gte: since } };
      const [lostLinks, total] = await Promise.all([
        prisma.omniSearchBacklink.findMany({ where, skip, take, orderBy: { lastSeen: 'desc' } }),
        prisma.omniSearchBacklink.count({ where }),
      ]);

      return { success: true, data: { lostLinks, total } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── POST /backlinks/discover ─────────────────────────────────────────────
  app.post('/backlinks/discover', async (request, reply) => {
    try {
      const { projectId, domain, limit = 50 } = request.body || {};
      if (!projectId || !domain) {
        return reply.code(400).send({ success: false, error: 'projectId and domain are required' });
      }

      const result = await fetchBacklinks(domain, Number(limit));
      const dataSource = result.dataSource;

      const created = [];
      for (const bl of result.backlinks || []) {
        const entry = await prisma.omniSearchBacklink.create({
          data: {
            projectId: parseInt(projectId),
            sourceUrl: bl.sourceUrl || '',
            sourceDomain: bl.sourceDomain || '',
            targetUrl: bl.targetUrl || `https://${domain}`,
            anchorText: bl.anchorText || null,
            domainRating: bl.domainAuthority ?? null,
            trustFlow: null,
            citationFlow: null,
            isDoFollow: bl.linkType !== 'nofollow',
            isActive: true,
            spamScore: bl.spamScore ?? null,
            firstSeen: bl.firstSeen ? new Date(bl.firstSeen) : undefined,
            lastSeen: bl.lastSeen ? new Date(bl.lastSeen) : undefined,
            dataSource,
          },
        });
        created.push(entry);
      }

      return {
        success: true,
        data: { discovered: created.length, backlinks: created, dataSource },
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── POST /disavow/:projectId/add ────────────────────────────────────────
  app.post('/disavow/:projectId/add', async (request, reply) => {
    try {
      const { backlinkId, reason, scope = 'domain' } = request.body || {};
      if (!backlinkId || !reason) {
        return reply.code(400).send({ success: false, error: 'backlinkId and reason are required' });
      }

      const entry = await prisma.omniSearchDisavowEntry.create({
        data: {
          backlinkId: parseInt(backlinkId),
          reason,
          status: 'flagged',
          scope,
        },
      });

      return { success: true, data: entry };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── GET /disavow/:projectId/list ─────────────────────────────────────────
  app.get('/disavow/:projectId/list', async (request, reply) => {
    try {
      const projectId = parseInt(request.params.projectId);
      const { page = 1, limit = 50, status } = request.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      const where = { backlink: { projectId } };
      if (status) where.status = status;

      const [entries, total] = await Promise.all([
        prisma.omniSearchDisavowEntry.findMany({
          where,
          skip,
          take,
          include: { backlink: true },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.omniSearchDisavowEntry.count({ where }),
      ]);

      return { success: true, data: { entries, total } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── GET /disavow/:projectId/export ───────────────────────────────────────
  app.get('/disavow/:projectId/export', async (request, reply) => {
    try {
      const projectId = parseInt(request.params.projectId);

      const project = await prisma.omniSearchProject.findUnique({ where: { id: projectId } });
      if (!project) return reply.code(404).send({ success: false, error: 'Project not found' });

      const entries = await prisma.omniSearchDisavowEntry.findMany({
        where: { backlink: { projectId } },
        include: { backlink: { select: { sourceDomain: true, sourceUrl: true } } },
      });

      const today = new Date().toISOString().split('T')[0];
      const lines = [
        `# Disavow file generated by OmniSearch`,
        `# Project: ${project.domain}`,
        `# Date: ${today}`,
        `# Total entries: ${entries.length}`,
        '',
      ];

      // Group by scope: domain-level disavows first, then URL-level.
      const domainEntries = entries.filter((e) => e.scope !== 'url');
      const urlEntries = entries.filter((e) => e.scope === 'url');

      const seenDomains = new Set();
      for (const e of domainEntries) {
        const d = e.backlink.sourceDomain;
        if (!d || seenDomains.has(d)) continue;
        seenDomains.add(d);
        if (e.reason) lines.push(`# ${e.reason}`);
        lines.push(`domain:${d}`);
      }
      for (const e of urlEntries) {
        const u = e.backlink.sourceUrl;
        if (!u) continue;
        if (e.reason) lines.push(`# ${e.reason}`);
        lines.push(u);
      }

      const content = lines.join('\n');

      reply.header('Content-Type', 'text/plain');
      reply.header('Content-Disposition', `attachment; filename="disavow-${project.domain}-${today}.txt"`);
      return reply.send(content);
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── POST /disavow/:projectId/auto-detect ─────────────────────────────────
  // Scans the project's backlinks and flags toxic ones (high spam score OR
  // very low domain rating on dofollow links) into the disavow queue.
  app.post('/disavow/:projectId/auto-detect', async (request, reply) => {
    try {
      const projectId = parseInt(request.params.projectId);
      const {
        minSpamScore = 5,
        maxDomainRating = 10,
        dryRun = false,
      } = request.body || {};

      const backlinks = await prisma.omniSearchBacklink.findMany({
        where: { projectId, isActive: true },
        include: { disavow: true },
      });

      const candidates = [];
      for (const bl of backlinks) {
        if (bl.disavow) continue; // already flagged
        const spamScore = bl.spamScore ?? 0;
        const dr = bl.domainRating ?? 100;
        const reasons = [];
        if (spamScore >= minSpamScore) reasons.push(`high_spam_score:${spamScore}`);
        if (dr <= maxDomainRating && bl.isDoFollow) reasons.push(`low_dr_dofollow:${dr}`);
        if (reasons.length > 0) {
          candidates.push({ backlink: bl, reason: reasons.join(',') });
        }
      }

      if (dryRun) {
        return {
          success: true,
          data: {
            dryRun: true,
            flagged: candidates.length,
            candidates: candidates.map((c) => ({
              backlinkId: c.backlink.id,
              sourceDomain: c.backlink.sourceDomain,
              sourceUrl: c.backlink.sourceUrl,
              domainRating: c.backlink.domainRating,
              spamScore: c.backlink.spamScore,
              reason: c.reason,
            })),
          },
        };
      }

      const created = [];
      for (const c of candidates) {
        const entry = await prisma.omniSearchDisavowEntry.create({
          data: {
            backlinkId: c.backlink.id,
            reason: c.reason,
            status: 'flagged',
          },
        });
        created.push(entry);
      }

      return { success: true, data: { flagged: created.length, entries: created } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── DELETE /disavow/:projectId/:entryId ──────────────────────────────────
  app.delete('/disavow/:projectId/:entryId', async (request, reply) => {
    try {
      const entryId = parseInt(request.params.entryId);
      await prisma.omniSearchDisavowEntry.delete({ where: { id: entryId } });
      return { success: true, data: { deleted: entryId } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ─── POST /backlinks/batch-check ──────────────────────────────────────────
  app.post('/backlinks/batch-check', async (request, reply) => {
    try {
      const { domains } = request.body || {};
      if (!domains || !Array.isArray(domains) || domains.length === 0) {
        return reply.code(400).send({ success: false, error: 'domains array is required' });
      }

      const results = [];
      for (const domain of domains) {
        const project = await prisma.omniSearchProject.findFirst({ where: { domain: { contains: domain } } });
        if (!project) {
          results.push({ domain, totalBacklinks: 0, avgDR: 0, doFollowRatio: 0 });
          continue;
        }

        const backlinks = await prisma.omniSearchBacklink.findMany({
          where: { projectId: project.id },
          select: { domainRating: true, isDoFollow: true },
        });

        const total = backlinks.length;
        const avgDR = total > 0
          ? Math.round(backlinks.reduce((sum, b) => sum + (b.domainRating || 0), 0) / total)
          : 0;
        const doFollowRatio = total > 0
          ? Math.round((backlinks.filter(b => b.isDoFollow).length / total) * 100)
          : 0;

        results.push({ domain, totalBacklinks: total, avgDR, doFollowRatio });
      }

      return { success: true, data: { results } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });
}
