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

  // POST /automation/calculate-health was removed by health score v2 (docs/ledger/features/health-score.md):
  // the task formula is now the read-only "Delivery health" (lib/health/deliveryHealth.js) and ClientAccount.healthScore
  // is written only by lib/health/healthScoreService.js.

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
