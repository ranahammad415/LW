import { prisma } from '../../lib/prisma.js';
import { ensureProjectAccess } from '../../lib/ensureProjectAccess.js';
import { notify } from '../../lib/notificationService.js';
import { generateChat, isAiConfigured, sanitizeUserInputForPrompt } from '../../lib/ai.js';

const PRIORITIZE_SYSTEM = `You are a Senior Digital Agency PM. Given a list of open tasks and optional PM goals, rank them by business impact for the client this week. Consider deadlines, dependencies, blocking issues, and client input readiness. Be decisive — do not rank everything "high". Return strictly valid JSON: { "ranked": [ { "taskId": "<uuid>", "rank": <1-based integer>, "priority": "CRITICAL|HIGH|MEDIUM|LOW", "rationale": "<one short sentence>" } ] }. Only include tasks from the provided list. Do not invent tasks.`;

export async function pmTasksRoutes(app) {
  app.get(
    '/team',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                email: { type: 'string' },
                avatarUrl: { type: 'string', nullable: true },
                role: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const users = await prisma.user.findMany({
        where: {
          role: { in: ['TEAM_MEMBER', 'CONTRACTOR', 'PM'] },
          isActive: true,
        },
        select: { id: true, name: true, email: true, avatarUrl: true, role: true },
        orderBy: { name: 'asc' },
      });
      return reply.send(users);
    }
  );

  app.patch(
    '/tasks/:id/request-client',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            clientRequestNote: { type: 'string' },
          },
          required: ['clientRequestNote'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              requiresClientInput: { type: 'boolean' },
              clientRequestNote: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;
      const { clientRequestNote } = request.body || {};

      const note = typeof clientRequestNote === 'string' ? clientRequestNote.trim() : '';
      if (!note) {
        return reply.status(400).send({ message: 'clientRequestNote is required' });
      }

      const task = await prisma.task.findUnique({
        where: { id },
        include: {
          project: {
            include: { client: { select: { id: true, agencyName: true } } },
          },
        },
      });

      if (!task) {
        return reply.status(404).send({ message: 'Task not found' });
      }

      const canAccess = await ensureProjectAccess(task.project, user);
      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      const updated = await prisma.task.update({
        where: { id },
        data: {
          requiresClientInput: true,
          clientRequestNote: note.slice(0, 10000),
          clientProvidedInput: false,
        },
      });

      // Create a ClientInputRequest record for history
      const inputRequest = await prisma.clientInputRequest.create({
        data: {
          taskId: id,
          requestedById: user.id,
          requestNote: note.slice(0, 10000),
          status: 'PENDING',
        },
        include: {
          requestedBy: { select: { id: true, name: true, avatarUrl: true } },
        },
      });

      // Activity log
      await prisma.taskActivityLog.create({
        data: { taskId: id, actorId: user.id, action: 'client_input_requested', detail: note.slice(0, 200) },
      });

      const clientUserLinks = await prisma.clientUser.findMany({
        where: { clientId: task.project.clientId },
        select: { userId: true },
      });
      
      notify({
        slug: 'client_input_requested',
        recipientIds: clientUserLinks.map(({ userId }) => userId),
        variables: {
          taskTitle: task.title,
          projectName: task.project?.name || '',
          requestNote: note.slice(0, 200),
        },
        actionUrl: '/portal/client',
        metadata: { taskId: id },
      }).catch(() => {});

      return reply.send({
        id: updated.id,
        requiresClientInput: updated.requiresClientInput,
        clientRequestNote: updated.clientRequestNote,
      });
    }
  );

  // POST /pm/projects/:id/prioritize-tasks — AI ranks open tasks by impact.
  app.post(
    '/projects/:id/prioritize-tasks',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            goals: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params;
      const rawGoals = request.body?.goals ? String(request.body.goals) : '';
      const goals = sanitizeUserInputForPrompt(rawGoals, 2000);

      if (!isAiConfigured()) {
        return reply.status(503).send({ message: 'AI prioritization is not configured. Set ANTHROPIC_API_KEY.' });
      }

      const project = await prisma.project.findUnique({
        where: { id },
        include: {
          client: { select: { id: true, agencyName: true } },
        },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      const canAccess = await ensureProjectAccess(project, user);
      if (!canAccess) return reply.status(403).send({ message: 'You do not have access to this project' });

      const openTasks = await prisma.task.findMany({
        where: {
          projectId: id,
          status: { in: ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'REVIEW'] },
        },
        select: {
          id: true,
          title: true,
          description: true,
          taskType: true,
          priority: true,
          status: true,
          dueDate: true,
          requiresClientInput: true,
          clientProvidedInput: true,
        },
        orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
        take: 50,
      });

      if (openTasks.length === 0) {
        return reply.send({ ranked: [] });
      }

      const taskBlock = openTasks
        .map((t) => {
          const due = t.dueDate ? `due ${new Date(t.dueDate).toISOString().slice(0, 10)}` : 'no due date';
          const waiting = t.requiresClientInput && !t.clientProvidedInput ? ' WAITING_ON_CLIENT' : '';
          const desc = (t.description || '').replace(/\s+/g, ' ').slice(0, 200);
          return `- id=${t.id} | ${t.taskType} | ${t.priority} | ${t.status} | ${due}${waiting} | ${t.title} | ${desc}`;
        })
        .join('\n');

      const userMessage = `Client: ${project.client.agencyName}
Project: ${project.name} (${project.projectType})
${goals ? `\nPM goals this week:\n${goals}\n` : ''}
Open tasks (${openTasks.length}):
${taskBlock}

Rank these tasks from highest to lowest weekly impact. Assign a priority (CRITICAL|HIGH|MEDIUM|LOW) and a one-sentence rationale per task.`;

      try {
        const { text, parsed } = await generateChat({
          system: PRIORITIZE_SYSTEM,
          user: userMessage,
          json: true,
          maxTokens: 2048,
          temperature: 0.2,
          feature: 'prioritize_tasks',
          userId: user.id,
          clientId: project.clientId,
        });

        const parsedJson = parsed || (() => { try { return JSON.parse(text); } catch { return null; } })();
        const ranked = Array.isArray(parsedJson?.ranked) ? parsedJson.ranked : [];
        const validIds = new Set(openTasks.map((t) => t.id));
        const allowedPriorities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
        const normalized = ranked
          .filter((r) => r && typeof r.taskId === 'string' && validIds.has(r.taskId))
          .map((r, idx) => ({
            taskId: r.taskId,
            rank: Number.isFinite(r.rank) ? Number(r.rank) : idx + 1,
            priority: allowedPriorities.includes(r.priority) ? r.priority : 'MEDIUM',
            rationale: String(r.rationale || '').slice(0, 500),
          }))
          .sort((a, b) => a.rank - b.rank);

        return reply.send({ ranked: normalized });
      } catch (err) {
        request.log.error({ err }, 'AI prioritize-tasks failed');
        return reply.status(502).send({ message: err.message || 'AI prioritization temporarily unavailable' });
      }
    }
  );
}
