import { prisma } from '../../lib/prisma.js';
import { ensureProjectAccess } from '../../lib/ensureProjectAccess.js';
import { notify } from '../../lib/notificationService.js';

export async function pmTasksRoutes(app) {
  app.get(
    '/team',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                email: { type: 'string' },
                avatarUrl: { type: 'string', nullable: true },
                role: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const users = await prisma.user.findMany({
        where: {
          role: { in: ['TEAM_MEMBER', 'CONTRACTOR', 'PM'] },
          isActive: true,
        },
        select: { id: true, name: true, email: true, avatarUrl: true, role: true },
        orderBy: { name: 'asc' },
      });
      return reply.send(users);
    }
  );

  app.patch(
    '/tasks/:id/request-client',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            clientRequestNote: { type: 'string' },
          },
          required: ['clientRequestNote'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              requiresClientInput: { type: 'boolean' },
              clientRequestNote: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;
      const { clientRequestNote } = request.body || {};

      const note = typeof clientRequestNote === 'string' ? clientRequestNote.trim() : '';
      if (!note) {
        return reply.status(400).send({ message: 'clientRequestNote is required' });
      }

      const task = await prisma.task.findUnique({
        where: { id },
        include: {
          project: {
            include: { client: { select: { id: true, agencyName: true } } },
          },
        },
      });

      if (!task) {
        return reply.status(404).send({ message: 'Task not found' });
      }

      const canAccess = await ensureProjectAccess(task.project, user);
      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      const updated = await prisma.task.update({
        where: { id },
        data: {
          requiresClientInput: true,
          clientRequestNote: note.slice(0, 10000),
          clientProvidedInput: false,
        },
      });

      // Create a ClientInputRequest record for history
      const inputRequest = await prisma.clientInputRequest.create({
        data: {
          taskId: id,
          requestedById: user.id,
          requestNote: note.slice(0, 10000),
          status: 'PENDING',
        },
        include: {
          requestedBy: { select: { id: true, name: true, avatarUrl: true } },
        },
      });

      // Activity log
      await prisma.taskActivityLog.create({
        data: { taskId: id, actorId: user.id, action: 'client_input_requested', detail: note.slice(0, 200) },
      });

      const clientUserLinks = await prisma.clientUser.findMany({
        where: { clientId: task.project.clientId },
        select: { userId: true },
      });
      
      notify({
        slug: 'client_input_requested',
        recipientIds: clientUserLinks.map(({ userId }) => userId),
        variables: {
          taskTitle: task.title,
          projectName: task.project?.name || '',
          requestNote: note.slice(0, 200),
        },
        actionUrl: '/portal/client',
        metadata: { taskId: id },
      }).catch(() => {});

      return reply.send({
        id: updated.id,
        requiresClientInput: updated.requiresClientInput,
        clientRequestNote: updated.clientRequestNote,
      });
    }
  );
}
