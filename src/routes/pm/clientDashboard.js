import { prisma } from '../../lib/prisma.js';
import { isGscEnabled, verifySiteAccess } from '../../lib/gscClient.js';
import { syncProject } from '../../lib/gscSync.js';

/**
 * PM routes for managing client-facing dashboard data:
 *   POST /clients/:clientId/metrics       — upsert key metric snapshots
 *   GET  /clients/:clientId/metrics       — get latest metric snapshots
 *   POST /clients/:clientId/roi           — upsert ROI configuration
 *   GET  /clients/:clientId/roi           — get ROI configuration
 *   POST /clients/:clientId/pm-update     — post a new PM update message
 *   GET  /clients/:clientId/pm-updates    — list recent PM update messages
 *   PUT  /clients/:clientId/health-score  — manually set health score
 */
export async function pmClientDashboardRoutes(app) {

  // Helper: verify PM has access to this client (is leadPm or secondaryPm)
  async function verifyPmClientAccess(request, reply) {
    const { clientId } = request.params;
    const userId = request.user.id;
    const userRole = request.user.role;

    // Owners can access any client
    if (userRole === 'OWNER') return;

    const client = await prisma.clientAccount.findUnique({
      where: { id: clientId },
      select: { leadPmId: true, secondaryPmId: true },
    });

    if (!client) {
      return reply.status(404).send({ message: 'Client not found' });
    }

    if (client.leadPmId !== userId && client.secondaryPmId !== userId) {
      return reply.status(403).send({ message: 'You are not assigned to this client' });
    }
  }

  // ─── METRICS ─────────────────────────────────────────────

  app.post(
    '/clients/:clientId/metrics',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { clientId: { type: 'string' } },
          required: ['clientId'],
        },
        body: {
          type: 'object',
          properties: {
            metrics: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  metricType: { type: 'string' },
                  value: { type: 'string' },
                  label: { type: 'string', nullable: true },
                  change: { type: 'string', nullable: true },
                },
                required: ['metricType', 'value'],
              },
            },
          },
          required: ['metrics'],
        },
      },
    },
    async (request, reply) => {
      await verifyPmClientAccess(request, reply);
      if (reply.sent) return;

      const { clientId } = request.params;
      const { metrics } = request.body;

      const validTypes = [
        'MASTER_VISIBILITY',
        'GROWTH_INDEX',
        'COMPETITOR_THREAT',
        'CONTENT_GAP',
        'AI_SEARCH_READINESS',
      ];

      const filtered = metrics.filter((m) => validTypes.includes(m.metricType));
      if (filtered.length === 0) {
        return reply.status(400).send({ message: 'No valid metrics provided' });
      }

      const created = await prisma.clientMetricSnapshot.createMany({
        data: filtered.map((m) => ({
          clientId,
          metricType: m.metricType,
          value: String(m.value).slice(0, 100),
          label: m.label ? String(m.label).slice(0, 100) : null,
          change: m.change ? String(m.change).slice(0, 100) : null,
        })),
      });

      return reply.send({ created: created.count });
    }
  );

  app.get(
    '/clients/:clientId/metrics',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { clientId: { type: 'string' } },
          required: ['clientId'],
        },
      },
    },
    async (request, reply) => {
      await verifyPmClientAccess(request, reply);
      if (reply.sent) return;

      const { clientId } = request.params;

      // Get latest snapshot for each metric type
      const allTypes = [
        'MASTER_VISIBILITY',
        'GROWTH_INDEX',
        'COMPETITOR_THREAT',
        'CONTENT_GAP',
        'AI_SEARCH_READINESS',
      ];

      const latest = [];
      for (const metricType of allTypes) {
        const snap = await prisma.clientMetricSnapshot.findFirst({
          where: { clientId, metricType },
          orderBy: { createdAt: 'desc' },
        });
        if (snap) latest.push(snap);
      }

      return reply.send(latest);
    }
  );

  // ─── ROI ─────────────────────────────────────────────────

  app.post(
    '/clients/:clientId/roi',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { clientId: { type: 'string' } },
          required: ['clientId'],
        },
        body: {
          type: 'object',
          properties: {
            retainerCost: { type: 'number' },
            estimatedValueGenerated: { type: 'number' },
            leadValue: { type: 'number' },
            trafficValue: { type: 'number' },
            roiPercentage: { type: 'number' },
          },
          required: ['retainerCost', 'estimatedValueGenerated', 'leadValue', 'trafficValue', 'roiPercentage'],
        },
      },
    },
    async (request, reply) => {
      await verifyPmClientAccess(request, reply);
      if (reply.sent) return;

      const { clientId } = request.params;
      const { retainerCost, estimatedValueGenerated, leadValue, trafficValue, roiPercentage } = request.body;

      const roi = await prisma.clientROIConfig.upsert({
        where: { clientId },
        create: { clientId, retainerCost, estimatedValueGenerated, leadValue, trafficValue, roiPercentage },
        update: { retainerCost, estimatedValueGenerated, leadValue, trafficValue, roiPercentage },
      });

      return reply.send(roi);
    }
  );

  app.get(
    '/clients/:clientId/roi',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { clientId: { type: 'string' } },
          required: ['clientId'],
        },
      },
    },
    async (request, reply) => {
      await verifyPmClientAccess(request, reply);
      if (reply.sent) return;

      const { clientId } = request.params;
      const roi = await prisma.clientROIConfig.findUnique({ where: { clientId } });
      return reply.send(roi ?? { retainerCost: 0, estimatedValueGenerated: 0, leadValue: 0, trafficValue: 0, roiPercentage: 0 });
    }
  );

  // ─── PM UPDATES ──────────────────────────────────────────

  app.post(
    '/clients/:clientId/pm-update',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { clientId: { type: 'string' } },
          required: ['clientId'],
        },
        body: {
          type: 'object',
          properties: {
            message: { type: 'string', minLength: 1 },
          },
          required: ['message'],
        },
      },
    },
    async (request, reply) => {
      await verifyPmClientAccess(request, reply);
      if (reply.sent) return;

      const { clientId } = request.params;
      const { message } = request.body;

      const update = await prisma.clientPMUpdate.create({
        data: {
          clientId,
          message: String(message).slice(0, 5000),
          authorId: request.user.id,
        },
        include: {
          author: { select: { name: true } },
        },
      });

      return reply.send({
        id: update.id,
        message: update.message,
        authorName: update.author.name,
        createdAt: update.createdAt.toISOString(),
      });
    }
  );

  app.get(
    '/clients/:clientId/pm-updates',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { clientId: { type: 'string' } },
          required: ['clientId'],
        },
      },
    },
    async (request, reply) => {
      await verifyPmClientAccess(request, reply);
      if (reply.sent) return;

      const { clientId } = request.params;
      const updates = await prisma.clientPMUpdate.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          author: { select: { name: true } },
        },
      });

      return reply.send(
        updates.map((u) => ({
          id: u.id,
          message: u.message,
          authorName: u.author.name,
          createdAt: u.createdAt.toISOString(),
        }))
      );
    }
  );

  // ─── HEALTH SCORE ────────────────────────────────────────

  app.put(
    '/clients/:clientId/health-score',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { clientId: { type: 'string' } },
          required: ['clientId'],
        },
        body: {
          type: 'object',
          properties: {
            healthScore: { type: 'integer', minimum: 0, maximum: 100 },
          },
          required: ['healthScore'],
        },
      },
    },
    async (request, reply) => {
      await verifyPmClientAccess(request, reply);
      if (reply.sent) return;

      const { clientId } = request.params;
      const { healthScore } = request.body;

      await prisma.clientAccount.update({
        where: { id: clientId },
        data: { healthScore },
      });

      return reply.send({ healthScore });
    }
  );

  // ─── GSC CONFIGURATION ────────────────────────────────────

  // GET /clients/:clientId/gsc — get GSC config for the project linked to this client
  app.get(
    '/clients/:clientId/gsc',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { clientId: { type: 'string' } },
          required: ['clientId'],
        },
      },
    },
    async (request, reply) => {
      await verifyPmClientAccess(request, reply);
      if (reply.sent) return;

      const { clientId } = request.params;

      const project = await prisma.project.findFirst({
        where: { clientId },
        select: { id: true, name: true, gscSiteUrl: true, gscLastSyncedAt: true },
      });

      return reply.send({
        gscEnabled: isGscEnabled(),
        project: project
          ? {
              id: project.id,
              name: project.name,
              gscSiteUrl: project.gscSiteUrl,
              gscLastSyncedAt: project.gscLastSyncedAt?.toISOString() ?? null,
            }
          : null,
      });
    }
  );

  // PUT /clients/:clientId/gsc — set GSC site URL for the project
  app.put(
    '/clients/:clientId/gsc',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { clientId: { type: 'string' } },
          required: ['clientId'],
        },
        body: {
          type: 'object',
          properties: {
            gscSiteUrl: { type: 'string' },
          },
          required: ['gscSiteUrl'],
        },
      },
    },
    async (request, reply) => {
      await verifyPmClientAccess(request, reply);
      if (reply.sent) return;

      const { clientId } = request.params;
      const { gscSiteUrl } = request.body;

      // Find project for this client
      const project = await prisma.project.findFirst({
        where: { clientId },
        select: { id: true },
      });

      if (!project) {
        return reply.status(404).send({ message: 'No project found for this client' });
      }

      if (!isGscEnabled()) {
        return reply.status(400).send({ message: 'GSC integration is not configured on the server' });
      }

      // Verify the service account has access to this GSC property
      const siteUrl = gscSiteUrl.trim();
      if (siteUrl) {
        const hasAccess = await verifySiteAccess(siteUrl);
        if (!hasAccess) {
          return reply.status(400).send({
            message: 'Service account does not have access to this GSC property. Add the service account email as a user in Google Search Console.',
          });
        }
      }

      await prisma.project.update({
        where: { id: project.id },
        data: { gscSiteUrl: siteUrl || null },
      });

      return reply.send({ gscSiteUrl: siteUrl || null });
    }
  );

  // POST /clients/:clientId/gsc/sync — trigger manual GSC sync
  app.post(
    '/clients/:clientId/gsc/sync',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { clientId: { type: 'string' } },
          required: ['clientId'],
        },
      },
    },
    async (request, reply) => {
      await verifyPmClientAccess(request, reply);
      if (reply.sent) return;

      const { clientId } = request.params;

      if (!isGscEnabled()) {
        return reply.status(400).send({ message: 'GSC integration is not configured' });
      }

      const project = await prisma.project.findFirst({
        where: { clientId },
        select: { id: true, gscSiteUrl: true, clientId: true },
      });

      if (!project || !project.gscSiteUrl) {
        return reply.status(400).send({ message: 'No GSC site URL configured for this project' });
      }

      const result = await syncProject(project);
      return reply.send(result);
    }
  );
}
