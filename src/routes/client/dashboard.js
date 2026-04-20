import { prisma } from '../../lib/prisma.js';

export async function clientDashboardRoutes(app) {
  app.get(
    '/dashboard',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              client: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  agencyName: { type: 'string' },
                  healthScore: { type: 'integer', nullable: true },
                  onboardingStatus: { type: 'string', nullable: true },
                  onboardingStep: { type: 'integer' },
                },
              },
              pmUpdate: {
                type: 'object',
                nullable: true,
                properties: {
                  message: { type: 'string' },
                  authorName: { type: 'string' },
                  createdAt: { type: 'string' },
                },
              },
              keyMetrics: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    metricType: { type: 'string' },
                    value: { type: 'string' },
                    label: { type: 'string', nullable: true },
                    change: { type: 'string', nullable: true },
                  },
                },
              },
              activeTasks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    dueDate: { type: 'string', nullable: true },
                    status: { type: 'string' },
                    projectName: { type: 'string' },
                  },
                },
              },
              setupProjects: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    projectType: { type: 'string' },
                    onboardingStep: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user.id;

      const clientUsers = await prisma.clientUser.findMany({
        where: { userId },
        include: { client: true },
      });

      if (clientUsers.length === 0) {
        return reply.status(404).send({ message: 'No client account linked to this user' });
      }

      const clientIds = clientUsers.map((cu) => cu.clientId);
      const primaryClient = clientUsers.find((cu) => cu.isPrimaryContact)?.client ?? clientUsers[0].client;

      // Fetch active tasks
      const activeTasks = await prisma.task.findMany({
        where: {
          project: { clientId: { in: clientIds } },
          clientVisible: true,
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        },
        orderBy: { dueDate: 'asc' },
        include: {
          project: { select: { name: true } },
        },
      });

      // Fetch setup projects for onboarding
      const setupProjects = await prisma.project.findMany({
        where: {
          clientId: { in: clientIds },
          status: 'SETUP',
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          projectType: true,
          onboardingStep: true,
        },
      });

      // Fetch latest PM update message
      const latestPmUpdate = await prisma.clientPMUpdate.findFirst({
        where: { clientId: primaryClient.id },
        orderBy: { createdAt: 'desc' },
        include: { author: { select: { name: true } } },
      });

      // Fetch latest key metric snapshots (one per type)
      const metricTypes = [
        'MASTER_VISIBILITY',
        'GROWTH_INDEX',
        'COMPETITOR_THREAT',
        'CONTENT_GAP',
        'AI_SEARCH_READINESS',
      ];
      const keyMetrics = [];
      for (const metricType of metricTypes) {
        const snap = await prisma.clientMetricSnapshot.findFirst({
          where: { clientId: primaryClient.id, metricType },
          orderBy: { createdAt: 'desc' },
        });
        if (snap) {
          keyMetrics.push({
            metricType: snap.metricType,
            value: snap.value,
            label: snap.label,
            change: snap.change,
          });
        }
      }

      return reply.send({
        client: {
          id: primaryClient.id,
          agencyName: primaryClient.agencyName,
          healthScore: primaryClient.healthScore,
          onboardingStatus: primaryClient.onboardingStatus,
          onboardingStep: primaryClient.onboardingStep,
        },
        setupProjects,
        pmUpdate: latestPmUpdate
          ? {
              message: latestPmUpdate.message,
              authorName: latestPmUpdate.author.name,
              createdAt: latestPmUpdate.createdAt.toISOString(),
            }
          : null,
        keyMetrics,
        activeTasks: activeTasks.map((t) => ({
          id: t.id,
          title: t.title,
          dueDate: t.dueDate?.toISOString() ?? null,
          status: t.status,
          projectName: t.project.name,
        })),
      });
    }
  );
}
