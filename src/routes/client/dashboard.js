import { prisma } from '../../lib/prisma.js';
import { safeReviewLinks } from '../../lib/siteLinks.js';
import { ensureCurrentCycle } from '../../lib/workCycle.js';
import { reviewDisplayUpdatedAt } from '../../lib/pipelineFormat.js';
import { getActiveConfig } from '../../lib/health/healthConfig.js';
import { bandInfo } from '../../lib/health/healthViews.js';
import { trendArrow } from '../../lib/health/healthMath.js';

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
              // Health score v2 summary (full card: GET /api/client/health). Allow-list: no factors or notes.
              health: {
                type: 'object',
                properties: {
                  score: { type: 'integer', nullable: true },
                  band: { type: 'string', nullable: true },
                  label: { type: 'string', nullable: true },
                  coverage: { type: 'integer', nullable: true },
                  arrow: { type: 'string', nullable: true },
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
              currentCycle: {
                type: 'object',
                nullable: true,
                properties: {
                  id: { type: 'string' },
                  month: { type: 'integer' },
                  year: { type: 'integer' },
                  label: { type: 'string', nullable: true },
                  status: { type: 'string' },
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
              contentReviews: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    postTitle: { type: 'string' },
                    status: { type: 'string' },
                    projectId: { type: 'string' },
                    projectName: { type: 'string' },
                    clientPreviewUrl: { type: 'string', nullable: true },
                    updatedAt: { type: 'string', nullable: true },
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

      // Scope home stats / active tasks to the agency's OPEN work session
      const currentCycle = await ensureCurrentCycle();

      // Fetch active tasks (main tasks only, exclude subtasks) for current cycle
      const activeTasks = await prisma.task.findMany({
        where: {
          project: { clientId: { in: clientIds } },
          clientVisible: true,
          workCycleId: currentCycle.id,
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
        orderBy: [{ wpUpdatedAt: 'desc' }, { updatedAt: 'desc' }],
        include: {
          // wpUrl/cmsType: preview links are returned only when https and on the site host (security hotfix)
          project: { select: { id: true, name: true, wpUrl: true, cmsType: true } },
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

      const healthCfg = await getActiveConfig();
      const band = bandInfo(primaryClient.healthScore, healthCfg);

      return reply.send({
        client: {
          id: primaryClient.id,
          agencyName: primaryClient.agencyName,
          // kept for compatibility; written only by the health score v2 service
          healthScore: primaryClient.healthScore,
          onboardingStatus: primaryClient.onboardingStatus,
          onboardingStep: primaryClient.onboardingStep,
        },
        health: {
          score: primaryClient.healthScore ?? null,
          band: band.band,
          label: band.clientLabel,
          coverage: primaryClient.healthCoverage ?? null,
          arrow: trendArrow(primaryClient.healthTrend28, healthCfg.trendArrowDelta ?? 3),
        },
        setupProjects,
        currentCycle: {
          id: currentCycle.id,
          month: currentCycle.month,
          year: currentCycle.year,
          label: currentCycle.label,
          status: currentCycle.status,
        },
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
          projectId: r.project?.id || '',
          projectName: r.project?.name || '',
          clientPreviewUrl: safeReviewLinks(r, r.project).clientPreviewUrl,
          updatedAt: reviewDisplayUpdatedAt(r)?.toISOString() || null,
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
