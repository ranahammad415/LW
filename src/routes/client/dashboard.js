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
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(404).send({ message: 'No client account linked to this user' });
      }

      // Load the full client rows so we can pick a primary and render its name.
      const clientAccounts = await prisma.clientAccount.findMany({
        where: { id: { in: clientIds } },
      });

      // When scope is narrowed (single id) there is exactly one row. Otherwise,
      // prefer the user's primary-contact link; fall back to the first row.
      let primaryClient = clientAccounts[0];
      if (clientAccounts.length > 1) {
        const primaryLink = (request.clientUserRoles || []).find((cu) => cu.isPrimaryContact);
        if (primaryLink) {
          const match = clientAccounts.find((c) => c.id === primaryLink.clientId);
          if (match) primaryClient = match;
        }
      }
      if (!primaryClient) {
        return reply.status(404).send({ message: 'No client account linked to this user' });
      }

      // Fetch active tasks (main tasks only, exclude subtasks)
      const activeTasks = await prisma.task.findMany({
        where: {
          project: { clientId: { in: clientIds } },
          clientVisible: true,
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
          parentTaskId: null,
        },
        orderBy: { dueDate: 'asc' },
        include: {
          project: { select: { name: true } },
        },
      });

      // Fetch content reviews awaiting client action
      const contentReviews = await prisma.wpContentReview.findMany({
        where: {
          project: { clientId: { in: clientIds } },
          isPublished: false,
          status: { in: ['pending_client_review'] },
        },
        orderBy: { updatedAt: 'desc' },
        include: {
          project: { select: { name: true } },
        },
        take: 10,
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
        contentReviews: contentReviews.map((r) => ({
          id: r.id,
          postTitle: r.postTitle,
          status: r.status,
          projectName: r.project?.name || '',
          clientPreviewUrl: r.clientPreviewUrl,
          updatedAt: r.updatedAt?.toISOString() || null,
        })),
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
