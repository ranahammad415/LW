import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { notify } from '../../lib/notificationService.js';

async function getClientIdsForUser(userId) {
  const clientUsers = await prisma.clientUser.findMany({
    where: { userId },
    select: { clientId: true },
  });
  return clientUsers.map((cu) => cu.clientId);
}

const createIssueBodySchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().min(1),
  projectId: z.string().uuid().optional().nullable(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional().default('MEDIUM'),
});

const createCommentBodySchema = z.object({
  body: z.string().min(1),
  attachmentUrl: z.string().url().optional().nullable(),
});

const patchProfileBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  phone: z.string().max(50).optional().nullable(),
  timezone: z.string().max(100).optional().nullable(),
  jobTitle: z.string().max(255).optional().nullable(),
});

export async function clientHubRoutes(app) {
  // --- Meetings ---
  app.get(
    '/meetings',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const clientIds = await getClientIdsForUser(request.user.id);
      if (clientIds.length === 0) {
        return reply.status(404).send({ message: 'No client account linked to this user' });
      }

      const meetings = await prisma.meetingRecord.findMany({
        where: { clientId: { in: clientIds } },
        orderBy: { scheduledAt: 'desc' },
        include: {
          host: { select: { id: true, name: true } },
        },
      });

      return reply.send(
        meetings.map((m) => ({
          id: m.id,
          title: m.title,
          scheduledAt: m.scheduledAt,
          status: m.status,
          meetingLink: m.meetingLink,
          summary: m.summary,
          recordingUrl: m.recordingUrl,
          host: m.host,
        }))
      );
    }
  );

  // --- Issues list ---
  app.get(
    '/issues',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const clientIds = await getClientIdsForUser(request.user.id);
      if (clientIds.length === 0) {
        return reply.status(404).send({ message: 'No client account linked to this user' });
      }

      const query = request.query || {};
      const status = query.status; // optional: OPEN, IN_PROGRESS, RESOLVED
      const month = query.month != null ? Number(query.month) : null;
      const year = query.year != null ? Number(query.year) : null;

      const where = { clientId: { in: clientIds } };
      if (status && ['OPEN', 'IN_PROGRESS', 'RESOLVED'].includes(status)) {
        where.status = status;
      }
      if (month != null && year != null && !Number.isNaN(month) && !Number.isNaN(year)) {
        const start = new Date(Date.UTC(year, month - 1, 1));
        const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
        where.createdAt = { gte: start, lte: end };
      }

      const issues = await prisma.clientIssue.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          project: { select: { id: true, name: true } },
          _count: { select: { comments: true } },
        },
      });

      return reply.send(
        issues.map((i) => ({
          id: i.id,
          title: i.title,
          description: i.description,
          status: i.status,
          priority: i.priority,
          createdAt: i.createdAt,
          resolvedAt: i.resolvedAt,
          project: i.project,
          commentCount: i._count.comments,
        }))
      );
    }
  );

  // --- Create issue ---
  app.post(
    '/issues',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        body: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            projectId: { type: 'string', nullable: true },
            priority: { type: 'string' },
          },
          required: ['title', 'description'],
        },
      },
    },
    async (request, reply) => {
      try {
        const clientIds = await getClientIdsForUser(request.user.id);
        if (clientIds.length === 0) {
          return reply.status(404).send({ message: 'No client account linked to this user' });
        }

        const body = request.body ?? {};
        const parsed = createIssueBodySchema.safeParse(body);
        if (!parsed.success) {
          return reply.status(400).send({
            message: 'Validation failed',
            errors: parsed.error.flatten().fieldErrors,
          });
        }

        const { title, description, projectId, priority } = parsed.data;
        const clientId = clientIds[0];
        const projectIdToUse = projectId && projectId.trim() !== '' ? projectId.trim() : null;
        if (projectIdToUse) {
          const project = await prisma.project.findFirst({
            where: { id: projectIdToUse, clientId: { in: clientIds } },
          });
          if (!project) {
            return reply.status(400).send({ message: 'Project not found or not accessible' });
          }
        }

        const issue = await prisma.clientIssue.create({
          data: {
            clientId,
            projectId: projectIdToUse,
            reportedById: request.user.id,
            title,
            description,
            priority: priority || 'MEDIUM',
          },
        });

        // Notify PM and owners about the new issue
        try {
          const issueProject = projectIdToUse
            ? await prisma.project.findUnique({ where: { id: projectIdToUse }, select: { leadPmId: true } })
            : null;
          const owners = await prisma.user.findMany({ where: { role: 'OWNER', isActive: true }, select: { id: true } });
          const clientAccount = await prisma.clientAccount.findUnique({ where: { id: clientId }, select: { agencyName: true, leadPmId: true } });
          const issueRecipients = [
            issueProject?.leadPmId,
            clientAccount?.leadPmId,
            ...owners.map((o) => o.id),
          ].filter((id) => id && id !== request.user.id);
          if (issueRecipients.length > 0) {
            notify({
              slug: 'issue_created',
              recipientIds: issueRecipients,
              variables: {
                issueTitle: title,
                clientName: clientAccount?.agencyName || '',
                reportedBy: request.user.name || '',
              },
              actionUrl: `/portal/admin/issues`,
              metadata: { issueId: issue.id },
            }).catch(() => {});
          }
        } catch (_) { /* don't fail issue creation if notification fails */ }

        return reply.status(201).send(issue);
      } catch (err) {
        request.log.error({ err }, 'Create issue error');
        return reply.status(500).send({
          message: process.env.NODE_ENV === 'production' ? 'Failed to create issue' : err.message,
        });
      }
    }
  );

  // --- Upload issue attachment (returns URL for use in first comment) ---
  app.post(
    '/issues/attachment',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      try {
        const clientIds = await getClientIdsForUser(request.user.id);
        if (clientIds.length === 0) {
          return reply.status(404).send({ message: 'No client account linked to this user' });
        }
        const data = await request.file();
        if (!data) {
          return reply.status(400).send({ message: 'No file uploaded' });
        }
        await data.toBuffer(); // consume stream
        const filename = data.filename || 'attachment';
        // Return a stable URL reference; replace with real storage (e.g. S3) later
        const url = `https://client-uploads.localwaves.example/issues/${Date.now()}/${encodeURIComponent(filename)}`;
        return reply.send({ url });
      } catch (err) {
        request.log.error({ err }, 'Issue attachment upload error');
        return reply.status(500).send({
          message: process.env.NODE_ENV === 'production' ? 'Upload failed' : err.message,
        });
      }
    }
  );

  // --- Issue detail with comments ---
  app.get(
    '/issues/:id',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const clientIds = await getClientIdsForUser(request.user.id);
      if (clientIds.length === 0) {
        return reply.status(404).send({ message: 'No client account linked to this user' });
      }

      const issue = await prisma.clientIssue.findFirst({
        where: { id: request.params.id, clientId: { in: clientIds } },
        include: {
          project: { select: { id: true, name: true } },
          reportedBy: { select: { id: true, name: true } },
          comments: {
            orderBy: { createdAt: 'asc' },
            include: {
              author: { select: { id: true, name: true, role: true } },
            },
          },
        },
      });

      if (!issue) {
        return reply.status(404).send({ message: 'Issue not found' });
      }

      return reply.send({
        id: issue.id,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        priority: issue.priority,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        resolvedAt: issue.resolvedAt,
        project: issue.project,
        reportedBy: issue.reportedBy,
        comments: issue.comments.map((c) => ({
          id: c.id,
          body: c.body,
          attachmentUrl: c.attachmentUrl,
          createdAt: c.createdAt,
          author: c.author,
        })),
      });
    }
  );

  // --- Add comment ---
  app.post(
    '/issues/:id/comments',
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
            body: { type: 'string' },
            attachmentUrl: { type: 'string', nullable: true },
          },
          required: ['body'],
        },
      },
    },
    async (request, reply) => {
      const clientIds = await getClientIdsForUser(request.user.id);
      if (clientIds.length === 0) {
        return reply.status(404).send({ message: 'No client account linked to this user' });
      }

      const parsed = createCommentBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: 'Validation failed',
          errors: parsed.error.flatten().fieldErrors,
        });
      }

      const issue = await prisma.clientIssue.findFirst({
        where: { id: request.params.id, clientId: { in: clientIds } },
      });
      if (!issue) {
        return reply.status(404).send({ message: 'Issue not found' });
      }

      const comment = await prisma.issueComment.create({
        data: {
          issueId: issue.id,
          authorId: request.user.id,
          body: parsed.data.body,
          attachmentUrl: parsed.data.attachmentUrl || null,
        },
        include: {
          author: { select: { id: true, name: true, role: true } },
        },
      });

      // Notify PM and assignee about the client's comment
      const commentRecipients = [issue.assigneeId].filter((id) => id && id !== request.user.id);
      // Also try to notify the project lead PM
      if (issue.projectId) {
        try {
          const issueProject = await prisma.project.findUnique({ where: { id: issue.projectId }, select: { leadPmId: true } });
          if (issueProject?.leadPmId && issueProject.leadPmId !== request.user.id) {
            commentRecipients.push(issueProject.leadPmId);
          }
        } catch (_) {}
      }
      if (commentRecipients.length > 0) {
        notify({
          slug: 'issue_comment_added',
          recipientIds: commentRecipients,
          variables: { issueTitle: issue.title, authorName: request.user.name || 'Client' },
          actionUrl: `/portal/admin/issues`,
          metadata: { issueId: issue.id, commentId: comment.id },
        }).catch(() => {});
      }

      return reply.status(201).send({
        id: comment.id,
        body: comment.body,
        attachmentUrl: comment.attachmentUrl,
        createdAt: comment.createdAt,
        author: comment.author,
      });
    }
  );

  // --- Profile GET ---
  app.get(
    '/profile',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const userId = request.user.id;
      const clientUser = await prisma.clientUser.findFirst({
        where: { userId },
        include: { client: { select: { id: true, agencyName: true } } },
      });
      if (!clientUser) {
        return reply.status(404).send({ message: 'No client account linked to this user' });
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, phone: true, timezone: true, avatarUrl: true },
      });
      if (!user) {
        return reply.status(404).send({ message: 'User not found' });
      }

      return reply.send({
        ...user,
        jobTitle: clientUser.jobTitle,
        client: clientUser.client,
      });
    }
  );

  // --- Profile PATCH ---
  app.patch(
    '/profile',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        body: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            phone: { type: 'string', nullable: true },
            timezone: { type: 'string', nullable: true },
            jobTitle: { type: 'string', nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user.id;
      const parsed = patchProfileBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: 'Validation failed',
          errors: parsed.error.flatten().fieldErrors,
        });
      }

      const data = parsed.data;
      const updateUser = {};
      if (data.name !== undefined) updateUser.name = data.name;
      if (data.phone !== undefined) updateUser.phone = data.phone;
      if (data.timezone !== undefined) updateUser.timezone = data.timezone;

      if (Object.keys(updateUser).length > 0) {
        await prisma.user.update({
          where: { id: userId },
          data: updateUser,
        });
      }

      if (data.jobTitle !== undefined) {
        await prisma.clientUser.updateMany({
          where: { userId },
          data: { jobTitle: data.jobTitle },
        });
      }

      const clientUser = await prisma.clientUser.findFirst({
        where: { userId },
        include: { client: { select: { id: true, agencyName: true } } },
      });
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, phone: true, timezone: true, avatarUrl: true },
      });

      return reply.send({
        ...user,
        jobTitle: clientUser?.jobTitle ?? null,
        client: clientUser?.client ?? null,
      });
    }
  );
}
