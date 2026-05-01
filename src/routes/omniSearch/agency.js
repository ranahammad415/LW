import { prisma } from '../../lib/prisma.js';

export default async function agencyRoutes(app) {
  app.addHook('onRequest', async (request, reply) => {
    await app.omniSearchAuth(request, reply);
  });

  // ── POST /agency/projects — Create project ────────────────────────────────
  app.post('/agency/projects', async (request, reply) => {
    try {
      const { name, domain, description, settings } = request.body || {};
      if (!name || !domain) {
        return reply.code(400).send({ success: false, error: 'name and domain are required' });
      }
      const project = await prisma.omniSearchProject.create({
        data: {
          name,
          domain,
          description: description || null,
          settings: settings ? JSON.stringify(settings) : null,
        },
      });
      return { success: true, data: project };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /agency/projects — List projects with stats ───────────────────────
  app.get('/agency/projects', async (request, reply) => {
    try {
      const { page = 1, limit = 20, search } = request.query;
      const where = {};
      if (search) {
        where.OR = [
          { name: { contains: search } },
          { domain: { contains: search } },
        ];
      }
      const skip = (Number(page) - 1) * Number(limit);

      const [projects, total] = await Promise.all([
        prisma.omniSearchProject.findMany({
          where,
          skip,
          take: Number(limit),
          orderBy: { createdAt: 'desc' },
          include: {
            _count: {
              select: {
                keywords: true,
                contentSessions: true,
                backlinks: true,
                geoPrompts: true,
                localCitations: true,
              },
            },
            audits: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { healthScore: true },
            },
          },
        }),
        prisma.omniSearchProject.count({ where }),
      ]);

      const data = projects.map(p => ({
        ...p,
        stats: {
          keywords: p._count.keywords,
          contentSessions: p._count.contentSessions,
          backlinks: p._count.backlinks,
          geoPrompts: p._count.geoPrompts,
          localCitations: p._count.localCitations,
          lastAuditScore: p.audits[0]?.healthScore || null,
        },
        _count: undefined,
        audits: undefined,
      }));

      return { success: true, data: { projects: data, total, page: Number(page), limit: Number(limit) } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /agency/projects/:id — Get project with summary metrics ───────────
  app.get('/agency/projects/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const project = await prisma.omniSearchProject.findUnique({
        where: { id: Number(id) },
        include: {
          _count: {
            select: {
              keywords: true,
              contentSessions: true,
              backlinks: true,
              geoPrompts: true,
              localCitations: true,
              reports: true,
              automationTasks: true,
              outreaches: true,
            },
          },
          audits: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      });
      if (!project) return reply.code(404).send({ success: false, error: 'Project not found' });

      let parsedSettings;
      try { parsedSettings = project.settings ? JSON.parse(project.settings) : null; } catch { parsedSettings = project.settings; }

      return {
        success: true,
        data: {
          ...project,
          settings: parsedSettings,
          metrics: {
            keywords: project._count.keywords,
            contentSessions: project._count.contentSessions,
            backlinks: project._count.backlinks,
            geoPrompts: project._count.geoPrompts,
            localCitations: project._count.localCitations,
            reports: project._count.reports,
            automationTasks: project._count.automationTasks,
            outreaches: project._count.outreaches,
            lastAuditScore: project.audits[0]?.healthScore || null,
          },
          _count: undefined,
          audits: undefined,
        },
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── PUT /agency/projects/:id — Update project ─────────────────────────────
  app.put('/agency/projects/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { name, domain, description, settings } = request.body || {};
      const data = {};
      if (name !== undefined) data.name = name;
      if (domain !== undefined) data.domain = domain;
      if (description !== undefined) data.description = description;
      if (settings !== undefined) data.settings = typeof settings === 'string' ? settings : JSON.stringify(settings);

      const project = await prisma.omniSearchProject.update({ where: { id: Number(id) }, data });
      return { success: true, data: project };
    } catch (err) {
      if (err.code === 'P2025') return reply.code(404).send({ success: false, error: 'Project not found' });
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── DELETE /agency/projects/:id — Delete project (cascade) ────────────────
  app.delete('/agency/projects/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      await prisma.omniSearchProject.delete({ where: { id: Number(id) } });
      return { success: true };
    } catch (err) {
      if (err.code === 'P2025') return reply.code(404).send({ success: false, error: 'Project not found' });
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /agency/overview — Aggregate across all projects ──────────────────
  app.get('/agency/overview', async (request, reply) => {
    try {
      const [
        totalProjects,
        totalKeywords,
        totalBacklinks,
        audits,
      ] = await Promise.all([
        prisma.omniSearchProject.count(),
        prisma.omniSearchKeyword.count(),
        prisma.omniSearchBacklink.count({ where: { isActive: true } }),
        prisma.omniSearchAudit.findMany({
          where: { healthScore: { not: null } },
          orderBy: { createdAt: 'desc' },
          select: { healthScore: true, projectId: true },
        }),
      ]);

      // Get latest health score per project
      const seenProjects = new Set();
      const healthScores = [];
      for (const a of audits) {
        if (!seenProjects.has(a.projectId)) {
          seenProjects.add(a.projectId);
          healthScores.push(a.healthScore);
        }
      }
      const avgHealth = healthScores.length > 0
        ? Math.round((healthScores.reduce((a, b) => a + b, 0) / healthScores.length) * 10) / 10
        : null;

      return {
        success: true,
        data: { totalProjects, totalKeywords, totalBacklinks, avgHealth },
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });
}
