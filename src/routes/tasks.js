import { prisma } from '../lib/prisma.js';
import { createTaskBodySchema, updateTaskStatusBodySchema } from '../schemas/tasks.js';
import jwt from 'jsonwebtoken';
import { generateChat, isAiConfigured } from '../lib/ai.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { notify } from '../lib/notificationService.js';
import { extractMentionedUserIds } from '../lib/mentionParser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UPLOADS_ROOT = join(__dirname, '..', '..', 'uploads');

function buildTaskWhere(user) {
  if (user.role === 'OWNER') {
    return {};
  }
  if (user.role === 'PM') {
    return {
      project: {
        OR: [
          { leadPmId: user.id },
          { client: { secondaryPmId: user.id } },
        ],
      },
    };
  }
  if (user.role === 'TEAM_MEMBER' || user.role === 'CONTRACTOR') {
    return { assignees: { some: { id: user.id } } };
  }
  return { id: 'never' };
}

export async function taskRoutes(app) {
  app.get(
    '/',
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
                projectId: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string', nullable: true },
                taskType: { type: 'string' },
                priority: { type: 'string' },
                dueDate: { type: 'string', nullable: true },
                status: { type: 'string' },
                project: { type: 'object' },
                assignees: { type: 'array', items: { type: 'object' } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;

      const where = buildTaskWhere(user);
      if (where.id === 'never') {
        return reply.status(403).send({ message: 'Forbidden' });
      }

      const tasks = await prisma.task.findMany({
        where: { ...where, parentTaskId: null },
        orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
        include: {
          project: {
            include: {
              client: { select: { id: true, agencyName: true } },
            },
          },
          assignees: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
          dependsOnTasks: {
            select: { id: true, status: true },
          },
          subTasks: {
            orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
            include: {
              assignees: { select: { id: true, name: true, email: true, avatarUrl: true } },
              dependsOnTasks: { select: { id: true, status: true } },
            },
          },
        },
      });

      return reply.send(tasks);
    }
  );

  // --- All attachments across tasks (for "Files" tab) ---
  app.get(
    '/attachments/all',
    { onRequest: [app.verifyJwt] },
    async (request, reply) => {
      const { user } = request;
      const where = buildTaskWhere(user);
      if (where.id === 'never') return reply.status(403).send({ message: 'Forbidden' });

      const attachments = await prisma.taskAttachment.findMany({
        where: { task: where },
        orderBy: { createdAt: 'desc' },
        include: {
          uploadedBy: { select: { id: true, name: true } },
          task: {
            select: {
              id: true,
              title: true,
              status: true,
              project: {
                select: {
                  id: true,
                  name: true,
                  client: { select: { id: true, agencyName: true } },
                },
              },
            },
          },
        },
      });

      return reply.send(
        attachments.map((a) => ({
          id: a.id,
          taskId: a.taskId,
          fileName: a.fileName,
          fileUrl: a.fileUrl,
          fileSize: a.fileSize,
          createdAt: a.createdAt.toISOString(),
          uploadedBy: a.uploadedBy,
          task: a.task,
        }))
      );
    }
  );

  app.post(
    '/',
    {
      onRequest: [app.verifyJwt],
      schema: {
        body: {
          type: 'object',
          properties: {
            projectId: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            description: { type: 'string' },
            taskType: { type: 'string' },
            priority: { type: 'string' },
            dueDate: { type: 'string' },
            assignedTo: { type: 'string', format: 'uuid' },
            assigneeIds: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
            },
          },
          required: ['projectId', 'title', 'taskType'],
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              projectId: { type: 'string' },
              title: { type: 'string' },
              status: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      if (user.role !== 'OWNER' && user.role !== 'PM') {
        return reply.status(403).send({ message: 'Only Owner or PM can create tasks' });
      }

      const parsed = createTaskBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: 'Validation failed',
          errors: parsed.error.flatten().fieldErrors,
        });
      }
      const { projectId, title, description, taskType, priority, dueDate, assignedTo, assigneeIds = [], dependencyIds = [], parentTaskId, milestone } =
        parsed.data;

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: { client: true },
      });
      if (!project) {
        return reply.status(400).send({ message: 'Project not found' });
      }

      if (user.role === 'PM') {
        const isAssigned =
          project.leadPmId === user.id ||
          project.client.secondaryPmId === user.id;
        if (!isAssigned) {
          return reply.status(403).send({ message: 'You are not assigned to this project' });
        }
      }

      const validDependencyIds = dependencyIds.length
        ? (await prisma.task.findMany({
            where: { id: { in: dependencyIds }, projectId },
            select: { id: true },
          })).map((t) => t.id)
        : [];

      if (parentTaskId) {
        const parent = await prisma.task.findFirst({
          where: { id: parentTaskId, projectId },
          select: { id: true },
        });
        if (!parent) {
          return reply.status(400).send({ message: 'Parent task not found or not in this project' });
        }
      }

      const assigneeIdList = Array.isArray(assigneeIds) && assigneeIds.length > 0
        ? assigneeIds
        : (assignedTo ? [assignedTo] : []);

      const task = await prisma.task.create({
        data: {
          projectId,
          title,
          description: description || null,
          taskType,
          priority: priority ?? 'MEDIUM',
          dueDate: dueDate ?? null,
          createdById: user.id,
          status: 'TO_DO',
          parentTaskId: parentTaskId || null,
          milestone: milestone ? String(milestone).slice(0, 100) : null,
          assignees: assigneeIdList.length
            ? { connect: assigneeIdList.map((id) => ({ id })) }
            : undefined,
          dependsOnTasks: validDependencyIds.length
            ? { connect: validDependencyIds.map((id) => ({ id })) }
            : undefined,
        },
      });

      // Log task_created activity
      await prisma.taskActivityLog.create({
        data: { taskId: task.id, actorId: user.id, action: 'task_created', detail: task.title },
      });

      // Notify assignees about new task
      if (assigneeIdList.length > 0) {
        notify({
          slug: 'task_created',
          recipientIds: assigneeIdList.filter((uid) => uid !== user.id),
          variables: { taskTitle: task.title, projectName: project.name || '', assignedBy: user.name || '' },
          actionUrl: `/portal/pm/projects/${projectId}`,
          metadata: { taskId: task.id, projectId },
        }).catch(() => {});
      }

      return reply.status(201).send(task);
    }
  );

  // POST /api/tasks/:id/wp-login — generate JIT WordPress login token (assignee or PM/OWNER)
  app.post(
    '/:id/wp-login',
    {
      onRequest: [app.verifyJwt],
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
              loginUrl: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id: taskId } = request.params;

      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: {
          project: {
            include: { client: { select: { secondaryPmId: true } } },
          },
          wpAccessPreset: { select: { id: true, capabilities: true } },
          assignees: { select: { id: true } },
        },
      });
      if (!task) {
        return reply.status(404).send({ message: 'Task not found' });
      }

      const isAssignee = task.assignees.some((a) => a.id === user.id);
      const project = task.project;
      const isPmOrOwner =
        user.role === 'OWNER' ||
        (user.role === 'PM' &&
          (project?.leadPmId === user.id || project?.client?.secondaryPmId === user.id));

      if (!isAssignee && !isPmOrOwner) {
        return reply.status(403).send({ message: 'You must be an assignee or PM/Owner to generate a WordPress login link' });
      }

      if (!task.wpAccessPreset) {
        return reply.status(400).send({ message: 'This task has no WordPress access preset configured' });
      }
      if (!project?.wpApiKey || !project?.wpUrl) {
        return reply.status(400).send({ message: 'Project WordPress URL and API key must be configured' });
      }

      const wpUrl = project.wpUrl.replace(/\/$/, '');
      const payload = {
        taskId: task.id,
        userId: user.id,
        userName: user.name,
        memberId: user.id,
        memberEmail: user.email,
        capabilities: task.wpAccessPreset.capabilities,
      };
      const token = jwt.sign(payload, project.wpApiKey, { expiresIn: '4h' });
      const loginUrl = `${wpUrl}/?agency_token=${token}`;

      return reply.send({ loginUrl });
    }
  );

  // POST /api/tasks/:id/auto-assign-wp-access — AI recommends and applies least-privilege WP preset (PM/OWNER only)
  app.post(
    '/:id/auto-assign-wp-access',
    {
      onRequest: [app.verifyJwt, app.requirePM],
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
              task: { type: 'object' },
              reasoning: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: taskId } = request.params;

      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: {
          project: { include: { client: { select: { secondaryPmId: true } } } },
        },
      });
      if (!task) {
        return reply.status(404).send({ message: 'Task not found' });
      }

      const project = task.project;
      const isPmOrOwner =
        request.user.role === 'OWNER' ||
        (request.user.role === 'PM' &&
          (project?.leadPmId === request.user.id || project?.client?.secondaryPmId === request.user.id));
      if (!isPmOrOwner) {
        return reply.status(403).send({ message: 'Only PM or Owner can auto-assign WP access' });
      }

      const presets = await prisma.wpAccessPreset.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, capabilities: true },
      });
      if (presets.length === 0) {
        return reply.status(400).send({ message: 'No WP Access Presets exist. Create presets in Admin first.' });
      }

      if (!isAiConfigured()) {
        return reply.status(503).send({ message: 'AI auto-assign is not configured. Set ANTHROPIC_API_KEY in your .env file.' });
      }

      const userMessage = `Task:
Title: ${task.title}
Description: ${task.description ?? '(none)'}
Task type: ${task.taskType}

Available presets (id, name, capabilities):
${presets.map((p) => `- id: ${p.id}, name: ${p.name}, capabilities: [${(p.capabilities || []).join(', ')}]`).join('\n')}

Return the id of the single most restrictive preset that still allows this task to be completed.`;

      const systemPrompt =
        'You are a WordPress Security Architect enforcing the principle of least privilege. Given a task description and available Access Presets, return the ID of the single most restrictive preset that allows the task to be completed. Reply only with valid JSON in this exact shape: { "recommendedPresetId": "<uuid>", "reasoning": "<short explanation>" }. recommendedPresetId must be one of the preset ids from the list.';

      try {
        const { text, parsed } = await generateChat({
          system: systemPrompt,
          user: userMessage,
          json: true,
          maxTokens: 512,
        });

        if (!text) {
          return reply.status(502).send({ message: 'Empty AI response' });
        }

        const parsedJson = parsed || (() => { try { return JSON.parse(text); } catch { return null; } })();
        const recommendedPresetId = typeof parsedJson?.recommendedPresetId === 'string' ? parsedJson.recommendedPresetId.trim() : null;
        const reasoning = typeof parsedJson?.reasoning === 'string' ? parsedJson.reasoning.trim() : 'No reasoning provided.';

        if (!recommendedPresetId) {
          return reply.status(502).send({ message: 'AI did not return a recommendedPresetId' });
        }

        const presetExists = presets.some((p) => p.id === recommendedPresetId);
        if (!presetExists) {
          return reply.status(400).send({ message: `AI recommended unknown preset id: ${recommendedPresetId}` });
        }

        const updated = await prisma.task.update({
          where: { id: taskId },
          data: { wpAccessPresetId: recommendedPresetId },
          include: {
            assignees: { select: { id: true, name: true, email: true, avatarUrl: true } },
            wpAccessPreset: { select: { id: true, name: true, capabilities: true } },
          },
        });

        return reply.send({
          task: updated,
          reasoning,
        });
      } catch (err) {
        request.log.error({ err }, 'Auto-assign WP access failed');
        return reply.status(502).send({
          message: err.message || 'AI auto-assign temporarily unavailable',
        });
      }
    }
  );

  app.patch(
    '/:id/status',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: { status: { type: 'string' } },
          required: ['status'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;

      const parsed = updateTaskStatusBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: 'Validation failed',
          errors: parsed.error.flatten().fieldErrors,
        });
      }
      const { status } = parsed.data;

      const task = await prisma.task.findUnique({
        where: { id },
        include: {
          project: { include: { client: true } },
          assignees: { select: { id: true } },
        },
      });
      if (!task) {
        return reply.status(404).send({ message: 'Task not found' });
      }

      const isAssignee = task.assignees.some((a) => a.id === user.id);
      const canUpdate =
        user.role === 'OWNER' ||
        (user.role === 'PM' &&
          (task.project.leadPmId === user.id ||
            task.project.client.secondaryPmId === user.id)) ||
        (isAssignee && (user.role === 'TEAM_MEMBER' || user.role === 'CONTRACTOR'));

      if (!canUpdate) {
        return reply.status(403).send({ message: 'You cannot update this task' });
      }

      const updated = await prisma.task.update({
        where: { id },
        data: { status },
      });

      await prisma.taskActivityLog.create({
        data: {
          taskId: id,
          actorId: user.id,
          action: 'status_change',
          detail: `changed status from ${task.status} to ${status}`,
        },
      });

      // Notify about status change
      const statusRecipients = [
        ...task.assignees.map((a) => a.id),
        task.project.leadPmId,
      ].filter((uid) => uid && uid !== user.id);

      if (status === 'COMPLETED') {
        notify({
          slug: 'task_completed',
          recipientIds: statusRecipients,
          variables: { taskTitle: task.title, projectName: task.project.name || '', completedBy: user.name || '' },
          actionUrl: `/portal/pm/projects/${task.projectId}`,
          metadata: { taskId: id },
        }).catch(() => {});
      } else {
        notify({
          slug: 'task_status_changed',
          recipientIds: statusRecipients,
          variables: { taskTitle: task.title, projectName: task.project.name || '', oldStatus: task.status, newStatus: status, changedBy: user.name || '' },
          actionUrl: `/portal/pm/projects/${task.projectId}`,
          metadata: { taskId: id },
        }).catch(() => {});
      }

      // Fire-and-forget: revoke WP sessions when task is completed
      if (status === 'COMPLETED') {
        const wpUrl = (task.project.wpUrl || '').trim().replace(/\/$/, '');
        const wpApiKey = (task.project.wpApiKey || '').trim();
        if (wpUrl && wpApiKey) {
          fetch(`${wpUrl}/wp-json/lwa/v1/sessions/revoke-by-task`, {
            method: 'POST',
            headers: {
              'X-LWA-API-Key': wpApiKey,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ task_id: id }),
            signal: AbortSignal.timeout(15000),
          }).catch((err) => {
            request.log.error({ err, taskId: id }, 'Failed to revoke WP sessions on task completion');
          });
        }
      }

      return reply.send({ id: updated.id, status: updated.status });
    }
  );

  app.patch(
    '/:id',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            assigneeIds: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
            },
            priority: { type: 'string' },
            title: { type: 'string' },
            dueDate: { type: 'string', nullable: true },
            wpAccessPresetId: { type: 'string', format: 'uuid', nullable: true },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              assignees: { type: 'array' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;
      const { assigneeIds, priority, title, dueDate, wpAccessPresetId } = request.body || {};

      const task = await prisma.task.findUnique({
        where: { id },
        include: {
          project: { include: { client: true } },
          assignees: { select: { id: true, name: true } },
        },
      });
      if (!task) {
        return reply.status(404).send({ message: 'Task not found' });
      }

      const isAssignee = task.assignees.some((a) => a.id === user.id);
      const canUpdate =
        user.role === 'OWNER' ||
        (user.role === 'PM' &&
          (task.project.leadPmId === user.id ||
            task.project.client.secondaryPmId === user.id)) ||
        (isAssignee && (user.role === 'TEAM_MEMBER' || user.role === 'CONTRACTOR'));

      if (!canUpdate) {
        return reply.status(403).send({ message: 'You cannot update this task' });
      }

      const idList = Array.isArray(assigneeIds) ? assigneeIds : null;
      const oldAssigneeIds = task.assignees.map((a) => a.id);
      const validPriority = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(priority) ? priority : undefined;
      const data = {};
      if (idList !== null) data.assignees = idList.length ? { set: idList.map((uid) => ({ id: uid })) } : { set: [] };
      if (validPriority) data.priority = validPriority;
      if (typeof title === 'string' && title.trim().length > 0) data.title = title.trim().slice(0, 500);
      if (dueDate !== undefined) {
        if (dueDate === null || dueDate === '') {
          data.dueDate = null;
        } else {
          const parsed = new Date(dueDate);
          if (isNaN(parsed.getTime())) {
            return reply.status(400).send({ error: 'Invalid dueDate format' });
          }
          data.dueDate = parsed;
        }
      }
      if (wpAccessPresetId !== undefined) data.wpAccessPresetId = wpAccessPresetId === null || wpAccessPresetId === '' ? null : wpAccessPresetId;
      const updated = await prisma.task.update({
        where: { id },
        data,
        include: {
          assignees: { select: { id: true, name: true, email: true, avatarUrl: true } },
          wpAccessPreset: { select: { id: true, name: true, capabilities: true } },
        },
      });

      // Log priority change
      if (validPriority && validPriority !== task.priority) {
        await prisma.taskActivityLog.create({
          data: { taskId: id, actorId: user.id, action: 'priority_changed', detail: `${task.priority} → ${validPriority}` },
        });
      }
      // Log due date change
      if (dueDate !== undefined) {
        const oldDate = task.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : 'none';
        const newDate = data.dueDate ? new Date(data.dueDate).toISOString().slice(0, 10) : 'none';
        if (oldDate !== newDate) {
          await prisma.taskActivityLog.create({
            data: { taskId: id, actorId: user.id, action: 'due_date_changed', detail: `${oldDate} → ${newDate}` },
          });
        }
      }
      // Log assignee changes
      if (idList !== null) {
        const added = idList.filter((uid) => !oldAssigneeIds.includes(uid));
        const removed = oldAssigneeIds.filter((uid) => !idList.includes(uid));
        for (const uid of added) {
          const u = updated.assignees.find((a) => a.id === uid);
          await prisma.taskActivityLog.create({
            data: { taskId: id, actorId: user.id, action: 'assigned', detail: u?.name || uid },
          });
        }
        for (const uid of removed) {
          const u = task.assignees.find((a) => a.id === uid);
          await prisma.taskActivityLog.create({
            data: { taskId: id, actorId: user.id, action: 'unassigned', detail: u?.name || uid },
          });
        }

        // Notify newly assigned users
        if (added.length > 0) {
          notify({
            slug: 'task_assigned',
            recipientIds: added,
            variables: { taskTitle: task.title, projectName: task.project?.name || '', assignedBy: user.name || '' },
            actionUrl: `/portal/pm/projects/${task.projectId}`,
            metadata: { taskId: id },
          }).catch(() => {});
        }
        // Notify removed users
        if (removed.length > 0) {
          notify({
            slug: 'task_unassigned',
            recipientIds: removed,
            variables: { taskTitle: task.title, projectName: task.project?.name || '', changedBy: user.name || '' },
            actionUrl: `/portal/pm/projects/${task.projectId}`,
            metadata: { taskId: id },
          }).catch(() => {});
        }
      }
      return reply.send({
        id: updated.id,
        assignees: updated.assignees,
        ...(validPriority && { priority: updated.priority }),
        ...(data.title !== undefined && { title: updated.title }),
        ...(data.dueDate !== undefined && { dueDate: updated.dueDate?.toISOString() ?? null }),
        ...(data.wpAccessPresetId !== undefined && {
          wpAccessPresetId: updated.wpAccessPresetId,
          wpAccessPreset: updated.wpAccessPreset,
        }),
      });
    }
  );

  app.post(
    '/:id/dependencies',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            dependencyIds: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
            },
          },
          required: ['dependencyIds'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              dependencyIds: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;
      const { dependencyIds } = request.body || {};

      if (!Array.isArray(dependencyIds)) {
        return reply.status(400).send({ message: 'dependencyIds must be an array' });
      }

      const task = await prisma.task.findUnique({
        where: { id },
        include: {
          project: { include: { client: true } },
          dependsOnTasks: { select: { id: true } },
        },
      });
      if (!task) {
        return reply.status(404).send({ message: 'Task not found' });
      }

      const canUpdate =
        user.role === 'OWNER' ||
        (user.role === 'PM' &&
          (task.project.leadPmId === user.id ||
            task.project.client.secondaryPmId === user.id));

      if (!canUpdate) {
        return reply.status(403).send({ message: 'Only Owner or PM can update task dependencies' });
      }

      const uniqueIds = [...new Set(dependencyIds)].filter((did) => did !== id);
      const existing = await prisma.task.findMany({
        where: { id: { in: uniqueIds }, projectId: task.projectId },
        select: { id: true },
      });
      const validIds = existing.map((t) => t.id);

      await prisma.task.update({
        where: { id },
        data: {
          dependsOnTasks: {
            set: validIds.map((tid) => ({ id: tid })),
          },
        },
      });

      return reply.send({ id, dependencyIds: validIds });
    }
  );

  app.post(
    '/:id/deliverables',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            fileUrl: { type: 'string' },
            notes: { type: 'string' },
          },
          required: ['fileUrl'],
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              version: { type: 'integer' },
              fileUrl: { type: 'string' },
              notes: { type: 'string', nullable: true },
              createdAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id: taskId } = request.params;
      const { fileUrl, notes } = request.body || {};
      const url = typeof fileUrl === 'string' ? fileUrl.trim() : '';
      if (!url) {
        return reply.status(400).send({ message: 'fileUrl is required' });
      }

      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: {
          project: { include: { client: true } },
          assignees: { select: { id: true } },
        },
      });
      if (!task) {
        return reply.status(404).send({ message: 'Task not found' });
      }

      const canUpload =
        user.role === 'OWNER' ||
        (user.role === 'PM' &&
          (task.project.leadPmId === user.id ||
            task.project.client.secondaryPmId === user.id)) ||
        ((user.role === 'TEAM_MEMBER' || user.role === 'CONTRACTOR') &&
          task.assignees?.some((a) => a.id === user.id));

      if (!canUpload) {
        return reply.status(403).send({ message: 'You must be assigned to this task or be the PM to upload deliverables' });
      }

      const deliverable = await prisma.$transaction(async (tx) => {
        const maxVersion = await tx.deliverableVersion.aggregate({
          where: { taskId },
          _max: { version: true },
        });
        const nextVersion = (maxVersion._max.version ?? 0) + 1;
        return tx.deliverableVersion.create({
          data: {
            taskId,
            version: nextVersion,
            fileUrl: url.slice(0, 500),
            notes: notes?.trim() || null,
            uploadedById: user.id,
          },
        });
      });

      // Notify PM about deliverable upload
      if (task.project.leadPmId && task.project.leadPmId !== user.id) {
        notify({
          slug: 'task_deliverable_uploaded',
          recipientIds: [task.project.leadPmId],
          variables: {
            taskTitle: task.title,
            projectName: task.project?.name || '',
            version: String(deliverable.version),
            uploadedBy: user.name || '',
          },
          actionUrl: `/portal/pm/projects/${task.projectId}`,
          metadata: { taskId, deliverableId: deliverable.id },
        }).catch(() => {});
      }

      return reply.status(201).send({
        id: deliverable.id,
        version: deliverable.version,
        fileUrl: deliverable.fileUrl,
        notes: deliverable.notes,
        createdAt: deliverable.createdAt.toISOString(),
      });
    }
  );

  // --- Task Comments ---
  app.get(
    '/:id/comments',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id: taskId } = request.params;

      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: {
          project: { include: { client: true } },
          assignees: { select: { id: true } },
        },
      });
      if (!task) {
        return reply.status(404).send({ message: 'Task not found' });
      }

      const canAccess =
        user.role === 'OWNER' ||
        (user.role === 'PM' &&
          (task.project.leadPmId === user.id ||
            task.project.client.secondaryPmId === user.id)) ||
        ((user.role === 'TEAM_MEMBER' || user.role === 'CONTRACTOR') &&
          task.assignees?.some((a) => a.id === user.id));

      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this task' });
      }

      const comments = await prisma.taskComment.findMany({
        where: { taskId },
        orderBy: { createdAt: 'asc' },
        include: {
          user: { select: { id: true, name: true, avatarUrl: true } },
          reactions: { include: { user: { select: { id: true, name: true } } } },
          parent: {
            select: {
              id: true,
              content: true,
              user: { select: { id: true, name: true } },
            },
          },
        },
      });

      const mapComment = (c) => {
        const reactionMap = {};
        (c.reactions || []).forEach((r) => {
          if (!reactionMap[r.emoji]) reactionMap[r.emoji] = { emoji: r.emoji, count: 0, users: [] };
          reactionMap[r.emoji].count++;
          reactionMap[r.emoji].users.push({ id: r.user.id, name: r.user.name });
        });
        return {
          id: c.id,
          taskId: c.taskId,
          userId: c.userId,
          parentId: c.parentId || null,
          content: c.content,
          createdAt: c.createdAt.toISOString(),
          editedAt: c.editedAt ? c.editedAt.toISOString() : null,
          user: c.user,
          reactions: Object.values(reactionMap),
          parent: c.parent ? { id: c.parent.id, content: c.parent.content, userName: c.parent.user.name } : null,
        };
      };

      return reply.send(comments.map(mapComment));
    }
  );

  app.post(
    '/:id/comments',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: { content: { type: 'string' }, parentId: { type: 'string', format: 'uuid' } },
          required: ['content'],
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id: taskId } = request.params;
      const { content, parentId } = request.body || {};
      const text = typeof content === 'string' ? content.trim() : '';
      if (!text) {
        return reply.status(400).send({ message: 'content is required' });
      }

      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: {
          project: { include: { client: true } },
          assignees: { select: { id: true } },
        },
      });
      if (!task) {
        return reply.status(404).send({ message: 'Task not found' });
      }

      const canAccess =
        user.role === 'OWNER' ||
        (user.role === 'PM' &&
          (task.project.leadPmId === user.id ||
            task.project.client.secondaryPmId === user.id)) ||
        ((user.role === 'TEAM_MEMBER' || user.role === 'CONTRACTOR') &&
          task.assignees?.some((a) => a.id === user.id));

      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this task' });
      }

      // Validate parentId if provided
      if (parentId) {
        const parentComment = await prisma.taskComment.findUnique({ where: { id: parentId } });
        if (!parentComment || parentComment.taskId !== taskId) {
          return reply.status(400).send({ message: 'Invalid parent comment' });
        }
      }

      const comment = await prisma.taskComment.create({
        data: {
          taskId,
          userId: user.id,
          parentId: parentId || null,
          content: text.slice(0, 10000),
        },
        include: {
          user: { select: { id: true, name: true, avatarUrl: true } },
          parent: {
            select: {
              id: true,
              content: true,
              user: { select: { id: true, name: true } },
            },
          },
        },
      });

      // Notify task assignees + PM (excl. author)
      const commentRecipients = [
        ...task.assignees.map((a) => a.id),
        task.project.leadPmId,
      ].filter((uid) => uid && uid !== user.id);
      notify({
        slug: 'task_comment_added',
        recipientIds: commentRecipients,
        variables: {
          taskTitle: task.title,
          projectName: task.project?.name || '',
          authorName: user.name || 'Someone',
          commentPreview: text.slice(0, 200),
        },
        actionUrl: `/portal/pm/projects/${task.projectId}`,
        metadata: { taskId, commentId: comment.id },
      }).catch(() => {});

      // Notify @mentioned users (separate "mentioned" notification)
      extractMentionedUserIds(text, user.id).then((mentionedIds) => {
        // Exclude users who already receive the task_comment_added notification
        const extraMentions = mentionedIds.filter((id) => !commentRecipients.includes(id));
        if (extraMentions.length > 0) {
          notify({
            slug: 'user_mentioned_in_task',
            recipientIds: extraMentions,
            variables: {
              taskTitle: task.title,
              projectName: task.project?.name || '',
              authorName: user.name || 'Someone',
              commentPreview: text.slice(0, 200),
            },
            actionUrl: `/portal/pm/projects/${task.projectId}`,
            metadata: { taskId, commentId: comment.id },
          }).catch(() => {});
        }
        // Also send mention-specific notification to those already in the recipient list
        const existingMentions = mentionedIds.filter((id) => commentRecipients.includes(id));
        if (existingMentions.length > 0) {
          notify({
            slug: 'user_mentioned_in_task',
            recipientIds: existingMentions,
            variables: {
              taskTitle: task.title,
              projectName: task.project?.name || '',
              authorName: user.name || 'Someone',
              commentPreview: text.slice(0, 200),
            },
            actionUrl: `/portal/pm/projects/${task.projectId}`,
            metadata: { taskId, commentId: comment.id },
          }).catch(() => {});
        }
      }).catch(() => {});

      return reply.status(201).send({
        id: comment.id,
        taskId: comment.taskId,
        userId: comment.userId,
        parentId: comment.parentId || null,
        content: comment.content,
        createdAt: comment.createdAt.toISOString(),
        editedAt: comment.editedAt ? comment.editedAt.toISOString() : null,
        user: comment.user,
        parent: comment.parent ? { id: comment.parent.id, content: comment.parent.content, userName: comment.parent.user.name } : null,
      });
    }
  );

  // PATCH /api/tasks/:taskId/comments/:commentId — edit own comment
  app.patch(
    '/:taskId/comments/:commentId',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: {
            taskId: { type: 'string', format: 'uuid' },
            commentId: { type: 'string', format: 'uuid' },
          },
          required: ['taskId', 'commentId'],
        },
        body: {
          type: 'object',
          properties: { content: { type: 'string' } },
          required: ['content'],
        },
      },
    },
    async (request, reply) => {
      const comment = await prisma.taskComment.findUnique({ where: { id: request.params.commentId } });
      if (!comment || comment.taskId !== request.params.taskId) return reply.status(404).send({ message: 'Comment not found' });
      if (comment.userId !== request.user.id) return reply.status(403).send({ message: 'You can only edit your own comments' });
      const content = request.body?.content?.trim();
      if (!content) return reply.status(400).send({ message: 'Content is required' });
      const updated = await prisma.taskComment.update({
        where: { id: comment.id },
        data: { content, editedAt: new Date() },
        include: { user: { select: { id: true, name: true, avatarUrl: true } } },
      });
      return reply.send({ id: updated.id, taskId: updated.taskId, userId: updated.userId, content: updated.content, createdAt: updated.createdAt.toISOString(), editedAt: updated.editedAt ? updated.editedAt.toISOString() : null, user: updated.user });
    }
  );

  // DELETE /api/tasks/:taskId/comments/:commentId — delete own comment
  app.delete(
    '/:taskId/comments/:commentId',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: {
            taskId: { type: 'string', format: 'uuid' },
            commentId: { type: 'string', format: 'uuid' },
          },
          required: ['taskId', 'commentId'],
        },
      },
    },
    async (request, reply) => {
      const comment = await prisma.taskComment.findUnique({ where: { id: request.params.commentId } });
      if (!comment || comment.taskId !== request.params.taskId) return reply.status(404).send({ message: 'Comment not found' });
      if (comment.userId !== request.user.id) return reply.status(403).send({ message: 'You can only delete your own comments' });
      // Extract [img:url] markers and delete matching attachments + files
      const imgRe = /\[img:([^\]]+)\]/g;
      let match;
      const imageUrls = [];
      while ((match = imgRe.exec(comment.content)) !== null) { imageUrls.push(match[1]); }
      if (imageUrls.length > 0) {
        const attachments = await prisma.taskAttachment.findMany({ where: { taskId: request.params.taskId, fileUrl: { in: imageUrls } } });
        for (const att of attachments) {
          // Extract relative path from URL and delete file
          try {
            const urlPath = new URL(att.fileUrl).pathname; // e.g. /uploads/2026/04-08/uuid-file.png
            if (urlPath.startsWith('/uploads/')) {
              const filePath = join(UPLOADS_ROOT, urlPath.replace('/uploads/', ''));
              unlinkSync(filePath);
            }
          } catch { /* file may not exist */ }
        }
        await prisma.taskAttachment.deleteMany({ where: { id: { in: attachments.map(a => a.id) } } });
      }
      await prisma.taskComment.delete({ where: { id: comment.id } });
      await prisma.taskActivityLog.create({
        data: {
          taskId: request.params.taskId,
          actorId: request.user.id,
          action: 'comment_deleted',
        },
      });
      return reply.status(204).send();
    }
  );

  // --- Task Activity Logs ---
  app.get(
    '/:id/activity-logs',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                action: { type: 'string' },
                detail: { type: 'string', nullable: true },
                createdAt: { type: 'string' },
                actor: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id: taskId } = request.params;

      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: {
          project: { include: { client: true } },
          assignees: { select: { id: true } },
        },
      });
      if (!task) return reply.status(404).send({ message: 'Task not found' });

      const canAccess =
        user.role === 'OWNER' ||
        (user.role === 'PM' &&
          (task.project.leadPmId === user.id ||
            task.project.client.secondaryPmId === user.id)) ||
        ((user.role === 'TEAM_MEMBER' || user.role === 'CONTRACTOR') &&
          task.assignees?.some((a) => a.id === user.id));

      if (!canAccess) return reply.status(403).send({ message: 'You do not have access to this task' });

      const logs = await prisma.taskActivityLog.findMany({
        where: { taskId },
        orderBy: { createdAt: 'asc' },
        include: { actor: { select: { id: true, name: true } } },
      });

      return reply.send(
        logs.map((l) => ({
          id: l.id,
          action: l.action,
          detail: l.detail || null,
          createdAt: l.createdAt.toISOString(),
          actor: l.actor,
        }))
      );
    }
  );

  // DELETE /api/tasks/:id — delete a task (PM or OWNER only)
  app.delete(
    '/:id',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: { 200: { type: 'object', properties: {} } },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;

      const task = await prisma.task.findUnique({
        where: { id },
        include: { project: { select: { leadPmId: true, client: { select: { secondaryPmId: true } } } } },
      });

      if (!task) {
        return reply.status(404).send({ message: 'Task not found' });
      }

      const isOwner = user.role === 'OWNER';
      const isPMLead =
        user.role === 'PM' &&
        (task.project.leadPmId === user.id || task.project.client?.secondaryPmId === user.id);

      if (!isOwner && !isPMLead) {
        return reply.status(403).send({ message: 'Only the project PM or an Owner can delete tasks' });
      }

      const subtaskCount = await prisma.task.count({ where: { parentTaskId: id } });
      if (subtaskCount > 0 && !request.query.force) {
        return reply.status(409).send({
          error: `Task has ${subtaskCount} subtask(s). Pass ?force=true to confirm deletion.`,
          subtaskCount,
        });
      }

      await prisma.taskComment.deleteMany({ where: { taskId: id } });
      await prisma.taskAttachment.deleteMany({ where: { taskId: id } });
      await prisma.deliverableVersion.deleteMany({ where: { taskId: id } });
      await prisma.task.updateMany({ where: { parentTaskId: id }, data: { parentTaskId: null } });
      await prisma.task.delete({ where: { id } });

      return reply.send({});
    }
  );

  // --- Task Attachments ---
  app.get(
    '/:id/attachments',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id: taskId } = request.params;
      const task = await prisma.task.findUnique({ where: { id: taskId }, include: { project: { include: { client: true } }, assignees: { select: { id: true } } } });
      if (!task) return reply.status(404).send({ message: 'Task not found' });
      const canAccess = user.role === 'OWNER' || (user.role === 'PM' && (task.project.leadPmId === user.id || task.project.client.secondaryPmId === user.id)) || ((user.role === 'TEAM_MEMBER' || user.role === 'CONTRACTOR') && task.assignees?.some((a) => a.id === user.id));
      if (!canAccess) return reply.status(403).send({ message: 'Access denied' });
      const attachments = await prisma.taskAttachment.findMany({ where: { taskId }, orderBy: { createdAt: 'desc' }, include: { uploadedBy: { select: { id: true, name: true } } } });
      return reply.send(attachments.map((a) => ({ id: a.id, taskId: a.taskId, fileName: a.fileName, fileUrl: a.fileUrl, fileSize: a.fileSize, createdAt: a.createdAt.toISOString(), uploadedBy: a.uploadedBy })));
    }
  );

  app.post(
    '/:id/attachments',
    { onRequest: [app.verifyJwt] },
    async (request, reply) => {
      const { user } = request;
      const { id: taskId } = request.params;
      const task = await prisma.task.findUnique({ where: { id: taskId }, include: { project: { include: { client: true } }, assignees: { select: { id: true } } } });
      if (!task) return reply.status(404).send({ message: 'Task not found' });
      const canAccess = user.role === 'OWNER' || (user.role === 'PM' && (task.project.leadPmId === user.id || task.project.client.secondaryPmId === user.id)) || ((user.role === 'TEAM_MEMBER' || user.role === 'CONTRACTOR') && task.assignees?.some((a) => a.id === user.id));
      if (!canAccess) return reply.status(403).send({ message: 'Access denied' });
      const data = await request.file();
      if (!data) return reply.status(400).send({ message: 'No file uploaded' });
      const buffer = await data.toBuffer();
      const fileName = data.filename || 'attachment';
      const fileSize = buffer.length;
      // Save to uploads/YYYY/MM-DD/{uuid}-{filename}
      const now = new Date();
      const year = String(now.getFullYear());
      const monthDay = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const dir = join(UPLOADS_ROOT, year, monthDay);
      mkdirSync(dir, { recursive: true });
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storedName = `${randomUUID()}-${safeName}`;
      writeFileSync(join(dir, storedName), buffer);
      const baseUrl = `${request.protocol}://${request.host}`;
      const fileUrl = `${baseUrl}/uploads/${year}/${monthDay}/${storedName}`;
      const attachment = await prisma.taskAttachment.create({ data: { taskId, uploadedById: user.id, fileName, fileUrl, fileSize }, include: { uploadedBy: { select: { id: true, name: true } } } });
      await prisma.taskActivityLog.create({ data: { taskId, actorId: user.id, action: 'attachment_added', detail: fileName } });
      return reply.status(201).send({ id: attachment.id, taskId: attachment.taskId, fileName: attachment.fileName, fileUrl: attachment.fileUrl, fileSize: attachment.fileSize, createdAt: attachment.createdAt.toISOString(), uploadedBy: attachment.uploadedBy });
    }
  );

  app.delete(
    '/:taskId/attachments/:attachmentId',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: { type: 'object', properties: { taskId: { type: 'string', format: 'uuid' }, attachmentId: { type: 'string', format: 'uuid' } }, required: ['taskId', 'attachmentId'] },
      },
    },
    async (request, reply) => {
      const attachment = await prisma.taskAttachment.findUnique({ where: { id: request.params.attachmentId } });
      if (!attachment || attachment.taskId !== request.params.taskId) return reply.status(404).send({ message: 'Attachment not found' });
      const isOwnerOrPm = request.user.role === 'OWNER' || request.user.role === 'PM';
      if (attachment.uploadedById !== request.user.id && !isOwnerOrPm) return reply.status(403).send({ message: 'You can only delete your own attachments' });
      await prisma.taskAttachment.delete({ where: { id: attachment.id } });
      await prisma.taskActivityLog.create({ data: { taskId: request.params.taskId, actorId: request.user.id, action: 'attachment_removed', detail: attachment.fileName } });
      return reply.status(204).send();
    }
  );

  // --- Comment Reactions ---
  app.post(
    '/:taskId/comments/:commentId/reactions',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: { type: 'object', properties: { taskId: { type: 'string', format: 'uuid' }, commentId: { type: 'string', format: 'uuid' } }, required: ['taskId', 'commentId'] },
        body: { type: 'object', properties: { emoji: { type: 'string' } }, required: ['emoji'] },
      },
    },
    async (request, reply) => {
      const { commentId } = request.params;
      const { emoji } = request.body;
      if (!emoji || emoji.length > 20) return reply.status(400).send({ message: 'Invalid emoji' });
      const comment = await prisma.taskComment.findUnique({ where: { id: commentId } });
      if (!comment || comment.taskId !== request.params.taskId) return reply.status(404).send({ message: 'Comment not found' });
      const existing = await prisma.taskCommentReaction.findUnique({ where: { commentId_userId_emoji: { commentId, userId: request.user.id, emoji } } });
      if (existing) return reply.send({ id: existing.id, emoji: existing.emoji, userId: existing.userId });
      const reaction = await prisma.taskCommentReaction.create({ data: { commentId, userId: request.user.id, emoji } });
      return reply.status(201).send({ id: reaction.id, emoji: reaction.emoji, userId: reaction.userId });
    }
  );

  app.delete(
    '/:taskId/comments/:commentId/reactions/:emoji',
    {
      onRequest: [app.verifyJwt],
      schema: {
        params: { type: 'object', properties: { taskId: { type: 'string', format: 'uuid' }, commentId: { type: 'string', format: 'uuid' }, emoji: { type: 'string' } }, required: ['taskId', 'commentId', 'emoji'] },
      },
    },
    async (request, reply) => {
      const { commentId, emoji } = request.params;
      const existing = await prisma.taskCommentReaction.findUnique({ where: { commentId_userId_emoji: { commentId, userId: request.user.id, emoji } } });
      if (!existing) return reply.status(404).send({ message: 'Reaction not found' });
      await prisma.taskCommentReaction.delete({ where: { id: existing.id } });
      return reply.status(204).send();
    }
  );

  // --- Client Input Requests ---

  // GET /api/tasks/:id/input-requests — fetch all input request records for a task
  app.get(
    '/:id/input-requests',
    { onRequest: [app.verifyJwt] },
    async (request, reply) => {
      const { id: taskId } = request.params;
      const task = await prisma.task.findUnique({ where: { id: taskId }, include: { project: { include: { client: true } }, assignees: { select: { id: true } } } });
      if (!task) return reply.status(404).send({ message: 'Task not found' });
      const { user } = request;
      const canAccess = user.role === 'OWNER' || (user.role === 'PM' && (task.project.leadPmId === user.id || task.project.client.secondaryPmId === user.id)) || ((user.role === 'TEAM_MEMBER' || user.role === 'CONTRACTOR') && task.assignees?.some((a) => a.id === user.id));
      if (!canAccess) return reply.status(403).send({ message: 'Access denied' });
      const requests = await prisma.clientInputRequest.findMany({
        where: { taskId },
        orderBy: { requestedAt: 'asc' },
        include: {
          requestedBy: { select: { id: true, name: true, avatarUrl: true } },
          respondedBy: { select: { id: true, name: true, avatarUrl: true } },
        },
      });
      return reply.send(requests.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        requestNote: r.requestNote,
        status: r.status,
        responseText: r.responseText,
        requestedAt: r.requestedAt.toISOString(),
        respondedAt: r.respondedAt ? r.respondedAt.toISOString() : null,
        requestedBy: r.requestedBy,
        respondedBy: r.respondedBy,
      })));
    }
  );

  // PATCH /api/tasks/:id/input-requests/:requestId/cancel — PM cancels a pending request
  app.patch(
    '/:id/input-requests/:requestId/cancel',
    { onRequest: [app.verifyJwt] },
    async (request, reply) => {
      const { user } = request;
      if (user.role !== 'OWNER' && user.role !== 'PM') return reply.status(403).send({ message: 'Only PM or Owner can cancel requests' });
      const { id: taskId, requestId } = request.params;
      const inputReq = await prisma.clientInputRequest.findUnique({ where: { id: requestId } });
      if (!inputReq || inputReq.taskId !== taskId) return reply.status(404).send({ message: 'Input request not found' });
      if (inputReq.status !== 'PENDING') return reply.status(400).send({ message: 'Only pending requests can be cancelled' });
      await prisma.clientInputRequest.update({ where: { id: requestId }, data: { status: 'CANCELLED' } });
      // Check if any other PENDING requests remain
      const pendingCount = await prisma.clientInputRequest.count({ where: { taskId, status: 'PENDING' } });
      if (pendingCount === 0) {
        await prisma.task.update({ where: { id: taskId }, data: { requiresClientInput: false } });
      }
      await prisma.taskActivityLog.create({ data: { taskId, actorId: user.id, action: 'client_input_cancelled' } });
      return reply.send({ success: true });
    }
  );
}
