import { prisma } from '../../lib/prisma.js';
import { notify } from '../../lib/notificationService.js';

const VALID_AUDIENCES = ['AGENCY_OWNER', 'AGENCY_TEAM', 'CLIENT_MANAGER', 'CLIENT_VIEWER'];

export async function adminNotificationRoutes(app) {
  // ── List all notification templates (with variants) ──
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
        include: { variants: true },
      });

      return reply.send(templates);
    }
  );

  // ── Get single template (with variants) ──
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
        include: { variants: true },
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
            emailAgencyOwner: { type: 'boolean' },
            emailPm: { type: 'boolean' },
            emailClientManager: { type: 'boolean' },
            emailClientViewer: { type: 'boolean' },
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
      if (body.emailAgencyOwner !== undefined) data.emailAgencyOwner = Boolean(body.emailAgencyOwner);
      if (body.emailPm !== undefined) data.emailPm = Boolean(body.emailPm);
      if (body.emailClientManager !== undefined) data.emailClientManager = Boolean(body.emailClientManager);
      if (body.emailClientViewer !== undefined) data.emailClientViewer = Boolean(body.emailClientViewer);

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

  // ── Variant CRUD ──────────────────────────────────────────────────────────
  // List all variants for a template
  app.get(
    '/notifications/templates/:id/variants',
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
        select: { slug: true },
      });
      if (!template) {
        return reply.status(404).send({ message: 'Template not found' });
      }
      const variants = await prisma.notificationTemplateVariant.findMany({
        where: { templateSlug: template.slug },
        orderBy: { audience: 'asc' },
      });
      return reply.send(variants);
    }
  );

  // Upsert a variant for a specific audience
  app.put(
    '/notifications/templates/:id/variants/:audience',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1 },
            audience: { type: 'string', enum: VALID_AUDIENCES },
          },
          required: ['id', 'audience'],
        },
        body: {
          type: 'object',
          properties: {
            subject: { type: 'string', minLength: 1 },
            bodyHtml: { type: 'string', minLength: 1 },
            bodyText: { type: 'string', nullable: true },
            inAppMessage: { type: 'string', minLength: 1 },
            ctaLabel: { type: 'string', nullable: true },
          },
          required: ['subject', 'bodyHtml', 'inAppMessage'],
        },
      },
    },
    async (request, reply) => {
      const template = await prisma.notificationTemplate.findUnique({
        where: { id: request.params.id },
        select: { slug: true },
      });
      if (!template) {
        return reply.status(404).send({ message: 'Template not found' });
      }

      const body = request.body || {};
      const data = {
        subject: String(body.subject).trim().slice(0, 500),
        bodyHtml: String(body.bodyHtml),
        bodyText: body.bodyText ? String(body.bodyText) : null,
        inAppMessage: String(body.inAppMessage).trim().slice(0, 500),
        ctaLabel: body.ctaLabel ? String(body.ctaLabel).trim().slice(0, 60) : null,
      };

      const saved = await prisma.notificationTemplateVariant.upsert({
        where: {
          templateSlug_audience: {
            templateSlug: template.slug,
            audience: request.params.audience,
          },
        },
        create: {
          templateSlug: template.slug,
          audience: request.params.audience,
          ...data,
        },
        update: data,
      });

      return reply.send(saved);
    }
  );

  // Delete a variant (revert that audience to base template)
  app.delete(
    '/notifications/templates/:id/variants/:audience',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1 },
            audience: { type: 'string', enum: VALID_AUDIENCES },
          },
          required: ['id', 'audience'],
        },
      },
    },
    async (request, reply) => {
      const template = await prisma.notificationTemplate.findUnique({
        where: { id: request.params.id },
        select: { slug: true },
      });
      if (!template) {
        return reply.status(404).send({ message: 'Template not found' });
      }

      try {
        await prisma.notificationTemplateVariant.delete({
          where: {
            templateSlug_audience: {
              templateSlug: template.slug,
              audience: request.params.audience,
            },
          },
        });
      } catch (err) {
        if (err.code === 'P2025') {
          return reply.send({ success: true, alreadyAbsent: true });
        }
        throw err;
      }

      return reply.send({ success: true });
    }
  );

  // Send a test using a specific variant (renders that audience's copy).
  // We temporarily route the caller through that audience by upserting a
  // short-lived override is not necessary because the variant already exists
  // in DB for the targeted audience - we just need the caller's User.role
  // to match. Since the caller is always an OWNER in the admin UI, we
  // emulate audience rendering by building the email directly here.
  app.post(
    '/notifications/templates/:id/variants/:audience/test',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1 },
            audience: { type: 'string', enum: VALID_AUDIENCES },
          },
          required: ['id', 'audience'],
        },
      },
    },
    async (request, reply) => {
      const template = await prisma.notificationTemplate.findUnique({
        where: { id: request.params.id },
        include: { variants: true },
      });
      if (!template) {
        return reply.status(404).send({ message: 'Template not found' });
      }

      const variant = template.variants.find((v) => v.audience === request.params.audience);
      if (!variant) {
        return reply.status(404).send({
          message: `No variant saved for audience ${request.params.audience}. Save it first, then test.`,
        });
      }

      // Build sample variables from the template's variable list
      const sampleVars = {};
      if (Array.isArray(template.variables)) {
        for (const v of template.variables) {
          sampleVars[v] = `[Test ${v}]`;
        }
      }

      // Re-use the renderer by dispatching a real send to the current user.
      // Since the caller is an OWNER, the AGENCY_OWNER variant is what would
      // render. For other audiences, we temporarily mirror that variant into
      // AGENCY_OWNER for the test (rollback after) - simpler and accurate.
      const { audience } = request.params;
      if (audience === 'AGENCY_OWNER') {
        await notify({
          slug: template.slug,
          recipientIds: [request.user.id],
          variables: sampleVars,
          actionUrl: '/portal/admin/notifications',
          metadata: { test: true, testAudience: audience },
        });
      } else {
        // Save the owner variant, overwrite temporarily with the target variant,
        // send the test, then restore.
        const ownerVariant = template.variants.find((v) => v.audience === 'AGENCY_OWNER');
        await prisma.notificationTemplateVariant.upsert({
          where: {
            templateSlug_audience: { templateSlug: template.slug, audience: 'AGENCY_OWNER' },
          },
          create: {
            templateSlug: template.slug,
            audience: 'AGENCY_OWNER',
            subject: variant.subject,
            bodyHtml: variant.bodyHtml,
            bodyText: variant.bodyText,
            inAppMessage: variant.inAppMessage,
            ctaLabel: variant.ctaLabel,
          },
          update: {
            subject: variant.subject,
            bodyHtml: variant.bodyHtml,
            bodyText: variant.bodyText,
            inAppMessage: variant.inAppMessage,
            ctaLabel: variant.ctaLabel,
          },
        });

        try {
          await notify({
            slug: template.slug,
            recipientIds: [request.user.id],
            variables: sampleVars,
            actionUrl: '/portal/admin/notifications',
            metadata: { test: true, testAudience: audience },
          });
        } finally {
          if (ownerVariant) {
            await prisma.notificationTemplateVariant.update({
              where: {
                templateSlug_audience: { templateSlug: template.slug, audience: 'AGENCY_OWNER' },
              },
              data: {
                subject: ownerVariant.subject,
                bodyHtml: ownerVariant.bodyHtml,
                bodyText: ownerVariant.bodyText,
                inAppMessage: ownerVariant.inAppMessage,
                ctaLabel: ownerVariant.ctaLabel,
              },
            });
          } else {
            await prisma.notificationTemplateVariant.delete({
              where: {
                templateSlug_audience: { templateSlug: template.slug, audience: 'AGENCY_OWNER' },
              },
            }).catch(() => {});
          }
        }
      }

      return reply.send({ success: true, message: `Test sent using ${audience} variant` });
    }
  );
}
