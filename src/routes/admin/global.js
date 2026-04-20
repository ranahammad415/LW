import { prisma } from '../../lib/prisma.js';
import { createMeetingBodySchema } from '../../schemas/admin.js';
import { notify } from '../../lib/notificationService.js';
import { extractMentionedUserIds } from '../../lib/mentionParser.js';

const ACTIVE_TASK_STATUSES = ['IN_PROGRESS', 'TO_DO', 'NEEDS_REVIEW'];
const TEAM_ROLES = ['PM', 'TEAM_MEMBER', 'CONTRACTOR'];

export async function adminGlobalRoutes(app) {
  // GET /api/admin/projects/all
  app.get(
    '/projects/all',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      const page = Math.max(1, parseInt(request.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit) || 50));
      const skip = (page - 1) * limit;

      const [projects, total] = await Promise.all([
        prisma.project.findMany({
          orderBy: { updatedAt: 'desc' },
          include: {
            client: { select: { id: true, agencyName: true } },
            leadPm: { select: { id: true, name: true } },
            tasks: { select: { id: true, status: true } },
          },
          skip,
          take: limit,
        }),
        prisma.project.count(),
      ]);

      const data = projects.map((p) => {
        const totalTasks = p.tasks.length;
        const completed = p.tasks.filter((t) => t.status === 'COMPLETED').length;
        const progress = totalTasks > 0 ? Math.round((completed / totalTasks) * 100) : 0;
        return {
          id: p.id,
          name: p.name,
          projectType: p.projectType,
          status: p.status,
          client: p.client,
          leadPm: p.leadPm,
          progress,
          taskCount: totalTasks,
          completedCount: completed,
        };
      });

      return reply.send({ data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    }
  );

  // GET /api/admin/tasks/all
  app.get(
    '/tasks/all',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      const page = Math.max(1, parseInt(request.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit) || 50));
      const skip = (page - 1) * limit;

      const [tasks, total] = await Promise.all([
        prisma.task.findMany({
          orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
          include: {
            project: {
              include: {
                client: { select: { id: true, agencyName: true } },
              },
            },
            assignees: { select: { id: true, name: true, avatarUrl: true } },
          },
          skip,
          take: limit,
        }),
        prisma.task.count(),
      ]);

      return reply.send({
        data: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          taskType: t.taskType,
          status: t.status,
          priority: t.priority,
          dueDate: t.dueDate,
          client: t.project?.client ?? null,
          projectName: t.project?.name ?? null,
          assignees: t.assignees,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    }
  );

  // GET /api/admin/issues/all — OPEN first, then by createdAt desc
  app.get(
    '/issues/all',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      const page = Math.max(1, parseInt(request.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit) || 50));
      const skip = (page - 1) * limit;

      const [issues, total] = await Promise.all([
        prisma.clientIssue.findMany({
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
          include: {
            client: { select: { id: true, agencyName: true } },
            reportedBy: { select: { id: true, name: true } },
            assignee: { select: { id: true, name: true } },
          },
          skip,
          take: limit,
        }),
        prisma.clientIssue.count(),
      ]);

      // Sort so OPEN comes first (Prisma orderBy status asc puts OPEN after IN_PROGRESS alphabetically; we want OPEN first)
      const sorted = [...issues].sort((a, b) => {
        if (a.status === 'OPEN' && b.status !== 'OPEN') return -1;
        if (a.status !== 'OPEN' && b.status === 'OPEN') return 1;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

      return reply.send({
        data: sorted.map((i) => ({
          id: i.id,
          title: i.title,
          status: i.status,
          priority: i.priority,
          createdAt: i.createdAt,
          client: i.client,
          reportedBy: i.reportedBy,
          assignee: i.assignee ? { id: i.assignee.id, name: i.assignee.name } : null,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    }
  );

  // GET /api/admin/issues/:id — issue detail with comments (owner)
  app.get(
    '/issues/:id',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      },
    },
    async (request, reply) => {
      const issue = await prisma.clientIssue.findUnique({
        where: { id: request.params.id },
        include: {
          client: { select: { id: true, agencyName: true } },
          project: { select: { id: true, name: true } },
          reportedBy: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true } },
          comments: {
            orderBy: { createdAt: 'asc' },
            include: { author: { select: { id: true, name: true, role: true } } },
          },
          activityLogs: {
            orderBy: { createdAt: 'asc' },
            include: { actor: { select: { id: true, name: true } } },
          },
        },
      });
      if (!issue) return reply.status(404).send({ message: 'Issue not found' });
      return reply.send({
        id: issue.id,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        priority: issue.priority,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        resolvedAt: issue.resolvedAt,
        client: issue.client,
        project: issue.project,
        reportedBy: issue.reportedBy,
        assignee: issue.assignee ? { id: issue.assignee.id, name: issue.assignee.name } : null,
        comments: issue.comments.map((c) => ({
          id: c.id,
          body: c.body,
          attachmentUrl: c.attachmentUrl,
          createdAt: c.createdAt,
          editedAt: c.editedAt,
          author: c.author,
        })),
        activityLogs: issue.activityLogs.map((a) => ({
          id: a.id,
          action: a.action,
          detail: a.detail,
          createdAt: a.createdAt,
          actor: a.actor,
        })),
      });
    }
  );

  // POST /api/admin/issues/:id/comments — owner adds comment
  app.post(
    '/issues/:id/comments',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: { body: { type: 'string' }, attachmentUrl: { type: 'string', nullable: true } },
          required: ['body'],
        },
      },
    },
    async (request, reply) => {
      const issue = await prisma.clientIssue.findUnique({ where: { id: request.params.id } });
      if (!issue) return reply.status(404).send({ message: 'Issue not found' });
      const body = request.body?.body?.trim();
      if (!body) return reply.status(400).send({ message: 'Comment body is required' });
      const comment = await prisma.issueComment.create({
        data: {
          issueId: issue.id,
          authorId: request.user.id,
          body,
          attachmentUrl: request.body?.attachmentUrl?.trim() || null,
        },
        include: { author: { select: { id: true, name: true, role: true } } },
      });

      // Notify issue participants (excl. author)
      const recipients = [issue.reportedById];
      if (issue.assigneeId) recipients.push(issue.assigneeId);
      const filteredRecipients = recipients.filter((r) => r !== request.user.id);
      notify({
        slug: 'issue_comment_added',
        recipientIds: filteredRecipients,
        variables: { issueTitle: issue.title, authorName: request.user.name || 'Admin' },
        actionUrl: `/portal/admin/issues`,
        metadata: { issueId: issue.id, commentId: comment.id },
      }).catch(() => {});

      // Notify @mentioned users in admin issue comment
      extractMentionedUserIds(body, request.user.id).then((mentionedIds) => {
        const extraMentions = mentionedIds.filter((id) => !filteredRecipients.includes(id));
        if (extraMentions.length > 0) {
          notify({
            slug: 'user_mentioned_in_issue',
            recipientIds: extraMentions,
            variables: { issueTitle: issue.title, authorName: request.user.name || 'Admin', commentPreview: body.slice(0, 200) },
            actionUrl: `/portal/admin/issues`,
            metadata: { issueId: issue.id, commentId: comment.id },
          }).catch(() => {});
        }
        const existingMentions = mentionedIds.filter((id) => filteredRecipients.includes(id));
        if (existingMentions.length > 0) {
          notify({
            slug: 'user_mentioned_in_issue',
            recipientIds: existingMentions,
            variables: { issueTitle: issue.title, authorName: request.user.name || 'Admin', commentPreview: body.slice(0, 200) },
            actionUrl: `/portal/admin/issues`,
            metadata: { issueId: issue.id, commentId: comment.id },
          }).catch(() => {});
        }
      }).catch(() => {});

      return reply.status(201).send({
        id: comment.id,
        body: comment.body,
        attachmentUrl: comment.attachmentUrl,
        createdAt: comment.createdAt,
        editedAt: comment.editedAt,
        author: comment.author,
      });
    }
  );

  // PATCH /api/admin/issues/:issueId/comments/:commentId — edit own comment
  app.patch(
    '/issues/:issueId/comments/:commentId',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        params: {
          type: 'object',
          properties: {
            issueId: { type: 'string', format: 'uuid' },
            commentId: { type: 'string', format: 'uuid' },
          },
          required: ['issueId', 'commentId'],
        },
        body: {
          type: 'object',
          properties: { body: { type: 'string' } },
          required: ['body'],
        },
      },
    },
    async (request, reply) => {
      const comment = await prisma.issueComment.findUnique({ where: { id: request.params.commentId } });
      if (!comment || comment.issueId !== request.params.issueId) return reply.status(404).send({ message: 'Comment not found' });
      if (comment.authorId !== request.user.id) return reply.status(403).send({ message: 'You can only edit your own comments' });
      const body = request.body?.body?.trim();
      if (!body) return reply.status(400).send({ message: 'Comment body is required' });
      const updated = await prisma.issueComment.update({
        where: { id: comment.id },
        data: { body, editedAt: new Date() },
        include: { author: { select: { id: true, name: true, role: true } } },
      });
      return reply.send({ id: updated.id, body: updated.body, attachmentUrl: updated.attachmentUrl, createdAt: updated.createdAt, editedAt: updated.editedAt, author: updated.author });
    }
  );

  // DELETE /api/admin/issues/:issueId/comments/:commentId — delete own comment
  app.delete(
    '/issues/:issueId/comments/:commentId',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        params: {
          type: 'object',
          properties: {
            issueId: { type: 'string', format: 'uuid' },
            commentId: { type: 'string', format: 'uuid' },
          },
          required: ['issueId', 'commentId'],
        },
      },
    },
    async (request, reply) => {
      const comment = await prisma.issueComment.findUnique({ where: { id: request.params.commentId } });
      if (!comment || comment.issueId !== request.params.issueId) return reply.status(404).send({ message: 'Comment not found' });
      if (comment.authorId !== request.user.id) return reply.status(403).send({ message: 'You can only delete your own comments' });
      await prisma.issueActivityLog.create({
        data: {
          issueId: comment.issueId,
          actorId: request.user.id,
          action: 'comment_deleted',
          detail: `${request.user.name} deleted a comment`,
        },
      });
      await prisma.issueComment.delete({ where: { id: comment.id } });
      return reply.status(204).send();
    }
  );

  // PATCH /api/admin/issues/:id — owner updates status (e.g. IN_PROGRESS, RESOLVED) and/or assignee
  app.patch(
    '/issues/:id',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['OPEN', 'IN_PROGRESS', 'PENDING_REVIEW', 'RESOLVED'] },
            assigneeId: { type: 'string', format: 'uuid', nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const issue = await prisma.clientIssue.findUnique({
        where: { id: request.params.id },
        include: { assignee: { select: { id: true, name: true } } },
      });
      if (!issue) return reply.status(404).send({ message: 'Issue not found' });
      const { status, assigneeId } = request.body || {};
      const data = {};
      const activityPromises = [];
      if (status !== undefined && status !== issue.status) {
        data.status = status;
        data.resolvedAt = status === 'RESOLVED' ? new Date() : null;
        activityPromises.push(
          prisma.issueActivityLog.create({
            data: {
              issueId: issue.id,
              actorId: request.user.id,
              action: 'status_change',
              detail: `Changed status from ${issue.status} to ${status}`,
            },
          })
        );
      }
      if (assigneeId !== undefined) {
        data.assigneeId = assigneeId === null || assigneeId === '' ? null : assigneeId;
        if (data.assigneeId) {
          const u = await prisma.user.findUnique({ where: { id: data.assigneeId }, select: { id: true, name: true } });
          if (!u) return reply.status(400).send({ message: 'Assignee not found' });
          if (data.assigneeId !== issue.assigneeId) {
            if (issue.assignee) {
              activityPromises.push(
                prisma.issueActivityLog.create({
                  data: {
                    issueId: issue.id,
                    actorId: request.user.id,
                    action: 'unassigned',
                    detail: issue.assignee.name,
                  },
                })
              );
            }
            activityPromises.push(
              prisma.issueActivityLog.create({
                data: {
                  issueId: issue.id,
                  actorId: request.user.id,
                  action: 'assigned',
                  detail: u.name,
                },
              })
            );
          }
        } else if (issue.assignee) {
          activityPromises.push(
            prisma.issueActivityLog.create({
              data: {
                issueId: issue.id,
                actorId: request.user.id,
                action: 'unassigned',
                detail: issue.assignee.name,
              },
            })
          );
        }
      }
      if (Object.keys(data).length === 0) return reply.send({ id: issue.id, status: issue.status });
      const [updated] = await Promise.all([
        prisma.clientIssue.update({
          where: { id: issue.id },
          data,
          include: { assignee: { select: { id: true, name: true } } },
        }),
        ...activityPromises,
      ]);

      // Notification: issue status changed
      if (status !== undefined && status !== issue.status) {
        const recipients = [issue.reportedById];
        if (issue.assigneeId) recipients.push(issue.assigneeId);
        notify({
          slug: status === 'RESOLVED' ? 'issue_resolved' : 'issue_status_changed',
          recipientIds: recipients.filter((r) => r !== request.user.id),
          variables: { issueTitle: issue.title, oldStatus: issue.status, newStatus: status, changedBy: request.user.name || 'Admin' },
          actionUrl: `/portal/admin/issues`,
          metadata: { issueId: issue.id },
        }).catch(() => {});
      }

      // Notification: issue assigned
      if (assigneeId && assigneeId !== issue.assigneeId) {
        notify({
          slug: 'issue_assigned',
          recipientIds: [assigneeId],
          variables: { issueTitle: issue.title, clientName: '', assignedBy: request.user.name || 'Admin' },
          actionUrl: `/portal/admin/issues`,
          metadata: { issueId: issue.id },
        }).catch(() => {});
      }

      return reply.send({
        id: updated.id,
        status: updated.status,
        assignee: updated.assignee ? { id: updated.assignee.id, name: updated.assignee.name } : null,
      });
    }
  );

  // GET /api/admin/meetings/all
  app.get(
    '/meetings/all',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      const meetings = await prisma.meetingRecord.findMany({
        orderBy: { scheduledAt: 'desc' },
        include: {
          client: { select: { id: true, agencyName: true } },
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
          client: m.client,
          host: m.host,
        }))
      );
    }
  );

  // POST /api/admin/meetings — owner schedules a meeting for a client
  app.post(
    '/meetings',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      const parsed = createMeetingBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: 'Validation failed',
          errors: parsed.error.flatten().fieldErrors,
        });
      }
      const data = parsed.data;

      const client = await prisma.clientAccount.findUnique({
        where: { id: data.clientId },
        select: { id: true, agencyName: true },
      });
      if (!client) {
        return reply.status(400).send({ message: 'Client not found' });
      }

      const host = await prisma.user.findUnique({
        where: { id: data.hostId },
        select: { id: true, name: true },
      });
      if (!host) {
        return reply.status(400).send({ message: 'Host user not found' });
      }

      const scheduledAt = new Date(data.scheduledAt);
      if (Number.isNaN(scheduledAt.getTime())) {
        return reply.status(400).send({ message: 'Invalid scheduledAt date' });
      }

      const meeting = await prisma.meetingRecord.create({
        data: {
          clientId: data.clientId,
          hostId: data.hostId,
          title: data.title.trim(),
          scheduledAt,
          status: (data.status && data.status.trim()) || 'UPCOMING',
          meetingLink: data.meetingLink && data.meetingLink.trim() !== '' ? data.meetingLink.trim() : null,
          summary: data.summary && data.summary.trim() !== '' ? data.summary.trim() : null,
        },
        include: {
          client: { select: { id: true, agencyName: true } },
          host: { select: { id: true, name: true } },
        },
      });

      // Notify client users and host about the meeting
      try {
        const meetingClientUsers = await prisma.clientUser.findMany({
          where: { clientId: data.clientId },
          select: { userId: true },
        });
        const meetingRecipients = [data.hostId, ...meetingClientUsers.map((cu) => cu.userId)].filter((id) => id && id !== request.user.id);
        if (meetingRecipients.length > 0) {
          notify({
            slug: 'meeting_scheduled',
            recipientIds: meetingRecipients,
            variables: {
              meetingTitle: data.title.trim(),
              scheduledAt: scheduledAt.toISOString(),
              meetingLink: (data.meetingLink && data.meetingLink.trim()) || '',
            },
            actionUrl: `/portal/client/meetings`,
            metadata: { meetingId: meeting.id },
          }).catch(() => {});
        }
      } catch (_) { /* don't fail meeting creation if notification fails */ }

      return reply.status(201).send({
        id: meeting.id,
        title: meeting.title,
        scheduledAt: meeting.scheduledAt,
        status: meeting.status,
        client: meeting.client,
        host: meeting.host,
      });
    }
  );

  // GET /api/admin/team/workload
  app.get(
    '/team/workload',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      const users = await prisma.user.findMany({
        where: { role: { in: TEAM_ROLES }, isActive: true },
        select: { id: true, name: true, role: true, avatarUrl: true },
      });

      // GET /api/admin/team/workload — count active tasks per user (multi-assignee)
      const tasksWithAssignees = await prisma.task.findMany({
        where: { status: { in: ACTIVE_TASK_STATUSES } },
        select: {
          assignees: { select: { id: true } },
        },
      });

      const countByUser = {};
      for (const task of tasksWithAssignees) {
        for (const a of task.assignees) {
          countByUser[a.id] = (countByUser[a.id] ?? 0) + 1;
        }
      }

      const result = users.map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role,
        avatarUrl: u.avatarUrl,
        activeTaskCount: countByUser[u.id] ?? 0,
      }));

      return reply.send(result);
    }
  );
}
