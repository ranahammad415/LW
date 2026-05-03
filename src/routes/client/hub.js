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

// Display metadata for notification categories (ordered). Only categories in
// this map are exposed to clients; any template belonging to an unknown
// category is ignored by the client-facing preferences API.
const CATEGORY_LABELS = {
  task:         { label: 'Task updates',            description: 'Assignments, status changes, comments, deliverables' },
  pipeline:     { label: 'Content approvals',       description: 'Content submitted, approved, changes requested, published' },
  client_input: { label: 'Requests for your input', description: 'PM requests, asset uploads, keyword suggestions from your team' },
  issue:        { label: 'Support issues',          description: 'Issue updates, comments, resolutions' },
  keyword:      { label: 'Keyword research',        description: 'Approvals, rejections, suggested edits' },
  project:      { label: 'Project announcements',   description: 'New projects created for your account' },
  meeting:      { label: 'Meetings',                description: 'Meeting invitations and scheduling' },
  report:       { label: 'Reports',                 description: 'Monthly reports published to your portal' },
  client:       { label: 'Account activity',        description: 'Welcome emails, password resets, team member changes' },
  standup:      { label: 'Team standups',           description: 'Daily standup updates' },
};

const patchNotificationPreferencesBodySchema = z.object({
  categories: z.record(z.string(), z.boolean()),
});

async function buildClientNotificationPreferences(userId) {
  const [templates, prefs] = await Promise.all([
    prisma.notificationTemplate.findMany({
      where: { isActive: true },
      select: { slug: true, category: true },
    }),
    prisma.notificationPreference.findMany({
      where: { userId },
      select: { templateSlug: true, emailEnabled: true },
    }),
  ]);

  const prefBySlug = new Map(prefs.map((p) => [p.templateSlug, p.emailEnabled]));

  // Bucket templates by category (only known categories).
  const byCategory = new Map();
  for (const t of templates) {
    if (!CATEGORY_LABELS[t.category]) continue;
    if (!byCategory.has(t.category)) byCategory.set(t.category, []);
    byCategory.get(t.category).push(t.slug);
  }

  const categories = [];
  for (const [key, meta] of Object.entries(CATEGORY_LABELS)) {
    const slugs = byCategory.get(key) || [];
    if (slugs.length === 0) continue;
    // Category enabled only when every template in it has email !== false
    // (missing preference row defaults to true).
    const emailEnabled = slugs.every((slug) => prefBySlug.get(slug) !== false);
    categories.push({
      category: key,
      label: meta.label,
      description: meta.description,
      emailEnabled,
      templateCount: slugs.length,
    });
  }

  return { categories };
}

export async function clientHubRoutes(app) {
  // --- Meetings ---
  app.get(
    '/meetings',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;

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
      const clientIds = request.clientAccountIds;

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
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
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
        const clientIds = request.clientAccountIds;

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

        // Notify other client users about the issue
        try {
          const otherUsers = await prisma.clientUser.findMany({
            where: { clientId, userId: { not: request.user.id } },
            select: { userId: true },
          });
          if (otherUsers.length > 0) {
            const clientAccount = await prisma.clientAccount.findUnique({ where: { id: clientId }, select: { agencyName: true } });
            notify({
              slug: 'client_issue_created_team',
              recipientIds: otherUsers.map((cu) => cu.userId),
              variables: { reporterName: request.user.name || 'A team member', issueTitle: title, clientName: clientAccount?.agencyName || '' },
              actionUrl: '/portal/client/issues',
              metadata: { issueId: issue.id },
            }).catch(() => {});
          }
          await prisma.clientActivityLog.create({
            data: { clientId, userId: request.user.id, action: 'issue_created', detail: `Reported issue: "${title}"`, metadata: { issueId: issue.id } },
          });
        } catch (_) {}

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
    { onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter] },
    async (request, reply) => {
      try {
        const clientIds = request.clientAccountIds;
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
      const clientIds = request.clientAccountIds;

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
            body: { type: 'string' },
            attachmentUrl: { type: 'string', nullable: true },
          },
          required: ['body'],
        },
      },
    },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;

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

  // --- Notification preferences GET ---
  app.get(
    '/notification-preferences',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const payload = await buildClientNotificationPreferences(request.user.id);
      return reply.send(payload);
    }
  );

  // --- Notification preferences PATCH ---
  app.patch(
    '/notification-preferences',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        body: {
          type: 'object',
          required: ['categories'],
          properties: {
            categories: {
              type: 'object',
              additionalProperties: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = patchNotificationPreferencesBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: 'Validation failed',
          errors: parsed.error.flatten().fieldErrors,
        });
      }

      const { categories } = parsed.data;
      const categoryKeys = Object.keys(categories);

      // Reject unknown category keys.
      const unknown = categoryKeys.filter((k) => !CATEGORY_LABELS[k]);
      if (unknown.length > 0) {
        return reply.status(400).send({
          message: `Unknown notification categories: ${unknown.join(', ')}`,
        });
      }

      if (categoryKeys.length === 0) {
        const payload = await buildClientNotificationPreferences(request.user.id);
        return reply.send(payload);
      }

      // Fetch all active templates in the affected categories.
      const templates = await prisma.notificationTemplate.findMany({
        where: { isActive: true, category: { in: categoryKeys } },
        select: { slug: true, category: true },
      });

      const userId = request.user.id;
      const ops = templates.map((t) =>
        prisma.notificationPreference.upsert({
          where: { userId_templateSlug: { userId, templateSlug: t.slug } },
          create: {
            userId,
            templateSlug: t.slug,
            emailEnabled: categories[t.category],
            inAppEnabled: true,
          },
          // Only touch emailEnabled on update; preserve existing inAppEnabled.
          update: { emailEnabled: categories[t.category] },
        })
      );

      if (ops.length > 0) {
        await prisma.$transaction(ops);
      }

      const payload = await buildClientNotificationPreferences(userId);
      return reply.send(payload);
    }
  );

  // --- Team members ---
  app.get(
    '/team',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;
      const userId = request.user.id;

      const clientUsers = await prisma.clientUser.findMany({
        where: { clientId: { in: clientIds } },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              avatarUrl: true,
              email: true,
              lastLoginAt: true,
            },
          },
        },
        orderBy: { addedAt: 'asc' },
      });

      return reply.send(clientUsers.map((cu) => ({
        id: cu.id,
        userId: cu.user.id,
        name: cu.user.name,
        avatarUrl: cu.user.avatarUrl,
        email: cu.user.email,
        jobTitle: cu.jobTitle,
        role: cu.role,
        isPrimaryContact: cu.isPrimaryContact,
        isYou: cu.user.id === userId,
        lastLoginAt: cu.user.lastLoginAt,
      })));
    }
  );

  // --- Current user's client role ---
  app.get(
    '/me/role',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const primary = request.clientUserRoles?.[0] || null;
      return reply.send({
        role: primary?.role || 'VIEWER',
        isPrimaryContact: !!primary?.isPrimaryContact,
        clientId: primary?.clientId || request.clientAccountIds?.[0] || null,
      });
    }
  );

  // --- Activity feed ---
  app.get(
    '/activity',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;
      const query = request.query || {};
      const limit = Math.min(Number(query.limit) || 30, 100);
      const offset = Number(query.offset) || 0;
      const action = query.action || null;

      const where = { clientId: { in: clientIds } };
      if (action) where.action = action;

      const [activities, total] = await Promise.all([
        prisma.clientActivityLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        }),
        prisma.clientActivityLog.count({ where }),
      ]);

      return reply.send({
        activities: activities.map((a) => ({
          id: a.id,
          action: a.action,
          detail: a.detail,
          metadata: a.metadata,
          user: a.user,
          createdAt: a.createdAt,
        })),
        total,
      });
    }
  );
}
