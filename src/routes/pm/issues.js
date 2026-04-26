import { prisma } from '../../lib/prisma.js';
import jwt from 'jsonwebtoken';
import { notify } from '../../lib/notificationService.js';
import { extractMentionedUserIds } from '../../lib/mentionParser.js';

const PM_OR_TEAM_ROLES = ['PM', 'OWNER', 'TEAM_MEMBER', 'CONTRACTOR'];

async function requirePmOrTeam(request, reply) {
  if (!PM_OR_TEAM_ROLES.includes(request.user?.role)) {
    return reply.status(403).send({ message: 'Access required' });
  }
}

/** For PM: client IDs where user is lead or secondary PM. For OWNER: all. For TEAM_MEMBER/CONTRACTOR: by assigneeId. */
async function getListWhere(user) {
  if (user.role === 'OWNER') return {};
  if (user.role === 'PM') {
    const clients = await prisma.clientAccount.findMany({
      where: {
        OR: [{ leadPmId: user.id }, { secondaryPmId: user.id }],
      },
      select: { id: true },
    });
    const clientIds = clients.map((c) => c.id);
    if (clientIds.length === 0) return null;
    return { clientId: { in: clientIds } };
  }
  if (user.role === 'TEAM_MEMBER' || user.role === 'CONTRACTOR') {
    return { assigneeId: user.id };
  }
  return null;
}

function canAccessIssue(issue, user) {
  if (user.role === 'PM' || user.role === 'OWNER') return true;
  if (user.role === 'TEAM_MEMBER' || user.role === 'CONTRACTOR') return issue.assigneeId === user.id;
  return false;
}

/** Valid status transitions per role */
const PM_TRANSITIONS = {
  OPEN: ['IN_PROGRESS', 'RESOLVED'],
  IN_PROGRESS: ['RESOLVED'],
  PENDING_REVIEW: ['IN_PROGRESS', 'RESOLVED'], // send back or resolve
  RESOLVED: ['OPEN'], // reopen
};
const TEAM_TRANSITIONS = {
  OPEN: ['IN_PROGRESS'],
  IN_PROGRESS: ['PENDING_REVIEW'],
  PENDING_REVIEW: [],
  RESOLVED: [],
};

function isValidTransition(fromStatus, toStatus, isPmOrOwner) {
  const map = isPmOrOwner ? PM_TRANSITIONS : TEAM_TRANSITIONS;
  const allowed = map[fromStatus] || [];
  return allowed.includes(toStatus);
}

function sortIssuesOpenFirst(issues) {
  const order = { OPEN: 0, PENDING_REVIEW: 1, IN_PROGRESS: 2, RESOLVED: 3 };
  return [...issues].sort((a, b) => {
    const na = order[a.status] ?? 2;
    const nb = order[b.status] ?? 2;
    if (na !== nb) return na - nb;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

export async function pmIssueRoutes(app) {
  // GET /api/pm/issues — list issues (PM/OWNER: by client; TEAM_MEMBER/CONTRACTOR: assigned only)
  app.get(
    '/issues',
    { onRequest: [app.verifyJwt, requirePmOrTeam] },
    async (request, reply) => {
      try {
        const where = await getListWhere(request.user);
        if (where === null) return reply.send([]);
        const issues = await prisma.clientIssue.findMany({
          where,
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
          include: {
            client: { select: { id: true, agencyName: true } },
            reportedBy: { select: { id: true, name: true } },
            assignee: { select: { id: true, name: true } },
            wpAccessPreset: { select: { id: true, name: true, capabilities: true } },
          },
        });
        const sorted = sortIssuesOpenFirst(issues);
        return reply.send(
          sorted.map((i) => ({
            id: i.id,
            title: i.title,
            status: i.status,
            priority: i.priority,
            createdAt: i.createdAt,
            client: i.client,
            reportedBy: i.reportedBy,
            assignee: i.assignee ? { id: i.assignee.id, name: i.assignee.name } : null,
            wpAccessPresetId: i.wpAccessPresetId || null,
            wpAccessPreset: i.wpAccessPreset || null,
          }))
        );
      } catch (err) {
        request.log.error({ err }, 'GET /pm/issues error');
        return reply.status(500).send({ message: err.message || 'Failed to load issues' });
      }
    }
  );

  // GET /api/pm/issues/:id — detail with comments
  app.get(
    '/issues/:id',
    {
      onRequest: [app.verifyJwt, requirePmOrTeam],
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      },
    },
    async (request, reply) => {
      const issue = await prisma.clientIssue.findUnique({
        where: { id: request.params.id },
        include: {
          client: { select: { id: true, agencyName: true } },
          project: { select: { id: true, name: true, wpUrl: true, wpApiKey: true } },
          reportedBy: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true } },
          wpAccessPreset: { select: { id: true, name: true, capabilities: true } },
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
      if (!issue || !canAccessIssue(issue, request.user)) {
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
        client: issue.client,
        project: issue.project ? { id: issue.project.id, name: issue.project.name } : null,
        reportedBy: issue.reportedBy,
        assignee: issue.assignee ? { id: issue.assignee.id, name: issue.assignee.name } : null,
        wpAccessPresetId: issue.wpAccessPresetId || null,
        wpAccessPreset: issue.wpAccessPreset || null,
        hasWpConfig: !!(issue.project?.wpUrl && issue.project?.wpApiKey),
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

  // POST /api/pm/issues/:id/comments
  app.post(
    '/issues/:id/comments',
    {
      onRequest: [app.verifyJwt, requirePmOrTeam],
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
      if (!issue || !canAccessIssue(issue, request.user)) {
        return reply.status(404).send({ message: 'Issue not found' });
      }
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

      // Notify issue reporter and assignee about the comment
      const commentRecipients = [issue.reportedById, issue.assigneeId].filter((id) => id && id !== request.user.id);
      if (commentRecipients.length > 0) {
        notify({
          slug: 'issue_comment_added',
          recipientIds: commentRecipients,
          variables: { issueTitle: issue.title, authorName: request.user.name || 'Team' },
          actionUrl: `/portal/pm/support`,
          metadata: { issueId: issue.id, commentId: comment.id },
        }).catch(() => {});
      }

      // Notify @mentioned users in issue comment
      extractMentionedUserIds(body, request.user.id).then((mentionedIds) => {
        const extraMentions = mentionedIds.filter((id) => !commentRecipients.includes(id));
        if (extraMentions.length > 0) {
          notify({
            slug: 'user_mentioned_in_issue',
            recipientIds: extraMentions,
            variables: { issueTitle: issue.title, authorName: request.user.name || 'Team', commentPreview: body.slice(0, 200) },
            actionUrl: `/portal/pm/support`,
            metadata: { issueId: issue.id, commentId: comment.id },
          }).catch(() => {});
        }
        const existingMentions = mentionedIds.filter((id) => commentRecipients.includes(id));
        if (existingMentions.length > 0) {
          notify({
            slug: 'user_mentioned_in_issue',
            recipientIds: existingMentions,
            variables: { issueTitle: issue.title, authorName: request.user.name || 'Team', commentPreview: body.slice(0, 200) },
            actionUrl: `/portal/pm/support`,
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

  // PATCH /api/pm/issues/:issueId/comments/:commentId — edit own comment
  app.patch(
    '/issues/:issueId/comments/:commentId',
    {
      onRequest: [app.verifyJwt, requirePmOrTeam],
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

  // DELETE /api/pm/issues/:issueId/comments/:commentId — delete own comment
  app.delete(
    '/issues/:issueId/comments/:commentId',
    {
      onRequest: [app.verifyJwt, requirePmOrTeam],
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

  // PATCH /api/pm/issues/:id — status and/or assigneeId (assigneeId only for PM/OWNER)
  app.patch(
    '/issues/:id',
    {
      onRequest: [app.verifyJwt, requirePmOrTeam],
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['OPEN', 'IN_PROGRESS', 'PENDING_REVIEW', 'RESOLVED'] },
            assigneeId: { type: 'string', format: 'uuid', nullable: true },
            wpAccessPresetId: { type: 'string', format: 'uuid', nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const issue = await prisma.clientIssue.findUnique({
        where: { id: request.params.id },
        include: { assignee: { select: { id: true, name: true } } },
      });
      if (!issue || !canAccessIssue(issue, request.user)) {
        return reply.status(404).send({ message: 'Issue not found' });
      }
      const { status, assigneeId, wpAccessPresetId } = request.body || {};
      const data = {};
      const isPmOrOwner = request.user.role === 'PM' || request.user.role === 'OWNER';
      const activityPromises = [];

      // wpAccessPresetId — PM/OWNER only
      if (wpAccessPresetId !== undefined && isPmOrOwner) {
        data.wpAccessPresetId = wpAccessPresetId === null || wpAccessPresetId === '' ? null : wpAccessPresetId;
      }

      if (status !== undefined && status !== issue.status) {
        if (!isValidTransition(issue.status, status, isPmOrOwner)) {
          return reply.status(400).send({
            message: `Cannot transition from ${issue.status} to ${status}`,
          });
        }
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
      if (assigneeId !== undefined && isPmOrOwner) {
        if (assigneeId === null || assigneeId === '') {
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
          data.assigneeId = null;
        } else {
          const userExists = await prisma.user.findUnique({
            where: { id: assigneeId },
            select: { id: true, name: true },
          });
          if (!userExists) return reply.status(400).send({ message: 'Assignee user not found' });
          if (assigneeId !== issue.assigneeId) {
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
                  detail: userExists.name,
                },
              })
            );
          }
          data.assigneeId = assigneeId;
        }
      }
      if (Object.keys(data).length === 0) {
        const current = await prisma.clientIssue.findUnique({
          where: { id: issue.id },
          include: { assignee: { select: { id: true, name: true } } },
        });
        return reply.send({
          id: current.id,
          status: current.status,
          assignee: current.assignee ? { id: current.assignee.id, name: current.assignee.name } : null,
        });
      }
      const [updated] = await Promise.all([
        prisma.clientIssue.update({
          where: { id: issue.id },
          data,
          include: {
            assignee: { select: { id: true, name: true } },
            wpAccessPreset: { select: { id: true, name: true, capabilities: true } },
          },
        }),
        ...activityPromises,
      ]);

      // Notify about status changes
      if (status !== undefined && status !== issue.status) {
        const statusRecipients = [issue.reportedById, issue.assigneeId].filter((id) => id && id !== request.user.id);
        if (status === 'RESOLVED') {
          notify({
            slug: 'issue_resolved',
            recipientIds: statusRecipients,
            variables: { issueTitle: issue.title, changedBy: request.user.name || 'Team' },
            actionUrl: `/portal/pm/support`,
            metadata: { issueId: issue.id },
          }).catch(() => {});
        } else {
          notify({
            slug: 'issue_status_changed',
            recipientIds: statusRecipients,
            variables: { issueTitle: issue.title, oldStatus: issue.status, newStatus: status, changedBy: request.user.name || 'Team' },
            actionUrl: `/portal/pm/support`,
            metadata: { issueId: issue.id },
          }).catch(() => {});
        }
      }

      // Notify about assignment changes
      if (assigneeId !== undefined && assigneeId && assigneeId !== issue.assigneeId) {
        notify({
          slug: 'issue_assigned',
          recipientIds: [assigneeId],
          variables: { issueTitle: issue.title, clientName: '', assignedBy: request.user.name || 'Team' },
          actionUrl: `/portal/pm/support`,
          metadata: { issueId: issue.id },
        }).catch(() => {});
      }

      return reply.send({
        id: updated.id,
        status: updated.status,
        assignee: updated.assignee ? { id: updated.assignee.id, name: updated.assignee.name } : null,
        wpAccessPresetId: updated.wpAccessPresetId || null,
        wpAccessPreset: updated.wpAccessPreset || null,
      });
    }
  );

  // POST /api/pm/issues/:id/wp-login — generate JIT WordPress login for issue (assignee or PM/OWNER)
  app.post(
    '/issues/:id/wp-login',
    {
      onRequest: [app.verifyJwt, requirePmOrTeam],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: { loginUrl: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id: issueId } = request.params;

      const issue = await prisma.clientIssue.findUnique({
        where: { id: issueId },
        include: {
          project: {
            include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
          },
          wpAccessPreset: { select: { id: true, capabilities: true } },
        },
      });
      if (!issue) {
        return reply.status(404).send({ message: 'Issue not found' });
      }

      const isAssignee = issue.assigneeId === user.id;
      const project = issue.project;
      const isPmOrOwner =
        user.role === 'OWNER' ||
        (user.role === 'PM' &&
          (project?.leadPmId === user.id || project?.client?.leadPmId === user.id || project?.client?.secondaryPmId === user.id));

      if (!isAssignee && !isPmOrOwner) {
        return reply.status(403).send({ message: 'You must be the assignee or PM/Owner to generate a WordPress login link' });
      }

      if (!issue.wpAccessPreset) {
        return reply.status(400).send({ message: 'This issue has no WordPress access preset configured' });
      }
      if (!project?.wpApiKey || !project?.wpUrl) {
        return reply.status(400).send({ message: 'Project WordPress URL and API key must be configured' });
      }

      const wpUrl = project.wpUrl.replace(/\/$/, '');
      const payload = {
        issueId: issue.id,
        userId: user.id,
        userName: user.name,
        memberId: user.id,
        memberEmail: user.email,
        capabilities: issue.wpAccessPreset.capabilities,
      };
      const token = jwt.sign(payload, project.wpApiKey, { expiresIn: '4h' });
      const loginUrl = `${wpUrl}/?agency_token=${token}`;

      return reply.send({ loginUrl });
    }
  );
}
