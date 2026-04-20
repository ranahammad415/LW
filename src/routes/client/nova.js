import { generateChat, isAiConfigured } from '../../lib/ai.js';
import { prisma } from '../../lib/prisma.js';

function buildNovaSystemPrompt(agencyName, activeTasksCount) {
  return `You are Localwave Assistant, the intelligent agency assistant. You are friendly, concise, and professional.

Context about the client you are talking to:
- Company/agency name: ${agencyName ?? 'Unknown'}
- Number of active tasks currently being worked on: ${activeTasksCount}

Use this context to personalise answers when relevant (e.g. "With ${activeTasksCount} active tasks right now…"). Keep responses helpful and to the point. Do not make up data; if you don't know something, say so.`;
}

async function getPrimaryClientAndActiveTasksCount(userId) {
  const clientUsers = await prisma.clientUser.findMany({
    where: { userId },
    include: { client: true },
  });
  if (clientUsers.length === 0) return null;
  const clientIds = clientUsers.map((cu) => cu.clientId);
  const primaryClient = clientUsers.find((cu) => cu.isPrimaryContact)?.client ?? clientUsers[0].client;
  const activeTasksCount = await prisma.task.count({
    where: {
      project: { clientId: { in: clientIds } },
      clientVisible: true,
      status: { notIn: ['COMPLETED', 'CANCELLED'] },
    },
  });
  return { agencyName: primaryClient.agencyName, activeTasksCount };
}

export async function clientNovaRoutes(app) {
  app.post(
    '/nova/chat',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        body: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            history: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['user', 'assistant'] },
                  content: { type: 'string' },
                },
              },
            },
          },
          required: ['message'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              response: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!isAiConfigured()) {
        return reply.status(503).send({
          message: 'Localwave Assistant is not configured. Set ANTHROPIC_API_KEY in your .env file.',
        });
      }

      const { message, history = [] } = request.body || {};
      const trimmedMessage = typeof message === 'string' ? message.trim() : '';
      if (!trimmedMessage) {
        return reply.status(400).send({ message: 'message is required' });
      }

      const context = await getPrimaryClientAndActiveTasksCount(request.user.id);
      if (!context) {
        return reply.status(404).send({ message: 'No client account linked' });
      }

      const systemPrompt = buildNovaSystemPrompt(context.agencyName, context.activeTasksCount);

      const messages = [
        { role: 'system', content: systemPrompt },
        ...history
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: trimmedMessage },
      ];

      try {
        const { text } = await generateChat({ messages, maxTokens: 1024 });
        const response = typeof text === 'string' && text ? text : 'Sorry, I couldn’t generate a response. Please try again.';
        return reply.send({ response });
      } catch (err) {
        request.log.error({ err }, 'Localwave AI request failed');
        return reply.status(502).send({
          message: err.message || 'Localwave Assistant is temporarily unavailable. Please try again.',
        });
      }
    }
  );
}
