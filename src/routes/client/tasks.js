import { prisma } from '../../lib/prisma.js';
import { notify } from '../../lib/notificationService.js';

export async function clientTasksRoutes(app) {
  app.get(
    '/tasks/action-required',
    {
      onRequest: [app.verifyJwt, app.requireClient],
    },
    async (request, reply) => {
      const userId = request.user.id;

      const clientUsers = await prisma.clientUser.findMany({
        where: { userId },
        select: { clientId: true },
      });

      if (clientUsers.length === 0) {
        return reply.status(404).send({ message: 'No client account linked to this user' });
      }

      const clientIds = clientUsers.map((cu) => cu.clientId);

      const tasks = await prisma.task.findMany({
        where: {
          project: { clientId: { in: clientIds } },
          clientVisible: true,
          requiresClientInput: true,
          clientProvidedInput: false,
        },
        orderBy: { updatedAt: 'desc' },
        include: {
          project: {
            select: { id: true, name: true },
          },
        },
      });

      return reply.send(
        tasks.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          taskType: t.taskType,
          status: t.status,
          clientRequestNote: t.clientRequestNote,
          updatedAt: t.updatedAt.toISOString(),
          project: t.project,
        }))
      );
    }
  );

  app.patch(
    '/tasks/:id/fulfill-request',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            clientResponse: { type: 'string', nullable: true },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              clientProvidedInput: { type: 'boolean' },
            },
            required: ['id', 'clientProvidedInput'],
            additionalProperties: true,
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user.id;
      const { id } = request.params;
      const body = request.body || {};
      const clientResponse = typeof body.clientResponse === 'string' ? body.clientResponse.trim() || null : null;

      const clientIds = request.clientAccountIds;

      const task = await prisma.task.findUnique({
        where: { id },
        include: {
          project: {
            select: { id: true, name: true, clientId: true, leadPmId: true },
          },
        },
      });

      if (!task) {
        return reply.status(404).send({ message: 'Task not found' });
      }

      if (!clientIds.includes(task.project.clientId)) {
        return reply.status(403).send({ message: 'You do not have access to this task' });
      }

      if (!task.requiresClientInput) {
        return reply.status(400).send({ message: 'This task is not awaiting client input' });
      }

      const updated = await prisma.task.update({
        where: { id },
        data: {
          clientProvidedInput: true,
          requiresClientInput: false,
          clientRequestNote: null,
          clientProvidedResponse: clientResponse,
        },
      });

      // Update the latest PENDING ClientInputRequest record
      const pendingRequest = await prisma.clientInputRequest.findFirst({
        where: { taskId: id, status: 'PENDING' },
        orderBy: { requestedAt: 'desc' },
      });
      if (pendingRequest) {
        await prisma.clientInputRequest.update({
          where: { id: pendingRequest.id },
          data: { status: 'FULFILLED', responseText: clientResponse, respondedById: userId, respondedAt: new Date() },
        });
      }

      // Activity log
      await prisma.taskActivityLog.create({
        data: { taskId: id, actorId: userId, action: 'client_input_fulfilled' },
      });

      if (task.project.leadPmId) {
        notify({
          slug: 'client_input_fulfilled',
          recipientIds: [task.project.leadPmId],
          variables: {
            taskTitle: task.title,
            projectName: task.project.name || '',
          },
          actionUrl: `/portal/pm/projects/${task.project.id}`,
          metadata: { taskId: id },
        }).catch(() => {});
      }

      // Notify other client users on the same account
      try {
        const otherClientUsers = await prisma.clientUser.findMany({
          where: { clientId: task.project.clientId, userId: { not: userId } },
          select: { userId: true },
        });
        if (otherClientUsers.length > 0) {
          notify({
            slug: 'client_input_fulfilled_team',
            recipientIds: otherClientUsers.map((cu) => cu.userId),
            variables: {
              responderName: request.user.name || 'A team member',
              taskTitle: task.title,
              projectName: task.project.name || '',
            },
            actionUrl: '/portal/client',
            metadata: { taskId: id },
          }).catch(() => {});
        }
        // Log to ClientActivityLog
        await prisma.clientActivityLog.create({
          data: {
            clientId: task.project.clientId,
            userId,
            action: 'input_fulfilled',
            detail: `Provided input for "${task.title}"`,
            metadata: { taskId: id, projectId: task.project.id },
          },
        });
      } catch (_) {}

      return reply.send({
        id: updated.id,
        clientProvidedInput: updated.clientProvidedInput,
      });
    }
  );

  app.get(
    '/tasks',
    {
      onRequest: [app.verifyJwt, app.requireClient],
    },
    async (request, reply) => {
      const userId = request.user.id;
      const clientIds = request.clientAccountIds;

      const tasks = await prisma.task.findMany({
        where: {
          project: { clientId: { in: clientIds } },
          clientVisible: true,
          parentTaskId: null,
        },
        orderBy: { dueDate: 'asc' },
        include: {
          project: {
            select: { id: true, name: true, projectType: true },
          },
          subTasks: {
            orderBy: { dueDate: 'asc' },
            select: { id: true, title: true, status: true, dueDate: true, taskType: true },
          },
        },
      });

      return reply.send(
        tasks.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          taskType: t.taskType,
          status: t.status,
          dueDate: t.dueDate?.toISOString() ?? null,
          requiresClientInput: t.requiresClientInput,
          clientRequestNote: t.clientRequestNote,
          clientProvidedInput: t.clientProvidedInput,
          project: t.project,
          subTasks: t.subTasks,
        }))
      );
    }
  );
}
