import { prisma } from '../../lib/prisma.js';
import { runScheduledAeoSweep, runAllForProject, runSinglePrompt } from '../../lib/aeoRunner.js';
import { notify } from '../../lib/notificationService.js';

const STAGNANT_DAYS = 3;

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function adminAutomationRoutes(app) {
  app.post(
    '/automation/run-warnings',
    {
      onRequest: [app.verifyJwt],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              stagnantCreated: { type: 'integer' },
              overdueCreated: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.user.role !== 'OWNER' && request.user.role !== 'PM') {
        return reply.status(403).send({ message: 'Only Owner or PM can run the automation engine' });
      }

      const stagnantThreshold = daysAgo(STAGNANT_DAYS);
      let stagnantCreated = 0;
      let overdueCreated = 0;

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const stagnantTasks = await prisma.task.findMany({
        where: {
          status: { in: ['IN_PROGRESS', 'NEEDS_REVIEW'] },
          updatedAt: { lt: stagnantThreshold },
          project: { isNot: null },
        },
        include: {
          project: { select: { id: true, leadPmId: true } },
          assignees: { take: 1, select: { id: true } },
        },
      });

      for (const task of stagnantTasks) {
        const recipientId = task.assignees[0]?.id ?? task.project.leadPmId;
        if (!recipientId) continue;

        const actionUrl = `/portal/pm/projects/${task.projectId}`;

        notify({
          slug: 'task_stagnant',
          recipientIds: [recipientId],
          variables: {
            taskTitle: task.title,
            projectName: task.project?.name || '',
          },
          actionUrl,
          metadata: { taskId: task.id },
        }).catch(() => {});
        stagnantCreated += 1;
      }

      const overdueTasks = await prisma.task.findMany({
        where: {
          status: { not: 'COMPLETED' },
          dueDate: { lt: todayStart },
          project: { isNot: null },
        },
        include: {
          project: { select: { leadPmId: true } },
          assignees: { take: 1, select: { id: true } },
        },
      });

      for (const task of overdueTasks) {
        const recipientId = task.assignees[0]?.id ?? task.project.leadPmId;
        if (!recipientId) continue;

        const actionUrl = `/portal/pm/projects/${task.projectId}`;

        notify({
          slug: 'task_overdue',
          recipientIds: [recipientId],
          variables: {
            taskTitle: task.title,
            projectName: task.project?.name || '',
          },
          actionUrl,
          metadata: { taskId: task.id },
        }).catch(() => {});
        overdueCreated += 1;
      }

      return reply.send({
        stagnantCreated,
        overdueCreated,
      });
    }
  );

  app.post(
    '/automation/calculate-health',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              updatedCount: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const stagnantThreshold = daysAgo(STAGNANT_DAYS);

      const clients = await prisma.clientAccount.findMany({
        select: { id: true, agencyName: true, leadPmId: true, healthScore: true },
      });

      let updatedCount = 0;

      for (const client of clients) {
        const [overdueCount, stagnantCount] = await Promise.all([
          prisma.task.count({
            where: {
              project: { clientId: client.id },
              status: { not: 'COMPLETED' },
              dueDate: { lt: todayStart },
            },
          }),
          prisma.task.count({
            where: {
              project: { clientId: client.id },
              status: { in: ['IN_PROGRESS', 'NEEDS_REVIEW'] },
              updatedAt: { lt: stagnantThreshold },
            },
          }),
        ]);

        const onboarding = await prisma.clientAccount.findUnique({
          where: { id: client.id },
          select: { onboardingStatus: true },
        });

        let score = 100;
        score -= overdueCount * 10;
        score -= stagnantCount * 5;
        if (onboarding?.onboardingStatus !== 'COMPLETE') {
          score -= 15;
        }
        score = Math.max(0, score);

        await prisma.clientAccount.update({
          where: { id: client.id },
          data: { healthScore: score },
        });

        // Notify if health score dropped below 40
        if (score < 40 && (client.healthScore === null || client.healthScore >= 40)) {
          const recipients = [];
          if (client.leadPmId) recipients.push(client.leadPmId);
          // Also notify owner(s)
          const owners = await prisma.user.findMany({ where: { role: 'OWNER', isActive: true }, select: { id: true } });
          recipients.push(...owners.map((o) => o.id));
          if (recipients.length > 0) {
            notify({
              slug: 'client_health_critical',
              recipientIds: recipients,
              variables: { clientName: client.agencyName, healthScore: String(score) },
              actionUrl: `/portal/admin/clients/${client.id}`,
              metadata: { clientId: client.id, healthScore: score },
            }).catch(() => {});
          }
        }

        updatedCount += 1;
      }

      return reply.send({ updatedCount });
    }
  );

  // ── AEO Automation: Run all active AEO projects ────────────────────
  app.post(
    '/automation/aeo-sweep',
    {
      onRequest: [app.verifyJwt],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              projects: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    projectId: { type: 'string' },
                    projectName: { type: 'string' },
                    runs: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.user.role !== 'OWNER' && request.user.role !== 'PM') {
        return reply.status(403).send({ message: 'Only Owner or PM can trigger AEO sweep' });
      }
      const summary = await runScheduledAeoSweep();
      return reply.send({ message: 'AEO sweep complete', projects: summary });
    }
  );

  // ── AEO Automation: Run all prompts for a single project ───────────
  app.post(
    '/automation/aeo-run-project/:projectId',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { projectId: { type: 'string', format: 'uuid' } },
          required: ['projectId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    promptLogId: { type: 'string' },
                    runId: { type: 'string', nullable: true },
                    wasCited: { type: 'boolean', nullable: true },
                    error: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.user.role !== 'OWNER' && request.user.role !== 'PM') {
        return reply.status(403).send({ message: 'Only Owner or PM can trigger AEO runs' });
      }
      const { projectId } = request.params;
      const results = await runAllForProject(projectId);
      return reply.send({ message: 'Project AEO run complete', results });
    }
  );

  // ── AEO Automation: Run a single prompt log ────────────────────────
  app.post(
    '/automation/aeo-run-prompt/:promptLogId',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { promptLogId: { type: 'string', format: 'uuid' } },
          required: ['promptLogId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              run: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  promptLogId: { type: 'string' },
                  runDate: { type: 'string' },
                  wasCited: { type: 'boolean', nullable: true },
                  responseSnippet: { type: 'string', nullable: true },
                },
              },
              competitors: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.user.role !== 'OWNER' && request.user.role !== 'PM') {
        return reply.status(403).send({ message: 'Only Owner or PM can trigger AEO runs' });
      }
      const { promptLogId } = request.params;
      const result = await runSinglePrompt(promptLogId);
      return reply.send(result);
    }
  );
}
