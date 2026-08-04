import { prisma } from '../../lib/prisma.js';
import { ensureNextCycle } from '../../lib/workCycle.js';
import { prepareProjectNextMonth, DONE_STATUSES } from '../../lib/taskClone.js';

function serializeTaskBrief(t) {
  return {
    id: t.id,
    title: t.title,
    taskType: t.taskType,
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate,
    milestone: t.milestone,
    parentTaskId: t.parentTaskId,
    clonedFromTaskId: t.clonedFromTaskId ?? null,
    assignees: t.assignees ?? [],
    subTaskCount: t._count?.subTasks ?? 0,
  };
}

/**
 * Owner-only per-project next-month prepare APIs.
 * Mounted under /api/admin.
 */
export async function adminNextMonthRoutes(app) {
  // Preview current-cycle roots + already-staged next-cycle tasks for a project.
  app.get(
    '/projects/:id/next-month/preview',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const projectId = request.params.id;
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });

      const { current, next } = await ensureNextCycle({ userId: request.user?.id });

      const [currentTasks, nextTasks] = await Promise.all([
        prisma.task.findMany({
          where: { projectId, workCycleId: current.id, parentTaskId: null },
          orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
          include: {
            assignees: { select: { id: true, name: true } },
            _count: { select: { subTasks: true } },
          },
        }),
        prisma.task.findMany({
          where: { projectId, workCycleId: next.id, parentTaskId: null },
          orderBy: [{ createdAt: 'asc' }],
          include: {
            assignees: { select: { id: true, name: true } },
            _count: { select: { subTasks: true } },
          },
        }),
      ]);

      return reply.send({
        project,
        currentCycle: {
          id: current.id,
          month: current.month,
          year: current.year,
          label: current.label,
          status: current.status,
        },
        nextCycle: {
          id: next.id,
          month: next.month,
          year: next.year,
          label: next.label,
          status: next.status,
        },
        currentTasks: currentTasks.map((t) => ({
          ...serializeTaskBrief(t),
          incomplete: !DONE_STATUSES.includes(t.status),
          alreadyCloned: nextTasks.some((n) => n.clonedFromTaskId === t.id),
        })),
        nextTasks: nextTasks.map(serializeTaskBrief),
      });
    }
  );

  // Clone / remove / add tasks for next month without closing the agency cycle.
  app.post(
    '/projects/:id/next-month/prepare',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            cloneTaskIds: { type: 'array', items: { type: 'string' } },
            removeNextTaskIds: { type: 'array', items: { type: 'string' } },
            createTasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  taskType: { type: 'string' },
                  priority: { type: 'string' },
                  dueDate: { type: 'string' },
                  milestone: { type: 'string' },
                  assigneeIds: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const projectId = request.params.id;
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });

      const body = request.body || {};
      const { current, next } = await ensureNextCycle({ userId: request.user?.id });

      const summary = await prepareProjectNextMonth({
        projectId,
        currentCycleId: current.id,
        nextCycleId: next.id,
        cloneTaskIds: Array.isArray(body.cloneTaskIds) ? body.cloneTaskIds : [],
        removeNextTaskIds: Array.isArray(body.removeNextTaskIds) ? body.removeNextTaskIds : [],
        createTasks: Array.isArray(body.createTasks) ? body.createTasks : [],
        createdById: request.user?.id ?? null,
      });

      return reply.send({
        currentCycle: { id: current.id, month: current.month, year: current.year, label: current.label },
        nextCycle: { id: next.id, month: next.month, year: next.year, label: next.label },
        ...summary,
      });
    }
  );
}
