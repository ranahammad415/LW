import { prisma } from '../../lib/prisma.js';

export async function adminDashboardRoutes(app) {
  app.get(
    '/dashboard',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              metrics: {
                type: 'object',
                properties: {
                  activeClients: { type: 'integer' },
                  tasksDueToday: { type: 'integer' },
                  deliverablesPending: { type: 'integer' },
                  teamOnTimeRate: { type: 'integer' },
                  atRiskClients: { type: 'integer' },
                },
              },
              clientHealthMap: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    agencyName: { type: 'string' },
                    healthScore: { type: 'integer', nullable: true },
                  },
                },
              },
              openIssues: { type: 'array', items: { type: 'object' } },
              recentlyCompletedTasks: { type: 'array', items: { type: 'object' } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endOfToday = new Date(startOfToday);
      endOfToday.setHours(23, 59, 59, 999);

      const activeTaskStatuses = ['TO_DO', 'IN_PROGRESS', 'NEEDS_REVIEW', 'REVISION_NEEDED', 'BLOCKED', 'WAITING_DEPENDENCY'];

      const [
        activeClientsCount,
        clients,
        openIssues,
        completedTasks,
        tasksDueToday,
        deliverablesPending,
        completedWithDue,
      ] = await Promise.all([
        prisma.clientAccount.count({ where: { isActive: true } }),
        prisma.clientAccount.findMany({
          where: { isActive: true },
          select: { id: true, agencyName: true, healthScore: true },
          orderBy: { agencyName: 'asc' },
        }),
        prisma.clientIssue.findMany({
          where: { status: 'OPEN' },
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: {
            client: { select: { id: true, agencyName: true } },
          },
        }),
        prisma.task.findMany({
          where: { status: 'COMPLETED' },
          take: 5,
          orderBy: { updatedAt: 'desc' },
          include: {
            project: { include: { client: { select: { id: true, agencyName: true } } } },
          },
        }),
        // Tasks due today (active, not completed/cancelled)
        prisma.task.count({
          where: {
            status: { in: activeTaskStatuses },
            dueDate: { gte: startOfToday, lte: endOfToday },
          },
        }),
        // Deliverables pending = tasks in NEEDS_REVIEW status
        prisma.task.count({
          where: { status: 'NEEDS_REVIEW' },
        }),
        // For on-time rate: completed tasks that had a due date
        prisma.task.count({
          where: { status: 'COMPLETED', dueDate: { not: null } },
        }),
      ]);

      // Team on-time rate: query completed tasks with due dates and compare
      let teamOnTimeRate = 100;
      if (completedWithDue > 0) {
        // Fetch completed tasks with due dates to compare updatedAt vs dueDate
        const tasksWithDates = await prisma.task.findMany({
          where: { status: 'COMPLETED', dueDate: { not: null } },
          select: { updatedAt: true, dueDate: true },
        });
        const onTimeCount = tasksWithDates.filter((t) => t.updatedAt <= t.dueDate).length;
        teamOnTimeRate = Math.round((onTimeCount / tasksWithDates.length) * 100);
      }

      const atRiskClients = clients.filter((c) => c.healthScore != null && c.healthScore < 40).length;

      const metrics = {
        activeClients: activeClientsCount,
        tasksDueToday,
        deliverablesPending,
        teamOnTimeRate,
        atRiskClients,
      };

      return reply.send({
        metrics,
        clientHealthMap: clients.map((c) => ({
          id: c.id,
          agencyName: c.agencyName,
          healthScore: c.healthScore,
        })),
        openIssues: openIssues.map((i) => ({
          id: i.id,
          title: i.title,
          status: i.status,
          priority: i.priority,
          createdAt: i.createdAt,
          client: i.client,
        })),
        recentlyCompletedTasks: completedTasks.map((t) => ({
          id: t.id,
          title: t.title,
          updatedAt: t.updatedAt,
          client: t.project?.client ?? null,
        })),
      });
    }
  );
}
