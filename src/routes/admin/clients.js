import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { prisma } from '../../lib/prisma.js';
import { createClientBodySchema, updatePackageBodySchema } from '../../schemas/admin.js';
import { notify } from '../../lib/notificationService.js';

const accessSecret = process.env.JWT_ACCESS_SECRET;
const accessExpiresIn = process.env.JWT_ACCESS_EXPIRES_IN || '15m';

const TEMP_PASSWORD_LENGTH = 16;
const BCRYPT_ROUNDS = 10;

function generateTemporaryPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

export async function adminClientRoutes(app) {
  app.get(
    '/packages',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                maxKeywords: { type: 'integer' },
                keywordsLimit: { type: 'integer', nullable: true },
                projectsLimit: { type: 'integer', nullable: true },
                contentPiecesLimit: { type: 'integer', nullable: true },
                backlinksLimit: { type: 'integer', nullable: true },
                schemaPagesLimit: { type: 'integer', nullable: true },
                llmTestsLimit: { type: 'integer', nullable: true },
                storageGbLimit: { type: 'number', nullable: true },
                reportHistoryMonths: { type: 'integer', nullable: true },
                teamMembersLimit: { type: 'integer', nullable: true },
                lookerReportsLimit: { type: 'integer', nullable: true },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const packages = await prisma.package.findMany({
        orderBy: { name: 'asc' },
      });
      return reply.send(
        packages.map((p) => ({
          id: p.id,
          name: p.name,
          maxKeywords: p.maxKeywords,
          keywordsLimit: p.keywordsLimit,
          projectsLimit: p.projectsLimit,
          contentPiecesLimit: p.contentPiecesLimit,
          backlinksLimit: p.backlinksLimit,
          schemaPagesLimit: p.schemaPagesLimit,
          llmTestsLimit: p.llmTestsLimit,
          storageGbLimit: p.storageGbLimit != null ? Number(p.storageGbLimit) : null,
          reportHistoryMonths: p.reportHistoryMonths,
          teamMembersLimit: p.teamMembersLimit,
          lookerReportsLimit: p.lookerReportsLimit,
        }))
      );
    }
  );

  app.patch(
    '/packages/:id',
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
            maxKeywords: { type: 'integer' },
            keywordsLimit: { type: 'integer', nullable: true },
            projectsLimit: { type: 'integer', nullable: true },
            contentPiecesLimit: { type: 'integer', nullable: true },
            backlinksLimit: { type: 'integer', nullable: true },
            schemaPagesLimit: { type: 'integer', nullable: true },
            llmTestsLimit: { type: 'integer', nullable: true },
            storageGbLimit: { type: 'number', nullable: true },
            reportHistoryMonths: { type: 'integer', nullable: true },
            teamMembersLimit: { type: 'integer', nullable: true },
            lookerReportsLimit: { type: 'integer', nullable: true },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              maxKeywords: { type: 'integer' },
              keywordsLimit: { type: 'integer', nullable: true },
              projectsLimit: { type: 'integer', nullable: true },
              contentPiecesLimit: { type: 'integer', nullable: true },
              backlinksLimit: { type: 'integer', nullable: true },
              schemaPagesLimit: { type: 'integer', nullable: true },
              llmTestsLimit: { type: 'integer', nullable: true },
              storageGbLimit: { type: 'number', nullable: true },
              reportHistoryMonths: { type: 'integer', nullable: true },
              teamMembersLimit: { type: 'integer', nullable: true },
              lookerReportsLimit: { type: 'integer', nullable: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = updatePackageBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: 'Validation failed',
          errors: parsed.error.flatten().fieldErrors,
        });
      }
      const pkg = await prisma.package.findUnique({ where: { id: request.params.id } });
      if (!pkg) {
        return reply.status(404).send({ message: 'Package not found' });
      }
      const data = parsed.data;
      const update = {};
      if (data.maxKeywords !== undefined) update.maxKeywords = data.maxKeywords;
      if (data.keywordsLimit !== undefined) update.keywordsLimit = data.keywordsLimit;
      if (data.projectsLimit !== undefined) update.projectsLimit = data.projectsLimit;
      if (data.contentPiecesLimit !== undefined) update.contentPiecesLimit = data.contentPiecesLimit;
      if (data.backlinksLimit !== undefined) update.backlinksLimit = data.backlinksLimit;
      if (data.schemaPagesLimit !== undefined) update.schemaPagesLimit = data.schemaPagesLimit;
      if (data.llmTestsLimit !== undefined) update.llmTestsLimit = data.llmTestsLimit;
      if (data.storageGbLimit !== undefined) update.storageGbLimit = data.storageGbLimit;
      if (data.reportHistoryMonths !== undefined) update.reportHistoryMonths = data.reportHistoryMonths;
      if (data.teamMembersLimit !== undefined) update.teamMembersLimit = data.teamMembersLimit;
      if (data.lookerReportsLimit !== undefined) update.lookerReportsLimit = data.lookerReportsLimit;
      const updated = await prisma.package.update({
        where: { id: request.params.id },
        data: update,
      });
      return reply.send({
        id: updated.id,
        name: updated.name,
        maxKeywords: updated.maxKeywords,
        keywordsLimit: updated.keywordsLimit,
        projectsLimit: updated.projectsLimit,
        contentPiecesLimit: updated.contentPiecesLimit,
        backlinksLimit: updated.backlinksLimit,
        schemaPagesLimit: updated.schemaPagesLimit,
        llmTestsLimit: updated.llmTestsLimit,
        storageGbLimit: updated.storageGbLimit != null ? Number(updated.storageGbLimit) : null,
        reportHistoryMonths: updated.reportHistoryMonths,
        teamMembersLimit: updated.teamMembersLimit,
        lookerReportsLimit: updated.lookerReportsLimit,
      });
    }
  );

  app.get(
    '/clients',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                agencyName: { type: 'string' },
                websiteUrl: { type: 'string', nullable: true },
                industry: { type: 'string', nullable: true },
                country: { type: 'string', nullable: true },
                timezone: { type: 'string', nullable: true },
                leadPmId: { type: 'string', nullable: true },
                secondaryPmId: { type: 'string', nullable: true },
                onboardingStatus: { type: 'string', nullable: true },
                onboardingStep: { type: 'integer' },
                healthScore: { type: 'integer', nullable: true },
                isActive: { type: 'boolean' },
                package: { type: 'object', nullable: true },
                clientUsers: { type: 'array' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const clients = await prisma.clientAccount.findMany({
        orderBy: { agencyName: 'asc' },
        include: {
          package: true,
          clientUsers: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  name: true,
                  phone: true,
                },
              },
            },
          },
        },
      });
      return reply.send(clients);
    }
  );

  app.get(
    '/clients/:id',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
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
              agencyName: { type: 'string' },
              websiteUrl: { type: 'string', nullable: true },
              industry: { type: 'string', nullable: true },
              country: { type: 'string', nullable: true },
              timezone: { type: 'string', nullable: true },
              leadPmId: { type: 'string', nullable: true },
              secondaryPmId: { type: 'string', nullable: true },
              onboardingStatus: { type: 'string', nullable: true },
              onboardingStep: { type: 'integer' },
              healthScore: { type: 'integer', nullable: true },
              isActive: { type: 'boolean' },
              analyticsGoogleEmail: { type: 'string', nullable: true },
              package: { type: 'object', nullable: true },
              clientUsers: { type: 'array' },
              projects: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    status: { type: 'string' },
                    projectType: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const client = await prisma.clientAccount.findUnique({
        where: { id: request.params.id },
        include: {
          package: true,
          clientUsers: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  name: true,
                  phone: true,
                },
              },
            },
          },
          projects: {
            orderBy: { name: 'asc' },
            select: { id: true, name: true, status: true, projectType: true },
          },
        },
      });

      if (!client) {
        return reply.status(404).send({ message: 'Client not found' });
      }

      return reply.send({
        id: client.id,
        agencyName: client.agencyName,
        websiteUrl: client.websiteUrl,
        industry: client.industry,
        country: client.country,
        timezone: client.timezone,
        leadPmId: client.leadPmId,
        secondaryPmId: client.secondaryPmId,
        onboardingStatus: client.onboardingStatus,
        onboardingStep: client.onboardingStep,
        healthScore: client.healthScore,
        isActive: client.isActive,
        analyticsGoogleEmail: client.analyticsGoogleEmail ?? null,
        package: client.package,
        clientUsers: client.clientUsers,
        projects: client.projects.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          projectType: p.projectType,
        })),
      });
    }
  );

  app.post(
    '/clients',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        body: {
          type: 'object',
          properties: {
            agencyName: { type: 'string' },
            websiteUrl: { type: 'string' },
            industry: { type: 'string' },
            country: { type: 'string' },
            timezone: { type: 'string' },
            packageId: { type: 'string', format: 'uuid' },
            leadPmId: { type: 'string', format: 'uuid' },
            secondaryPmId: { type: 'string', format: 'uuid' },
            contactName: { type: 'string' },
            contactEmail: { type: 'string', format: 'email' },
            contactPhone: { type: 'string' },
            contactPassword: { type: 'string' },
          },
          required: ['agencyName', 'contactName', 'contactEmail'],
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              agencyName: { type: 'string' },
              package: { type: 'object', nullable: true },
              primaryContact: { type: 'object' },
              tempPassword: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = createClientBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: 'Validation failed',
          errors: parsed.error.flatten().fieldErrors,
        });
      }
      const data = parsed.data;
      const ownerId = request.user.id;

      const websiteUrl = data.websiteUrl && data.websiteUrl.trim() !== '' ? data.websiteUrl.trim() : null;
      const packageId = data.packageId && data.packageId.trim() !== '' ? data.packageId : null;
      const leadPmId = data.leadPmId && data.leadPmId.trim() !== '' ? data.leadPmId : null;
      const secondaryPmId =
        data.secondaryPmId && data.secondaryPmId.trim() !== '' ? data.secondaryPmId : null;

      if (leadPmId) {
        const pm = await prisma.user.findFirst({
          where: { id: leadPmId, role: 'PM', isActive: true },
        });
        if (!pm) {
          return reply.status(400).send({ message: 'Lead PM not found or inactive' });
        }
      }
      if (secondaryPmId) {
        const pm = await prisma.user.findFirst({
          where: { id: secondaryPmId, role: 'PM', isActive: true },
        });
        if (!pm) {
          return reply.status(400).send({ message: 'Secondary PM not found or inactive' });
        }
      }
      if (packageId) {
        const pkg = await prisma.package.findUnique({ where: { id: packageId } });
        if (!pkg) {
          return reply.status(400).send({ message: 'Package not found' });
        }
      }

      const contactEmailLower = data.contactEmail.trim().toLowerCase();

      const result = await prisma.$transaction(async (tx) => {
        const client = await tx.clientAccount.create({
          data: {
            agencyName: data.agencyName.trim(),
            websiteUrl,
            industry: data.industry?.trim() || null,
            country: data.country?.trim() || null,
            timezone: data.timezone?.trim() || null,
            packageId,
            leadPmId,
            secondaryPmId,
          },
        });

        let user = await tx.user.findUnique({
          where: { email: contactEmailLower },
        });

        let plainPassword = null;

        if (!user) {
          plainPassword = data.contactPassword || generateTemporaryPassword();
          const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
          user = await tx.user.create({
            data: {
              email: contactEmailLower,
              passwordHash,
              role: 'CLIENT',
              name: data.contactName.trim(),
              phone: data.contactPhone?.trim() || null,
            },
          });
        }

        await tx.clientUser.create({
          data: {
            clientId: client.id,
            userId: user.id,
            jobTitle: null,
            isPrimaryContact: true,
            canApproveDeliverables: true,
            canSignContracts: false,
            addedById: ownerId,
          },
        });

        const clientWithRelations = await tx.clientAccount.findUnique({
          where: { id: client.id },
          include: {
            package: true,
            clientUsers: {
              where: { isPrimaryContact: true },
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    name: true,
                    phone: true,
                  },
                },
              },
            },
          },
        });

        const primaryContact = clientWithRelations.clientUsers[0]?.user ?? {
          id: user.id,
          email: user.email,
          name: user.name,
          phone: user.phone,
        };

        return { client: clientWithRelations, primaryContact, plainPassword };
      });

      // Fire welcome email (non-blocking)
      notify({
        slug: 'welcome_email',
        recipientIds: [result.primaryContact.id],
        variables: {
          contactName: result.primaryContact.name,
          clientName: result.client.agencyName,
          loginUrl: process.env.FRONTEND_URL || 'https://app.yourdomain.com',
          tempPassword: result.plainPassword || '(existing password)',
        },
        actionUrl: '/portal/client',
        metadata: { clientId: result.client.id },
      }).catch(() => {});

      return reply.status(201).send({
        id: result.client.id,
        agencyName: result.client.agencyName,
        websiteUrl: result.client.websiteUrl,
        industry: result.client.industry,
        country: result.client.country,
        timezone: result.client.timezone,
        packageId: result.client.packageId,
        leadPmId: result.client.leadPmId,
        secondaryPmId: result.client.secondaryPmId,
        onboardingStatus: result.client.onboardingStatus,
        onboardingStep: result.client.onboardingStep,
        healthScore: result.client.healthScore,
        isActive: result.client.isActive,
        package: result.client.package,
        clientUsers: result.client.clientUsers,
        primaryContact: result.primaryContact,
        tempPassword: result.plainPassword,
      });
    }
  );

  // ── Edit client account (OWNER only) ──
  app.patch(
    '/clients/:id',
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
            agencyName: { type: 'string' },
            websiteUrl: { type: 'string', nullable: true },
            industry: { type: 'string', nullable: true },
            country: { type: 'string', nullable: true },
            timezone: { type: 'string', nullable: true },
            packageId: { type: 'string', format: 'uuid', nullable: true },
            leadPmId: { type: 'string', format: 'uuid', nullable: true },
            secondaryPmId: { type: 'string', format: 'uuid', nullable: true },
            analyticsGoogleEmail: { type: 'string', nullable: true },
            internalNotes: { type: 'string', nullable: true },
            isActive: { type: 'boolean' },
            contactEmail: { type: 'string', format: 'email' },
            contactName: { type: 'string' },
            contactPhone: { type: 'string', nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const client = await prisma.clientAccount.findUnique({
        where: { id },
        include: {
          clientUsers: {
            where: { isPrimaryContact: true },
            include: { user: { select: { id: true, email: true, name: true, phone: true } } },
          },
        },
      });
      if (!client) {
        return reply.status(404).send({ message: 'Client not found' });
      }

      const body = request.body || {};
      const clientData = {};
      const userDataUpdates = [];

      // ClientAccount fields
      if (body.agencyName !== undefined) clientData.agencyName = String(body.agencyName).trim().slice(0, 255);
      if (body.websiteUrl !== undefined) clientData.websiteUrl = body.websiteUrl ? String(body.websiteUrl).trim().slice(0, 500) : null;
      if (body.industry !== undefined) clientData.industry = body.industry ? String(body.industry).trim().slice(0, 255) : null;
      if (body.country !== undefined) clientData.country = body.country ? String(body.country).trim().slice(0, 100) : null;
      if (body.timezone !== undefined) clientData.timezone = body.timezone ? String(body.timezone).trim().slice(0, 100) : null;
      if (body.analyticsGoogleEmail !== undefined) clientData.analyticsGoogleEmail = body.analyticsGoogleEmail ? String(body.analyticsGoogleEmail).trim().toLowerCase() : null;
      if (body.internalNotes !== undefined) clientData.internalNotes = body.internalNotes ? String(body.internalNotes) : null;
      if (body.isActive !== undefined) clientData.isActive = Boolean(body.isActive);

      // Validate and set packageId
      if (body.packageId !== undefined) {
        if (body.packageId) {
          const pkg = await prisma.package.findUnique({ where: { id: body.packageId } });
          if (!pkg) return reply.status(400).send({ message: 'Package not found' });
        }
        clientData.packageId = body.packageId || null;
      }
      // Validate and set leadPmId
      if (body.leadPmId !== undefined) {
        if (body.leadPmId) {
          const pm = await prisma.user.findFirst({ where: { id: body.leadPmId, role: 'PM', isActive: true } });
          if (!pm) return reply.status(400).send({ message: 'Lead PM not found or inactive' });
        }
        clientData.leadPmId = body.leadPmId || null;
      }
      // Validate and set secondaryPmId
      if (body.secondaryPmId !== undefined) {
        if (body.secondaryPmId) {
          const pm = await prisma.user.findFirst({ where: { id: body.secondaryPmId, role: 'PM', isActive: true } });
          if (!pm) return reply.status(400).send({ message: 'Secondary PM not found or inactive' });
        }
        clientData.secondaryPmId = body.secondaryPmId || null;
      }

      // Primary contact user updates
      const primaryCU = client.clientUsers[0];
      if (primaryCU) {
        const userData = {};
        if (body.contactName !== undefined) userData.name = String(body.contactName).trim().slice(0, 255);
        if (body.contactPhone !== undefined) userData.phone = body.contactPhone ? String(body.contactPhone).trim().slice(0, 50) : null;

        // Contact email change
        if (body.contactEmail !== undefined) {
          const newEmail = String(body.contactEmail).trim().toLowerCase();
          if (newEmail !== primaryCU.user.email) {
            // Check uniqueness
            const existing = await prisma.user.findUnique({ where: { email: newEmail } });
            if (existing) {
              return reply.status(400).send({ message: 'Email is already in use by another user' });
            }
            userData.email = newEmail;
          }
        }

        if (Object.keys(userData).length > 0) {
          userDataUpdates.push(
            prisma.user.update({ where: { id: primaryCU.user.id }, data: userData })
          );
        }
      }

      // Execute updates
      const ops = [];
      if (Object.keys(clientData).length > 0) {
        ops.push(prisma.clientAccount.update({ where: { id }, data: clientData }));
      }
      ops.push(...userDataUpdates);

      if (ops.length > 0) {
        await prisma.$transaction(ops);
      }

      // Return updated client
      const updated = await prisma.clientAccount.findUnique({
        where: { id },
        include: {
          package: true,
          clientUsers: {
            include: {
              user: { select: { id: true, email: true, name: true, phone: true } },
            },
          },
          projects: {
            orderBy: { name: 'asc' },
            select: { id: true, name: true, status: true, projectType: true },
          },
        },
      });

      return reply.send({
        id: updated.id,
        agencyName: updated.agencyName,
        websiteUrl: updated.websiteUrl,
        industry: updated.industry,
        country: updated.country,
        timezone: updated.timezone,
        leadPmId: updated.leadPmId,
        secondaryPmId: updated.secondaryPmId,
        onboardingStatus: updated.onboardingStatus,
        onboardingStep: updated.onboardingStep,
        healthScore: updated.healthScore,
        isActive: updated.isActive,
        analyticsGoogleEmail: updated.analyticsGoogleEmail ?? null,
        internalNotes: updated.internalNotes ?? null,
        package: updated.package,
        clientUsers: updated.clientUsers,
        projects: updated.projects.map((p) => ({ id: p.id, name: p.name, status: p.status, projectType: p.projectType })),
      });
    }
  );

  // ── Set analytics Google email for a client account ──
  app.patch(
    '/clients/:id/analytics-google',
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
            analyticsGoogleEmail: { type: 'string', nullable: true },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              analyticsGoogleEmail: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const client = await prisma.clientAccount.findUnique({
        where: { id: request.params.id },
      });
      if (!client) {
        return reply.status(404).send({ message: 'Client not found' });
      }

      const email = request.body.analyticsGoogleEmail?.trim().toLowerCase() || null;

      const updated = await prisma.clientAccount.update({
        where: { id: request.params.id },
        data: { analyticsGoogleEmail: email },
      });

      return reply.send({
        id: updated.id,
        analyticsGoogleEmail: updated.analyticsGoogleEmail,
      });
    }
  );

  // ── Reset password for a client user ──
  app.post(
    '/clients/:id/reset-password',
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
            userId: { type: 'string', format: 'uuid' },
            newPassword: { type: 'string' },
          },
          required: ['userId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              userId: { type: 'string' },
              email: { type: 'string' },
              tempPassword: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { userId, newPassword } = request.body;

      // Verify the user belongs to this client
      const clientUser = await prisma.clientUser.findFirst({
        where: { clientId: id, userId },
        include: { user: { select: { id: true, email: true, name: true } } },
      });
      if (!clientUser) {
        return reply.status(404).send({ message: 'User not found for this client' });
      }

      const plainPassword = newPassword && newPassword.trim().length >= 8
        ? newPassword.trim()
        : generateTemporaryPassword();

      const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);

      await prisma.user.update({
        where: { id: userId },
        data: { passwordHash },
      });

      // Notify user about password reset
      notify({
        slug: 'password_reset',
        recipientIds: [userId],
        variables: {
          userName: clientUser.user.name,
          tempPassword: plainPassword,
        },
        metadata: { clientId: id },
      }).catch(() => {});

      return reply.send({
        userId: clientUser.user.id,
        email: clientUser.user.email,
        tempPassword: plainPassword,
      });
    }
  );

  // ── Impersonate a client user (OWNER only) ──
  app.post(
    '/impersonate',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        body: {
          type: 'object',
          properties: {
            userId: { type: 'string', format: 'uuid' },
          },
          required: ['userId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              accessToken: { type: 'string' },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  role: { type: 'string' },
                  name: { type: 'string' },
                  avatarUrl: { type: 'string', nullable: true },
                  phone: { type: 'string', nullable: true },
                  timezone: { type: 'string', nullable: true },
                  clientAccountIds: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.body;

      const targetUser = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          role: true,
          name: true,
          avatarUrl: true,
          phone: true,
          timezone: true,
          isActive: true,
        },
      });

      if (!targetUser || !targetUser.isActive) {
        return reply.status(404).send({ message: 'Client user not found or inactive' });
      }
      if (targetUser.role !== 'CLIENT') {
        return reply.status(400).send({ message: 'Can only impersonate CLIENT users' });
      }

      // Generate an access token for the client user
      const accessToken = jwt.sign(
        { sub: targetUser.id, role: targetUser.role, impersonatedBy: request.user.id },
        accessSecret,
        { expiresIn: accessExpiresIn }
      );

      const clientUsers = await prisma.clientUser.findMany({
        where: { userId: targetUser.id },
        select: { clientId: true },
      });

      return reply.send({
        accessToken,
        user: {
          id: targetUser.id,
          email: targetUser.email,
          role: targetUser.role,
          name: targetUser.name,
          avatarUrl: targetUser.avatarUrl ?? null,
          phone: targetUser.phone ?? null,
          timezone: targetUser.timezone ?? null,
          clientAccountIds: clientUsers.map((cu) => cu.clientId),
        },
      });
    }
  );
}
