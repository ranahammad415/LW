import { prisma } from '../../lib/prisma.js';

const ALLOWED_ALERT_ROLES = ['OWNER', 'PM', 'TEAM_MEMBER', 'CONTRACTOR'];

export async function pmAlertRoutes(app) {
  app.get(
    '/alerts',
    {
      onRequest: [app.verifyJwt],
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                message: { type: 'string' },
                isRead: { type: 'boolean' },
                actionUrl: { type: 'string', nullable: true },
                createdAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!ALLOWED_ALERT_ROLES.includes(request.user?.role)) {
        return reply.status(403).send({ message: 'Access denied' });
      }

      const alerts = await prisma.systemAlert.findMany({
        where: {
          userId: request.user.id,
          isRead: false,
        },
        orderBy: { createdAt: 'desc' },
      });

      return reply.send(
        alerts.map((a) => ({
          id: a.id,
          type: a.type,
          message: a.message,
          isRead: a.isRead,
          actionUrl: a.actionUrl,
          createdAt: a.createdAt.toISOString(),
        }))
      );
    }
  );

  // GET /api/pm/alerts/activity — recent notifications (read + unread) for dashboard feed
  app.get(
    '/alerts/activity',
    {
      onRequest: [app.verifyJwt],
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                message: { type: 'string' },
                isRead: { type: 'boolean' },
                actionUrl: { type: 'string', nullable: true },
                createdAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!ALLOWED_ALERT_ROLES.includes(request.user?.role)) {
        return reply.status(403).send({ message: 'Access denied' });
      }

      const alerts = await prisma.systemAlert.findMany({
        where: {
          userId: request.user.id,
        },
        orderBy: { createdAt: 'desc' },
        take: 30,
      });

      return reply.send(
        alerts.map((a) => ({
          id: a.id,
          type: a.type,
          message: a.message,
          isRead: a.isRead,
          actionUrl: a.actionUrl,
          createdAt: a.createdAt.toISOString(),
        }))
      );
    }
  );

  app.patch(
    '/alerts/:id/read',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', minLength: 1 } },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              isRead: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!ALLOWED_ALERT_ROLES.includes(request.user?.role)) {
        return reply.status(403).send({ message: 'Access denied' });
      }

      const { id } = request.params;

      const alert = await prisma.systemAlert.findUnique({
        where: { id },
      });

      if (!alert) {
        return reply.status(404).send({ message: 'Alert not found' });
      }
      if (alert.userId !== request.user.id) {
        return reply.status(403).send({ message: 'You can only mark your own alerts as read' });
      }

      const updated = await prisma.systemAlert.update({
        where: { id },
        data: { isRead: true },
      });

      return reply.send({ id: updated.id, isRead: updated.isRead });
    }
  );
}
