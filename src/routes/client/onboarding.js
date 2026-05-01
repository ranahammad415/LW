import { prisma } from '../../lib/prisma.js';
import { notify } from '../../lib/notificationService.js';

async function getPrimaryClient(userId) {
  const clientUsers = await prisma.clientUser.findMany({
    where: { userId },
    include: { client: true },
  });
  if (clientUsers.length === 0) return null;
  const primary = clientUsers.find((cu) => cu.isPrimaryContact)?.client ?? clientUsers[0].client;
  return primary;
}

export async function clientOnboardingRoutes(app) {
  app.get(
    '/onboarding/status',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              onboardingStatus: { type: 'string', nullable: true },
              onboardingStep: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const client = await getPrimaryClient(request.user.id);
      if (!client) return reply.status(404).send({ message: 'No client account linked' });
      return reply.send({
        onboardingStatus: client.onboardingStatus,
        onboardingStep: client.onboardingStep,
      });
    }
  );

  app.post(
    '/onboarding/intake',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
      schema: {
        body: {
          type: 'object',
          additionalProperties: true,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              onboardingStep: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const client = await getPrimaryClient(request.user.id);
      if (!client) return reply.status(404).send({ message: 'No client account linked' });
      const data = request.body || {};
      await prisma.$transaction([
        prisma.intakeSubmission.create({
          data: {
            clientId: client.id,
            submittedById: request.user.id,
            data,
          },
        }),
        prisma.clientAccount.update({
          where: { id: client.id },
          data: {
            onboardingStep: 3,
            onboardingStatus: 'IN_PROGRESS',
          },
        }),
      ]);
      return reply.send({ onboardingStep: 3 });
    }
  );

  app.post(
    '/onboarding/contract',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
      schema: {
        body: {
          type: 'object',
          properties: {
            signerName: { type: 'string' },
          },
          required: ['signerName'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              onboardingStep: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const client = await getPrimaryClient(request.user.id);
      if (!client) return reply.status(404).send({ message: 'No client account linked' });
      const { signerName } = request.body;
      const ip = request.ip || request.headers['x-forwarded-for'] || request.headers['x-real-ip'];
      const userAgent = request.headers['user-agent'] || null;
      await prisma.$transaction([
        prisma.contractRecord.create({
          data: {
            clientId: client.id,
            signerName: String(signerName).trim(),
            signerEmail: request.user.email,
            signerIp: ip ? String(ip).split(',')[0].trim() : null,
            userAgent: userAgent ? userAgent.slice(0, 500) : null,
          },
        }),
        prisma.clientAccount.update({
          where: { id: client.id },
          data: { onboardingStep: 5 },
        }),
      ]);
      return reply.send({ onboardingStep: 5 });
    }
  );

  app.post(
    '/onboarding/checklist',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        body: {
          type: 'object',
          properties: {
            logoUploaded: { type: 'boolean' },
            brandGuidelinesUploaded: { type: 'boolean' },
            brandColorsAdded: { type: 'boolean' },
            brandColors: { type: 'string', nullable: true },
            contentAssetsUploaded: { type: 'boolean' },
            notificationPrefsConfirmed: { type: 'boolean' },
            notifEmail: { type: 'boolean' },
            notifWhatsapp: { type: 'boolean' },
            notifInApp: { type: 'boolean' },
            profilePhotoAdded: { type: 'boolean' },
            profilePhotoUrl: { type: 'string', nullable: true },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              onboardingStep: { type: 'integer' },
              onboardingStatus: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const client = await getPrimaryClient(request.user.id);
      if (!client) return reply.status(404).send({ message: 'No client account linked' });
      const body = request.body || {};
      const checklist = {
        logoUploaded: Boolean(body.logoUploaded),
        brandGuidelinesUploaded: Boolean(body.brandGuidelinesUploaded),
        brandColorsAdded: Boolean(body.brandColorsAdded),
        brandColors: body.brandColors ? String(body.brandColors).slice(0, 1000) : null,
        contentAssetsUploaded: Boolean(body.contentAssetsUploaded),
        notificationPrefsConfirmed: Boolean(body.notificationPrefsConfirmed),
        notifEmail: body.notifEmail !== undefined ? Boolean(body.notifEmail) : true,
        notifWhatsapp: body.notifWhatsapp !== undefined ? Boolean(body.notifWhatsapp) : false,
        notifInApp: body.notifInApp !== undefined ? Boolean(body.notifInApp) : true,
        profilePhotoAdded: Boolean(body.profilePhotoAdded),
        profilePhotoUrl: body.profilePhotoUrl ? String(body.profilePhotoUrl).slice(0, 500) : null,
      };

      // Find existing client-level checklist (no projectId)
      const existingClientChecklist = await prisma.onboardingChecklist.findFirst({
        where: { clientId: client.id, projectId: null },
      });

      const ops = [];
      if (existingClientChecklist) {
        ops.push(
          prisma.onboardingChecklist.update({
            where: { id: existingClientChecklist.id },
            data: { ...checklist, completedAt: new Date() },
          })
        );
      } else {
        ops.push(
          prisma.onboardingChecklist.create({
            data: {
              clientId: client.id,
              ...checklist,
              completedAt: new Date(),
            },
          })
        );
      }
      ops.push(
        prisma.clientAccount.update({
          where: { id: client.id },
          data: {
            onboardingStep: 6,
            onboardingStatus: 'COMPLETE',
          },
        })
      );

      // If a profile photo was uploaded, also set it as the user avatar
      if (checklist.profilePhotoUrl) {
        ops.push(
          prisma.user.update({
            where: { id: request.user.id },
            data: { avatarUrl: checklist.profilePhotoUrl },
          })
        );
      }

      await prisma.$transaction(ops);

      // Seed notification preferences based on onboarding choices
      const emailEnabled = checklist.notifEmail;
      const inAppEnabled = checklist.notifInApp;
      const allTemplates = await prisma.notificationTemplate.findMany({ select: { slug: true } });
      if (allTemplates.length > 0) {
        const prefData = allTemplates.map((t) => ({
          userId: request.user.id,
          templateSlug: t.slug,
          emailEnabled,
          inAppEnabled,
        }));
        // Upsert each preference
        for (const pref of prefData) {
          await prisma.notificationPreference.upsert({
            where: { userId_templateSlug: { userId: pref.userId, templateSlug: pref.templateSlug } },
            create: pref,
            update: { emailEnabled: pref.emailEnabled, inAppEnabled: pref.inAppEnabled },
          });
        }
      }

      // Notify lead PM + owner about onboarding completion
      const recipients = [];
      if (client.leadPmId) recipients.push(client.leadPmId);
      const owners = await prisma.user.findMany({ where: { role: 'OWNER', isActive: true }, select: { id: true } });
      recipients.push(...owners.map((o) => o.id));
      if (recipients.length > 0) {
        notify({
          slug: 'client_onboarding_complete',
          recipientIds: recipients,
          variables: { clientName: client.agencyName },
          actionUrl: `/portal/admin/clients/${client.id}`,
          metadata: { clientId: client.id },
        }).catch(() => {});
      }

      return reply.send({ onboardingStep: 6, onboardingStatus: 'COMPLETE' });
    }
  );

  // ═══════════════════════════════════════════════════════════
  // PROJECT-SCOPED ONBOARDING ENDPOINTS
  // ═══════════════════════════════════════════════════════════

  async function verifyClientProjectAccess(userId, projectId) {
    const clientUsers = await prisma.clientUser.findMany({
      where: { userId },
      select: { clientId: true },
    });
    if (clientUsers.length === 0) return null;
    const clientIds = clientUsers.map((cu) => cu.clientId);
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { client: true },
    });
    if (!project || !clientIds.includes(project.clientId)) return null;
    return project;
  }

  // GET project onboarding status
  app.get(
    '/onboarding/project/:projectId/status',
    {
      onRequest: [app.verifyJwt, app.requireClient],
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
              projectId: { type: 'string' },
              status: { type: 'string' },
              onboardingStep: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const project = await verifyClientProjectAccess(request.user.id, request.params.projectId);
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      return reply.send({
        projectId: project.id,
        status: project.status,
        onboardingStep: project.onboardingStep,
      });
    }
  );

  // POST project intake
  app.post(
    '/onboarding/project/:projectId/intake',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        params: {
          type: 'object',
          properties: { projectId: { type: 'string', format: 'uuid' } },
          required: ['projectId'],
        },
        body: {
          type: 'object',
          additionalProperties: true,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              onboardingStep: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const project = await verifyClientProjectAccess(request.user.id, request.params.projectId);
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const data = request.body || {};
      await prisma.$transaction([
        prisma.intakeSubmission.create({
          data: {
            clientId: project.clientId,
            projectId: project.id,
            submittedById: request.user.id,
            data,
          },
        }),
        prisma.project.update({
          where: { id: project.id },
          data: { onboardingStep: 3 },
        }),
      ]);
      return reply.send({ onboardingStep: 3 });
    }
  );

  // POST project contract
  app.post(
    '/onboarding/project/:projectId/contract',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        params: {
          type: 'object',
          properties: { projectId: { type: 'string', format: 'uuid' } },
          required: ['projectId'],
        },
        body: {
          type: 'object',
          properties: {
            signerName: { type: 'string' },
          },
          required: ['signerName'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              onboardingStep: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const project = await verifyClientProjectAccess(request.user.id, request.params.projectId);
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const { signerName } = request.body;
      const ip = request.ip || request.headers['x-forwarded-for'] || request.headers['x-real-ip'];
      const userAgent = request.headers['user-agent'] || null;
      await prisma.$transaction([
        prisma.contractRecord.create({
          data: {
            clientId: project.clientId,
            projectId: project.id,
            signerName: String(signerName).trim(),
            signerEmail: request.user.email,
            signerIp: ip ? String(ip).split(',')[0].trim() : null,
            userAgent: userAgent ? userAgent.slice(0, 500) : null,
          },
        }),
        prisma.project.update({
          where: { id: project.id },
          data: { onboardingStep: 5 },
        }),
      ]);
      return reply.send({ onboardingStep: 5 });
    }
  );

  // POST project checklist (final step → marks project ACTIVE)
  app.post(
    '/onboarding/project/:projectId/checklist',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        params: {
          type: 'object',
          properties: { projectId: { type: 'string', format: 'uuid' } },
          required: ['projectId'],
        },
        body: {
          type: 'object',
          properties: {
            logoUploaded: { type: 'boolean' },
            brandGuidelinesUploaded: { type: 'boolean' },
            brandColorsAdded: { type: 'boolean' },
            brandColors: { type: 'string', nullable: true },
            contentAssetsUploaded: { type: 'boolean' },
            notificationPrefsConfirmed: { type: 'boolean' },
            notifEmail: { type: 'boolean' },
            notifWhatsapp: { type: 'boolean' },
            notifInApp: { type: 'boolean' },
            profilePhotoAdded: { type: 'boolean' },
            profilePhotoUrl: { type: 'string', nullable: true },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              onboardingStep: { type: 'integer' },
              status: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const project = await verifyClientProjectAccess(request.user.id, request.params.projectId);
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const body = request.body || {};
      const checklist = {
        logoUploaded: Boolean(body.logoUploaded),
        brandGuidelinesUploaded: Boolean(body.brandGuidelinesUploaded),
        brandColorsAdded: Boolean(body.brandColorsAdded),
        brandColors: body.brandColors ? String(body.brandColors).slice(0, 1000) : null,
        contentAssetsUploaded: Boolean(body.contentAssetsUploaded),
        notificationPrefsConfirmed: Boolean(body.notificationPrefsConfirmed),
        notifEmail: body.notifEmail !== undefined ? Boolean(body.notifEmail) : true,
        notifWhatsapp: body.notifWhatsapp !== undefined ? Boolean(body.notifWhatsapp) : false,
        notifInApp: body.notifInApp !== undefined ? Boolean(body.notifInApp) : true,
        profilePhotoAdded: Boolean(body.profilePhotoAdded),
        profilePhotoUrl: body.profilePhotoUrl ? String(body.profilePhotoUrl).slice(0, 500) : null,
      };

      // Find or create the onboarding checklist for this project
      const existingChecklist = await prisma.onboardingChecklist.findUnique({
        where: { projectId: project.id },
      });

      const ops = [];
      if (existingChecklist) {
        ops.push(
          prisma.onboardingChecklist.update({
            where: { projectId: project.id },
            data: { ...checklist, completedAt: new Date() },
          })
        );
      } else {
        ops.push(
          prisma.onboardingChecklist.create({
            data: {
              clientId: project.clientId,
              projectId: project.id,
              ...checklist,
              completedAt: new Date(),
            },
          })
        );
      }

      ops.push(
        prisma.project.update({
          where: { id: project.id },
          data: {
            onboardingStep: 6,
            status: 'ACTIVE',
          },
        })
      );

      // If a profile photo was uploaded, also set it as the user avatar
      if (checklist.profilePhotoUrl) {
        ops.push(
          prisma.user.update({
            where: { id: request.user.id },
            data: { avatarUrl: checklist.profilePhotoUrl },
          })
        );
      }

      await prisma.$transaction(ops);

      // Seed notification preferences
      const emailEnabled = checklist.notifEmail;
      const inAppEnabled = checklist.notifInApp;
      const allTemplates = await prisma.notificationTemplate.findMany({ select: { slug: true } });
      if (allTemplates.length > 0) {
        const prefData = allTemplates.map((t) => ({
          userId: request.user.id,
          templateSlug: t.slug,
          emailEnabled,
          inAppEnabled,
        }));
        for (const pref of prefData) {
          await prisma.notificationPreference.upsert({
            where: { userId_templateSlug: { userId: pref.userId, templateSlug: pref.templateSlug } },
            create: pref,
            update: { emailEnabled: pref.emailEnabled, inAppEnabled: pref.inAppEnabled },
          });
        }
      }

      // Notify lead PM + owners about project setup completion
      const recipients = [];
      if (project.leadPmId) recipients.push(project.leadPmId);
      if (project.client.leadPmId) recipients.push(project.client.leadPmId);
      const owners = await prisma.user.findMany({ where: { role: 'OWNER', isActive: true }, select: { id: true } });
      recipients.push(...owners.map((o) => o.id));
      const uniqueRecipients = [...new Set(recipients)];
      if (uniqueRecipients.length > 0) {
        notify({
          slug: 'client_onboarding_complete',
          recipientIds: uniqueRecipients,
          variables: { clientName: project.client.agencyName, projectName: project.name },
          actionUrl: `/portal/admin/clients/${project.clientId}`,
          metadata: { clientId: project.clientId, projectId: project.id },
        }).catch(() => {});
      }

      return reply.send({ onboardingStep: 6, status: 'ACTIVE' });
    }
  );
}
