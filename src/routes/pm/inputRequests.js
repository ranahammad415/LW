import { prisma } from '../../lib/prisma.js';
import { ensureProjectAccess } from '../../lib/ensureProjectAccess.js';
import { generateChat, isAiConfigured, sanitizeUserInputForPrompt } from '../../lib/ai.js';

const DRAFT_REPLY_SYSTEM = `You are a Senior Digital Agency PM helping draft a first-pass answer to a client-input request based on project context. Your draft is NEVER sent automatically — a human PM will review and edit.

Rules:
- Be specific. Use the supplied project context (project name, type, client, recent tasks). Do NOT invent facts not supported by context.
- If the question cannot be confidently answered from context, say so and set confidence to "low".
- Tone: plain, concise, professional. No filler ("delve", "furthermore", "in today's landscape").
- Output strictly valid JSON: { "draftAnswer": "<2-5 sentences>", "confidence": "low"|"medium"|"high", "missingInfo": ["<what you'd need to answer better>", ...] }`;

export async function pmInputRequestRoutes(app) {
  // POST /pm/input-requests/:id/draft — AI drafts a suggested answer.
  app.post(
    '/input-requests/:id/draft',
    {
      onRequest: [app.verifyJwt, app.requirePM],
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
      const { id } = request.params;

      if (!isAiConfigured()) {
        return reply.status(503).send({ message: 'AI drafting is not configured. Set ANTHROPIC_API_KEY.' });
      }

      const inputRequest = await prisma.clientInputRequest.findUnique({
        where: { id },
        include: {
          task: {
            include: {
              project: {
                include: { client: { select: { id: true, agencyName: true } } },
              },
            },
          },
        },
      });

      if (!inputRequest) {
        return reply.status(404).send({ message: 'Input request not found' });
      }

      const canAccess = await ensureProjectAccess(inputRequest.task.project, user);
      if (!canAccess) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }

      // Recent completed tasks on the same project give useful context.
      const recentTasks = await prisma.task.findMany({
        where: {
          projectId: inputRequest.task.projectId,
          status: 'COMPLETED',
        },
        orderBy: { updatedAt: 'desc' },
        take: 8,
        select: { title: true, taskType: true },
      });

      const task = inputRequest.task;
      const project = task.project;

      const taskDescription = sanitizeUserInputForPrompt(task.description || '', 2000);
      const questionText = sanitizeUserInputForPrompt(inputRequest.requestNote || '', 4000);
      const recentSummary = recentTasks.length
        ? recentTasks.map((t) => `- ${t.title} (${t.taskType})`).join('\n')
        : 'No recently completed tasks.';

      const userMessage = `Client: ${project.client.agencyName}
Project: ${project.name} (${project.projectType})
Task: ${task.title} [${task.taskType}]
${taskDescription ? `\nTask description:\n${taskDescription}\n` : ''}
Recent completed tasks on this project:
${recentSummary}

PM's question to the client:
"""
${questionText}
"""

Draft a suggested first-pass answer in JSON as specified.`;

      try {
        const { text, parsed } = await generateChat({
          system: DRAFT_REPLY_SYSTEM,
          user: userMessage,
          json: true,
          maxTokens: 800,
          temperature: 0.3,
          feature: 'input_request_draft_reply',
          userId: user.id,
          clientId: project.clientId,
        });

        const parsedJson = parsed || (() => { try { return JSON.parse(text); } catch { return null; } })();
        const draftAnswer = String(parsedJson?.draftAnswer || '').slice(0, 4000);
        const confidenceRaw = String(parsedJson?.confidence || 'low').toLowerCase();
        const confidence = ['low', 'medium', 'high'].includes(confidenceRaw) ? confidenceRaw : 'low';
        const missingInfo = Array.isArray(parsedJson?.missingInfo)
          ? parsedJson.missingInfo.map((m) => String(m).slice(0, 300)).slice(0, 5)
          : [];

        if (!draftAnswer) {
          return reply.status(502).send({ message: 'AI produced no draft. Please retry.' });
        }

        return reply.send({ draftAnswer, confidence, missingInfo });
      } catch (err) {
        request.log.error({ err }, 'AI input-request draft failed');
        return reply.status(502).send({ message: err.message || 'AI drafting temporarily unavailable' });
      }
    }
  );
}
