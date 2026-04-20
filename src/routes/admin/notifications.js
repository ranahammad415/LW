import { prisma } from '../../lib/prisma.js';
import { notify } from '../../lib/notificationService.js';

export async function adminNotificationRoutes(app) {
  // ── List all notification templates ──
  app.get(
    '/notifications/templates',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
    },
    async (request, reply) => {
      const { category } = request.query || {};
      const where = category ? { category } : {};

      const templates = await prisma.notificationTemplate.findMany({
        where,
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      });

      return reply.send(templates);
    }
  );

  // ── Get single template ──
  app.get(
    '/notifications/templates/:id',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', minLength: 1 } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const template = await prisma.notificationTemplate.findUnique({
        where: { id: request.params.id },
      });
      if (!template) {
        return reply.status(404).send({ message: 'Template not found' });
      }
      return reply.send(template);
    }
  );

  // ── Update template ──
  app.patch(
    '/notifications/templates/:id',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', minLength: 1 } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string', nullable: true },
            subject: { type: 'string' },
            bodyHtml: { type: 'string' },
            bodyText: { type: 'string', nullable: true },
            inAppMessage: { type: 'string' },
            isActive: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const existing = await prisma.notificationTemplate.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({ message: 'Template not found' });
      }

      const body = request.body || {};
      const data = {};
      if (body.name !== undefined) data.name = String(body.name).trim().slice(0, 255);
      if (body.description !== undefined) data.description = body.description ? String(body.description).trim().slice(0, 500) : null;
      if (body.subject !== undefined) data.subject = String(body.subject).trim().slice(0, 500);
      if (body.bodyHtml !== undefined) data.bodyHtml = String(body.bodyHtml);
      if (body.bodyText !== undefined) data.bodyText = body.bodyText ? String(body.bodyText) : null;
      if (body.inAppMessage !== undefined) data.inAppMessage = String(body.inAppMessage).trim().slice(0, 500);
      if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);

      if (Object.keys(data).length === 0) {
        return reply.send(existing);
      }

      const updated = await prisma.notificationTemplate.update({
        where: { id: request.params.id },
        data,
      });

      return reply.send(updated);
    }
  );

  // ── Notification logs (paginated) ──
  app.get(
    '/notifications/logs',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
    },
    async (request, reply) => {
      const page = Math.max(1, parseInt(request.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit) || 50));
      const skip = (page - 1) * limit;
      const { templateSlug, channel, recipientId } = request.query || {};

      const where = {};
      if (templateSlug) where.templateSlug = templateSlug;
      if (channel) where.channel = channel;
      if (recipientId) where.recipientId = recipientId;

      const [logs, total] = await Promise.all([
        prisma.notificationLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          include: {
            recipient: { select: { id: true, name: true, email: true } },
          },
        }),
        prisma.notificationLog.count({ where }),
      ]);

      return reply.send({
        data: logs,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    }
  );

  // ── Notification stats ──
  app.get(
    '/notifications/stats',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
    },
    async (request, reply) => {
      const [totalSent, emailSuccess, emailFailed, byCategory] = await Promise.all([
        prisma.notificationLog.count(),
        prisma.notificationLog.count({ where: { emailSentAt: { not: null } } }),
        prisma.notificationLog.count({ where: { emailError: { not: null } } }),
        prisma.$queryRaw`
          SELECT 
            t.category,
            COUNT(l.id) as count
          FROM NotificationLog l
          LEFT JOIN NotificationTemplate t ON l.templateSlug = t.slug
          GROUP BY t.category
          ORDER BY count DESC
        `,
      ]);

      return reply.send({
        totalSent,
        emailSuccess,
        emailFailed,
        byCategory: byCategory.map((r) => ({
          category: r.category || 'unknown',
          count: Number(r.count),
        })),
      });
    }
  );

  // ── Send test notification ──
  app.post(
    '/notifications/test/:slug',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        params: {
          type: 'object',
          properties: { slug: { type: 'string', minLength: 1 } },
          required: ['slug'],
        },
      },
    },
    async (request, reply) => {
      const template = await prisma.notificationTemplate.findUnique({
        where: { slug: request.params.slug },
      });
      if (!template) {
        return reply.status(404).send({ message: 'Template not found' });
      }

      // Build sample variables from the template's variable list
      const sampleVars = {};
      if (Array.isArray(template.variables)) {
        for (const v of template.variables) {
          sampleVars[v] = `[Test ${v}]`;
        }
      }

      await notify({
        slug: request.params.slug,
        recipientIds: [request.user.id],
        variables: sampleVars,
        actionUrl: '/portal/admin/notifications',
        metadata: { test: true },
      });

      return reply.send({ success: true, message: 'Test notification sent' });
    }
  );
}
