import { prisma } from '../../lib/prisma.js';

export default async function automationRoutes(app) {
  app.addHook('onRequest', async (request, reply) => {
    await app.omniSearchAuth(request, reply);
  });

  const VALID_TYPES = ['content_refresh', 'rank_check', 'geo_monitor', 'audit_schedule', 'link_prospect', 'content_publish'];

  // ── POST /automation/tasks — Create automation task ────────────────────────
  app.post('/automation/tasks', async (request, reply) => {
    try {
      const { projectId, type, name, config, schedule } = request.body || {};
      if (!projectId || !type || !name) {
        return reply.code(400).send({ success: false, error: 'projectId, type, and name are required' });
      }
      if (!VALID_TYPES.includes(type)) {
        return reply.code(400).send({ success: false, error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` });
      }

      const task = await prisma.omniSearchAutomationTask.create({
        data: {
          projectId: Number(projectId),
          type,
          name,
          config: config ? (typeof config === 'string' ? config : JSON.stringify(config)) : '{}',
          schedule: schedule || null,
        },
      });
      return { success: true, data: task };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /automation/tasks — List tasks ─────────────────────────────────────
  app.get('/automation/tasks', async (request, reply) => {
    try {
      const { projectId, status, page = 1, limit = 20 } = request.query;
      if (!projectId) return reply.code(400).send({ success: false, error: 'projectId is required' });

      const where = { projectId: Number(projectId) };
      if (status) where.status = status;
      const skip = (Number(page) - 1) * Number(limit);

      const [tasks, total] = await Promise.all([
        prisma.omniSearchAutomationTask.findMany({
          where,
          skip,
          take: Number(limit),
          orderBy: { createdAt: 'desc' },
        }),
        prisma.omniSearchAutomationTask.count({ where }),
      ]);

      const parsed = tasks.map(t => {
        let config;
        try { config = JSON.parse(t.config); } catch { config = t.config; }
        let lastResult;
        try { lastResult = t.lastResult ? JSON.parse(t.lastResult) : null; } catch { lastResult = t.lastResult; }
        return { ...t, config, lastResult };
      });

      return { success: true, data: { tasks: parsed, total, page: Number(page), limit: Number(limit) } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── GET /automation/tasks/:id — Get single task ────────────────────────────
  app.get('/automation/tasks/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const task = await prisma.omniSearchAutomationTask.findUnique({ where: { id: Number(id) } });
      if (!task) return reply.code(404).send({ success: false, error: 'Task not found' });

      let config;
      try { config = JSON.parse(task.config); } catch { config = task.config; }
      let lastResult;
      try { lastResult = task.lastResult ? JSON.parse(task.lastResult) : null; } catch { lastResult = task.lastResult; }

      return { success: true, data: { ...task, config, lastResult } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── PUT /automation/tasks/:id — Update task ────────────────────────────────
  app.put('/automation/tasks/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { name, config, schedule, status } = request.body || {};
      const data = {};
      if (name !== undefined) data.name = name;
      if (config !== undefined) data.config = typeof config === 'string' ? config : JSON.stringify(config);
      if (schedule !== undefined) data.schedule = schedule;
      if (status !== undefined) data.status = status;

      const task = await prisma.omniSearchAutomationTask.update({ where: { id: Number(id) }, data });
      return { success: true, data: task };
    } catch (err) {
      if (err.code === 'P2025') return reply.code(404).send({ success: false, error: 'Task not found' });
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── POST /automation/tasks/:id/run — Manually trigger a task ───────────────
  app.post('/automation/tasks/:id/run', async (request, reply) => {
    try {
      const { id } = request.params;
      const task = await prisma.omniSearchAutomationTask.findUnique({
        where: { id: Number(id) },
        include: { project: true },
      });
      if (!task) return reply.code(404).send({ success: false, error: 'Task not found' });

      let config;
      try { config = JSON.parse(task.config); } catch { config = {}; }

      let result = {};
      const now = new Date();

      switch (task.type) {
        case 'rank_check': {
          const keywords = await prisma.omniSearchKeyword.findMany({
            where: { projectId: task.projectId, isTracked: true },
            take: config.limit || 50,
          });
          result = { type: 'rank_check', keywordsChecked: keywords.length, timestamp: now.toISOString() };
          break;
        }
        case 'geo_monitor': {
          const prompts = await prisma.omniSearchGeoPrompt.findMany({
            where: { projectId: task.projectId, isActive: true },
          });
          result = { type: 'geo_monitor', promptsFound: prompts.length, timestamp: now.toISOString() };
          break;
        }
        case 'audit_schedule': {
          const auditCount = await prisma.omniSearchAudit.count({ where: { projectId: task.projectId } });
          result = { type: 'audit_schedule', existingAudits: auditCount, timestamp: now.toISOString() };
          break;
        }
        case 'content_refresh': {
          const sessions = await prisma.omniSearchContentSession.findMany({
            where: { projectId: task.projectId },
            orderBy: { updatedAt: 'asc' },
            take: config.limit || 10,
          });
          result = { type: 'content_refresh', sessionsToRefresh: sessions.length, timestamp: now.toISOString() };
          break;
        }
        case 'link_prospect': {
          const outreachCount = await prisma.omniSearchOutreach.count({
            where: { projectId: task.projectId, status: 'prospect' },
          });
          result = { type: 'link_prospect', currentProspects: outreachCount, timestamp: now.toISOString() };
          break;
        }
        case 'content_publish': {
          const drafts = await prisma.omniSearchContentSession.findMany({
            where: { projectId: task.projectId, status: 'draft' },
            take: config.limit || 5,
          });
          result = { type: 'content_publish', draftsReady: drafts.length, timestamp: now.toISOString() };
          break;
        }
        default:
          result = { type: task.type, message: 'Unknown task type', timestamp: now.toISOString() };
      }

      // Update task run metadata
      await prisma.omniSearchAutomationTask.update({
        where: { id: Number(id) },
        data: {
          lastRun: now,
          runCount: { increment: 1 },
          lastResult: JSON.stringify(result),
        },
      });

      return { success: true, data: { result } };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // ── DELETE /automation/tasks/:id — Delete task ─────────────────────────────
  app.delete('/automation/tasks/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      await prisma.omniSearchAutomationTask.delete({ where: { id: Number(id) } });
      return { success: true };
    } catch (err) {
      if (err.code === 'P2025') return reply.code(404).send({ success: false, error: 'Task not found' });
      request.log.error(err);
      return reply.code(500).send({ success: false, error: err.message });
    }
  });
}
