import { prisma } from '../../lib/prisma.js';
import { notify } from '../../lib/notificationService.js';

export async function clientProjectsRoutes(app) {
  app.get(
    '/projects',
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

      const projects = await prisma.project.findMany({
        where: { clientId: { in: clientIds } },
        include: {
          client: {
            select: { package: { select: { maxKeywords: true } } },
          },
          leadPm: {
            select: { id: true, name: true, avatarUrl: true },
          },
          tasks: {
            where: { clientVisible: true },
            select: { id: true, status: true },
          },
          trackedKeywords: {
            orderBy: { updatedAt: 'desc' },
            select: {
              id: true,
              keyword: true,
              volume: true,
              currentRank: true,
              targetUrl: true,
              status: true,
              sitemapNodeId: true,
              clientNote: true,
              updatedAt: true,
              suggestedKeyword: true,
              suggestedTargetUrl: true,
              suggestedNotes: true,
            },
          },
        },
      });

      return reply.send(
        projects.map((p) => ({
          id: p.id,
          name: p.name,
          projectType: p.projectType,
          status: p.status,
          wpThemeName: p.wpThemeName,
          wpThemeVersion: p.wpThemeVersion,
          wpPlugins: p.wpPlugins,
          wpSiteInfoSyncedAt: p.wpSiteInfoSyncedAt,
          leadPm: p.leadPm
            ? {
                id: p.leadPm.id,
                name: p.leadPm.name,
                avatarUrl: p.leadPm.avatarUrl,
              }
            : null,
          tasks: p.tasks.map((t) => ({ id: t.id, status: t.status })),
          trackedKeywords: p.trackedKeywords,
          maxKeywords: p.client?.package?.maxKeywords ?? 10,
        }))
      );
    }
  );

  app.patch(
    '/projects/:id/keywords/approve',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            keywordIds: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
            },
            sitemapNodeId: { type: 'string', format: 'uuid', nullable: true },
            clientNote: { type: 'string', nullable: true },
          },
          required: ['keywordIds'],
        },
        response: {
          200: { type: 'object', properties: { approved: { type: 'integer' } } },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user.id;
      const { id: projectId } = request.params;
      const { keywordIds, sitemapNodeId, clientNote } = request.body || {};

      const clientUsers = await prisma.clientUser.findMany({
        where: { userId },
        select: { clientId: true },
      });
      if (clientUsers.length === 0) {
        return reply.status(404).send({ message: 'No client account linked to this user' });
      }
      const clientIds = clientUsers.map((cu) => cu.clientId);

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
          client: {
            select: { id: true, packageId: true, package: { select: { maxKeywords: true } } },
          },
        },
      });
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' });
      }
      if (!clientIds.includes(project.clientId)) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      const maxKeywords = project.client?.package?.maxKeywords ?? 10;
      const currentApproved = await prisma.keywordTrack.count({
        where: { projectId, status: 'APPROVED' },
      });
      const toApprove = Array.isArray(keywordIds) ? keywordIds : [];
      if (currentApproved + toApprove.length > maxKeywords) {
        return reply.status(400).send({
          message: 'Keyword limit exceeded for your current plan.',
          maxKeywords,
          currentApproved,
          requested: toApprove.length,
        });
      }

      const data = { status: 'APPROVED' };
      if (sitemapNodeId) {
        const node = await prisma.sitemapNode.findFirst({
          where: { id: sitemapNodeId, projectId },
          select: { id: true },
        });
        if (node) data.sitemapNodeId = sitemapNodeId;
      }
      if (typeof clientNote === 'string' && clientNote.trim()) {
        data.clientNote = clientNote.trim();
      }

      await prisma.keywordTrack.updateMany({
        where: { id: { in: toApprove }, projectId },
        data,
      });

      // Notify PM about client keyword approval
      try {
        const approveProject = await prisma.project.findUnique({ where: { id: projectId }, select: { leadPmId: true, name: true } });
        if (approveProject?.leadPmId) {
          notify({
            slug: 'keyword_approved_by_client',
            recipientIds: [approveProject.leadPmId],
            variables: { count: String(toApprove.length), projectName: approveProject.name || '' },
            actionUrl: `/portal/pm/projects/${projectId}`,
            metadata: { projectId },
          }).catch(() => {});
        }
      } catch (_) {}

      return reply.send({ approved: toApprove.length });
    }
  );

  app.patch(
    '/projects/:id/keywords/reject',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            keywordIds: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
            },
            clientNote: { type: 'string', nullable: true },
          },
          required: ['keywordIds'],
        },
        response: {
          200: { type: 'object', properties: { rejected: { type: 'integer' } } },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user.id;
      const { id: projectId } = request.params;
      const { keywordIds, clientNote } = request.body || {};

      const clientUsers = await prisma.clientUser.findMany({
        where: { userId },
        select: { clientId: true },
      });
      if (clientUsers.length === 0) {
        return reply.status(404).send({ message: 'No client account linked to this user' });
      }
      const clientIds = clientUsers.map((cu) => cu.clientId);

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, clientId: true },
      });
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' });
      }
      if (!clientIds.includes(project.clientId)) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      const toReject = Array.isArray(keywordIds) ? keywordIds : [];
      const data = { status: 'REJECTED' };
      if (typeof clientNote === 'string' && clientNote.trim()) {
        data.clientNote = clientNote.trim();
      }

      await prisma.keywordTrack.updateMany({
        where: { id: { in: toReject }, projectId },
        data,
      });

      // Notify PM about client keyword rejection
      try {
        const rejectProject = await prisma.project.findUnique({ where: { id: projectId }, select: { leadPmId: true, name: true } });
        if (rejectProject?.leadPmId) {
          notify({
            slug: 'keyword_rejected_by_client',
            recipientIds: [rejectProject.leadPmId],
            variables: { count: String(toReject.length), projectName: rejectProject.name || '' },
            actionUrl: `/portal/pm/projects/${projectId}`,
            metadata: { projectId },
          }).catch(() => {});
        }
      } catch (_) {}

      return reply.send({ rejected: toReject.length });
    }
  );

  app.get(
    '/projects/:id/sitemap',
    {
      onRequest: [app.verifyJwt, app.requireClient],
    },
    async (request, reply) => {
      const userId = request.user.id;
      const { id: projectId } = request.params;

      const clientUsers = await prisma.clientUser.findMany({
        where: { userId },
        select: { clientId: true },
      });
      if (clientUsers.length === 0) {
        return reply.status(404).send({ message: 'No client account linked to this user' });
      }
      const clientIds = clientUsers.map((cu) => cu.clientId);

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, clientId: true },
      });
      if (!project || !clientIds.includes(project.clientId)) {
        return reply.status(404).send({ message: 'Project not found' });
      }

      const nodes = await prisma.sitemapNode.findMany({
        where: { projectId },
        orderBy: { url: 'asc' },
        select: { id: true, url: true, title: true, pageType: true },
      });
      return reply.send(nodes);
    }
  );

  // AEO summary for client (read-only, sanitized: no full LLM response)
  app.get(
    '/projects/:id/aeo-summary',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              promptTestsThisMonth: { type: 'integer' },
              totalLogs: { type: 'integer' },
              citedCount: { type: 'integer' },
              platformsTracked: {
                type: 'array',
                items: { type: 'string' },
              },
              recentLogs: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    platform: { type: 'string' },
                    promptQuery: { type: 'string' },
                    cited: { type: 'boolean', nullable: true },
                    createdAt: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user.id;
      const { id: projectId } = request.params;

      const clientUsers = await prisma.clientUser.findMany({
        where: { userId },
        select: { clientId: true },
      });
      if (clientUsers.length === 0) {
        return reply.status(404).send({ message: 'No client account linked to this user' });
      }
      const clientIds = clientUsers.map((cu) => cu.clientId);

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, clientId: true },
      });
      if (!project || !clientIds.includes(project.clientId)) {
        return reply.status(404).send({ message: 'Project not found' });
      }

      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const [allLogs, promptTestsThisMonth] = await Promise.all([
        prisma.promptLog.findMany({
          where: { projectId },
          select: { id: true, platform: true, promptQuery: true, cited: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.promptLog.count({
          where: { projectId, createdAt: { gte: startOfMonth } },
        }),
      ]);

      const totalLogs = allLogs.length;
      const citedCount = allLogs.filter((l) => l.cited === true).length;
      const platformsTracked = [...new Set(allLogs.map((l) => l.platform).filter(Boolean))];
      const recentLogs = allLogs.slice(0, 20).map((l) => ({
        id: l.id,
        platform: l.platform,
        promptQuery: l.promptQuery,
        cited: l.cited,
        createdAt: l.createdAt.toISOString(),
      }));

      return reply.send({
        promptTestsThisMonth,
        totalLogs,
        citedCount,
        platformsTracked,
        recentLogs,
      });
    }
  );

  // --- Client Prompt Logs (read-only, with new AEO fields) ---
  app.get(
    '/projects/:id/prompt-logs',
    {
      onRequest: [app.verifyJwt, app.requireClient],
    },
    async (request, reply) => {
      const userId = request.user.id;
      const { id: projectId } = request.params;

      const clientUsers = await prisma.clientUser.findMany({
        where: { userId },
        select: { clientId: true },
      });
      if (clientUsers.length === 0) {
        return reply.status(404).send({ message: 'No client account linked to this user' });
      }
      const clientIds = clientUsers.map((cu) => cu.clientId);

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, clientId: true },
      });
      if (!project || !clientIds.includes(project.clientId)) {
        return reply.status(404).send({ message: 'Project not found' });
      }

      const logs = await prisma.promptLog.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        include: {
          linkedWpPage: { select: { id: true, title: true, slug: true } },
          automatedRuns: {
            orderBy: { runDate: 'desc' },
            take: 8,
            select: { id: true, runDate: true, wasCited: true },
          },
        },
      });

      return reply.send(
        logs.map((l) => ({
          id: l.id,
          platform: l.platform,
          promptQuery: l.promptQuery,
          keyword: l.keyword,
          targetUrl: l.targetUrl,
          cited: l.cited,
          competitorsCited: l.competitorsCited,
          sentimentScore: l.sentimentScore,
          linkedWpPage: l.linkedWpPage,
          recentRuns: l.automatedRuns.map((r) => ({
            id: r.id,
            runDate: r.runDate,
            wasCited: r.wasCited,
          })),
          createdAt: l.createdAt,
        }))
      );
    }
  );

  // --- Client WP Pages (read-only) ---
  app.get(
    '/projects/:id/wp-pages',
    {
      onRequest: [app.verifyJwt, app.requireClient],
    },
    async (request, reply) => {
      const userId = request.user.id;
      const { id: projectId } = request.params;

      const clientUsers = await prisma.clientUser.findMany({
        where: { userId },
        select: { clientId: true },
      });
      if (clientUsers.length === 0) {
        return reply.status(404).send({ message: 'No client account linked to this user' });
      }
      const clientIds = clientUsers.map((cu) => cu.clientId);

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, clientId: true },
      });
      if (!project || !clientIds.includes(project.clientId)) {
        return reply.status(404).send({ message: 'Project not found' });
      }

      const pages = await prisma.wpPage.findMany({
        where: { projectId },
        orderBy: { title: 'asc' },
        select: {
          id: true,
          title: true,
          slug: true,
          status: true,
          postType: true,
          url: true,
          seoTitle: true,
          seoDescription: true,
          syncedAt: true,
        },
      });

      return reply.send(pages);
    }
  );

  // --- Keyword suggest-edit endpoint ---
  app.patch(
    '/projects/:id/keywords/suggest-edit',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
    },
    async (request, reply) => {
      const { id } = request.params;
      const { keywordIds, suggestedKeyword, suggestedTargetUrl, suggestedNotes } =
        request.body || {};

      if (!keywordIds || !Array.isArray(keywordIds) || keywordIds.length === 0) {
        return reply.status(400).send({ message: 'keywordIds required' });
      }

      // Verify the keywords belong to this project and are in PROPOSED status
      const keywords = await prisma.keywordTrack.findMany({
        where: { id: { in: keywordIds }, projectId: id, status: 'PROPOSED' },
      });
      if (keywords.length === 0) {
        return reply.status(404).send({ message: 'No eligible keywords found' });
      }

      await prisma.keywordTrack.updateMany({
        where: { id: { in: keywords.map((k) => k.id) } },
        data: {
          status: 'EDIT_SUGGESTED',
          suggestedKeyword: suggestedKeyword || null,
          suggestedTargetUrl: suggestedTargetUrl || null,
          suggestedNotes: suggestedNotes || null,
        },
      });

      // Notify PM about client keyword edit suggestion
      try {
        const editProject = await prisma.project.findUnique({ where: { id }, select: { leadPmId: true, name: true } });
        if (editProject?.leadPmId) {
          notify({
            slug: 'keyword_edit_suggested',
            recipientIds: [editProject.leadPmId],
            variables: { count: String(keywords.length), projectName: editProject.name || '' },
            actionUrl: `/portal/pm/projects/${id}`,
            metadata: { projectId: id },
          }).catch(() => {});
        }
      } catch (_) {}

      return { updated: keywords.length };
    }
  );

  // --- Keyword comments: GET ---
  app.get(
    '/projects/:id/keywords/:keywordId/comments',
    {
      onRequest: [app.verifyJwt, app.requireClient],
    },
    async (request, reply) => {
      const { id, keywordId } = request.params;

      // Verify keyword belongs to this project
      const keyword = await prisma.keywordTrack.findFirst({
        where: { id: keywordId, projectId: id },
      });
      if (!keyword) return reply.status(404).send({ message: 'Keyword not found' });

      const comments = await prisma.keywordComment.findMany({
        where: { keywordTrackId: keywordId },
        orderBy: { createdAt: 'asc' },
        include: {
          user: { select: { id: true, name: true, role: true } },
        },
      });

      return comments;
    }
  );

  // --- Keyword comments: POST ---
  app.post(
    '/projects/:id/keywords/:keywordId/comments',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
    },
    async (request, reply) => {
      const { id, keywordId } = request.params;
      const { message } = request.body || {};

      if (!message || !message.trim()) {
        return reply.status(400).send({ message: 'Message is required' });
      }

      // Verify keyword belongs to this project
      const keyword = await prisma.keywordTrack.findFirst({
        where: { id: keywordId, projectId: id },
      });
      if (!keyword) return reply.status(404).send({ message: 'Keyword not found' });

      const comment = await prisma.keywordComment.create({
        data: {
          keywordTrackId: keywordId,
          userId: request.user.id,
          message: message.trim(),
        },
        include: {
          user: { select: { id: true, name: true, role: true } },
        },
      });

      return reply.status(201).send(comment);
    }
  );

  // ── Onboarding / Intake data for a client's project ──
  app.get(
    '/projects/:id/intake',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              onboardingStatus: { type: 'string', nullable: true },
              onboardingStep: { type: 'integer' },
              intakeSubmissions: { type: 'array', items: { type: 'object' } },
              contractRecords: { type: 'array', items: { type: 'object' } },
              onboardingChecklist: { type: 'object', nullable: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user.id;
      const { id: projectId } = request.params;

      // Verify client has access to this project
      const clientUsers = await prisma.clientUser.findMany({
        where: { userId },
        select: { clientId: true },
      });
      const clientIds = clientUsers.map((cu) => cu.clientId);

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, clientId: true },
      });
      if (!project || !clientIds.includes(project.clientId)) {
        return reply.status(404).send({ message: 'Project not found' });
      }

      const clientId = project.clientId;

      const clientAccount = await prisma.clientAccount.findUnique({
        where: { id: clientId },
        select: { onboardingStatus: true, onboardingStep: true },
      });

      const intakeSubmissions = await prisma.intakeSubmission.findMany({
        where: { clientId },
        orderBy: { submittedAt: 'desc' },
      });

      const contractRecords = await prisma.contractRecord.findMany({
        where: { clientId },
        orderBy: { signedAt: 'desc' },
      });

      const onboardingChecklist = await prisma.onboardingChecklist.findFirst({
        where: { clientId, projectId: null },
      });

      return reply.send({
        onboardingStatus: clientAccount?.onboardingStatus ?? null,
        onboardingStep: clientAccount?.onboardingStep ?? 1,
        intakeSubmissions: intakeSubmissions.map((s) => ({
          id: s.id,
          data: s.data,
          submittedAt: s.submittedAt.toISOString(),
        })),
        contractRecords: contractRecords.map((c) => ({
          id: c.id,
          signerName: c.signerName,
          signerEmail: c.signerEmail,
          signedAt: c.signedAt.toISOString(),
        })),
        onboardingChecklist: onboardingChecklist
          ? {
              logoUploaded: onboardingChecklist.logoUploaded,
              brandGuidelinesUploaded: onboardingChecklist.brandGuidelinesUploaded,
              brandColorsAdded: onboardingChecklist.brandColorsAdded,
              brandColors: onboardingChecklist.brandColors ?? null,
              contentAssetsUploaded: onboardingChecklist.contentAssetsUploaded,
              notificationPrefsConfirmed: onboardingChecklist.notificationPrefsConfirmed,
              notifEmail: onboardingChecklist.notifEmail,
              notifWhatsapp: onboardingChecklist.notifWhatsapp,
              notifInApp: onboardingChecklist.notifInApp,
              profilePhotoAdded: onboardingChecklist.profilePhotoAdded,
              profilePhotoUrl: onboardingChecklist.profilePhotoUrl ?? null,
              completedAt: onboardingChecklist.completedAt?.toISOString() ?? null,
            }
          : null,
      });
    }
  );

  // ── Client: Update own intake data + checklist ──
  app.patch(
    '/projects/:id/intake',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            intakeData: { type: 'object', additionalProperties: true },
            checklist: {
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
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user.id;
      const { id: projectId } = request.params;
      const { intakeData, checklist } = request.body || {};

      const clientUsers = await prisma.clientUser.findMany({
        where: { userId },
        select: { clientId: true },
      });
      const clientIds = clientUsers.map((cu) => cu.clientId);

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, clientId: true },
      });
      if (!project || !clientIds.includes(project.clientId)) {
        return reply.status(404).send({ message: 'Project not found' });
      }

      const clientId = project.clientId;
      const ops = [];

      if (intakeData && typeof intakeData === 'object') {
        const latest = await prisma.intakeSubmission.findFirst({
          where: { clientId },
          orderBy: { submittedAt: 'desc' },
        });
        if (latest) {
          ops.push(
            prisma.intakeSubmission.update({
              where: { id: latest.id },
              data: { data: intakeData },
            })
          );
        } else {
          ops.push(
            prisma.intakeSubmission.create({
              data: {
                clientId,
                submittedById: userId,
                data: intakeData,
              },
            })
          );
        }
      }

      if (checklist && typeof checklist === 'object') {
        const checklistData = {
          logoUploaded: Boolean(checklist.logoUploaded),
          brandGuidelinesUploaded: Boolean(checklist.brandGuidelinesUploaded),
          brandColorsAdded: Boolean(checklist.brandColorsAdded),
          ...(checklist.brandColors !== undefined ? { brandColors: checklist.brandColors ? String(checklist.brandColors).slice(0, 1000) : null } : {}),
          contentAssetsUploaded: Boolean(checklist.contentAssetsUploaded),
          notificationPrefsConfirmed: Boolean(checklist.notificationPrefsConfirmed),
          ...(checklist.notifEmail !== undefined ? { notifEmail: Boolean(checklist.notifEmail) } : {}),
          ...(checklist.notifWhatsapp !== undefined ? { notifWhatsapp: Boolean(checklist.notifWhatsapp) } : {}),
          ...(checklist.notifInApp !== undefined ? { notifInApp: Boolean(checklist.notifInApp) } : {}),
          profilePhotoAdded: Boolean(checklist.profilePhotoAdded),
          ...(checklist.profilePhotoUrl !== undefined ? { profilePhotoUrl: checklist.profilePhotoUrl ? String(checklist.profilePhotoUrl).slice(0, 500) : null } : {}),
        };
        // clientId is NOT @unique in the Prisma schema, so we cannot use upsert({ where: { clientId } }).
        // Match the GET handler's selector (client-level checklist where projectId is null).
        const existingChecklist = await prisma.onboardingChecklist.findFirst({
          where: { clientId, projectId: null },
        });
        if (existingChecklist) {
          ops.push(
            prisma.onboardingChecklist.update({
              where: { id: existingChecklist.id },
              data: checklistData,
            })
          );
        } else {
          ops.push(
            prisma.onboardingChecklist.create({
              data: { clientId, ...checklistData },
            })
          );
        }
      }

      if (ops.length > 0) {
        await prisma.$transaction(ops);
      }

      // Notify PM about intake data update
      try {
        const intakeProject = await prisma.project.findUnique({ where: { id: projectId }, select: { leadPmId: true, name: true } });
        if (intakeProject?.leadPmId) {
          const intakeClient = await prisma.clientAccount.findUnique({ where: { id: clientId }, select: { agencyName: true } });
          notify({
            slug: 'client_intake_updated',
            recipientIds: [intakeProject.leadPmId],
            variables: { projectName: intakeProject.name || '', clientName: intakeClient?.agencyName || '' },
            actionUrl: `/portal/pm/projects/${projectId}`,
            metadata: { projectId },
          }).catch(() => {});
        }
      } catch (_) {}

      return reply.send({ success: true });
    }
  );

  // ── Client: Content Reviews (pipeline) for a project ──
  app.get(
    '/projects/:id/pipeline',
    {
      onRequest: [app.verifyJwt, app.requireClient],
    },
    async (request, reply) => {
      const userId = request.user.id;
      const { id: projectId } = request.params;

      // Verify client owns this project
      const clientUsers = await prisma.clientUser.findMany({
        where: { userId },
        select: { clientId: true },
      });
      const clientIds = clientUsers.map((cu) => cu.clientId);

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, clientId: true },
      });
      if (!project || !clientIds.includes(project.clientId)) {
        return reply.status(404).send({ message: 'Project not found' });
      }

      try {
        const reviews = await prisma.wpContentReview.findMany({
          where: { projectId, isPublished: false },
          include: {
            events: { orderBy: { createdAt: 'desc' } },
          },
          orderBy: { updatedAt: 'desc' },
        });

        const STATUS_LABELS = {
          draft: 'Draft',
          pending_pm_review: 'Pending PM Review',
          pm_approved: 'PM Approved',
          pending_client_review: 'Awaiting Your Review',
          client_approved: 'Approved',
          changes_requested_by_pm: 'Changes Requested',
          changes_requested_by_client: 'Changes Requested',
          cancelled: 'Cancelled',
        };
        const STATUS_COLORS = {
          draft: '#888',
          pending_pm_review: '#f0b849',
          pm_approved: '#f0b849',
          pending_client_review: '#f0b849',
          client_approved: '#00a32a',
          changes_requested_by_pm: '#d63638',
          changes_requested_by_client: '#d63638',
          cancelled: '#888',
        };

        const result = reviews.map((r) => ({
          id: r.id,
          projectId: r.projectId,
          projectName: project.name,
          clientName: null,
          wpPipelineId: r.wpPipelineId,
          wpPostId: r.wpPostId,
          postTitle: r.postTitle,
          wpPostStatus: '',
          status: r.status,
          statusLabel: STATUS_LABELS[r.status] || r.status,
          submittedByName: r.submittedByName,
          submittedById: r.submittedById,
          pmMemberName: r.pmMemberName,
          pmMemberId: r.pmMemberId,
          pmPreviewUrl: r.pmPreviewUrl,
          clientPreviewUrl: r.clientPreviewUrl,
          pmDecision: r.pmDecision,
          pmComment: r.pmComment,
          pmReviewedAt: r.pmReviewedAt || null,
          clientDecision: r.clientDecision,
          clientComment: r.clientComment,
          clientReviewedAt: r.clientReviewedAt || null,
          revisionNumber: r.revisionNumber,
          createdAt: r.createdAt?.toISOString() || null,
          updatedAt: r.updatedAt?.toISOString() || null,
          history: (r.events || []).map((e) => ({
            revisionNumber: e.revisionNumber,
            status: e.status,
            statusLabel: STATUS_LABELS[e.status] || e.status,
            statusColor: STATUS_COLORS[e.status] || '#888',
            pmComment: e.pmComment,
            clientComment: e.clientComment,
            workerNote: e.workerNote,
            pmReviewedAt: e.pmReviewedAt,
            clientReviewedAt: e.clientReviewedAt,
            createdAt: e.createdAt?.toISOString() || null,
            updatedAt: e.createdAt?.toISOString() || null,
          })),
        }));

        return reply.send(result);
      } catch {
        return reply.send([]);
      }
    }
  );
}

