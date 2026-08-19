import { prisma } from '../../lib/prisma.js';
import { generateChat, isAiConfigured } from '../../lib/ai.js';
import { resolvePrimaryClient } from '../../lib/clientContext.js';

const INTAKE_FIELDS = `1. websiteUrl: The business website URL.
2. primaryProduct: Main products or services offered.
3. keyMarkets: Main cities or regions targeted.
4. targetCustomer: Ideal client/customer persona.
5. uniqueSellingPoints: USPs, what sets the business apart.
6. primarySeoGoal: Primary goals. Allowed options: "traffic" (organic traffic), "keywords" (rank for keywords), "competitors" (outrank competitors), "local" (local visibility), "ecommerce" (e-commerce sales), "other".
7. competitors: List of top 1-5 competitors (names or URLs).
8. targetKeywords: Seed/initial keywords they want to rank for.
9. geographicTarget: Allowed options: "local", "national", "international".
10. brandVoice: Desired tone. Allowed options: "professional", "friendly", "technical", "bold", "other".
11. topicsToAvoid: Sensitive topics, legal exclusions, or themes to bypass (optional).
12. seasonalEvents: Key dates or seasonal campaigns (optional).`;

export async function clientGapInterviewRoutes(app) {
  // ── Load any prior intake so the interview resumes instead of restarting ──
  app.get(
    '/gap-interview/initial',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            projectId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const client = await resolvePrimaryClient(request);
      if (!client) return reply.status(404).send({ message: 'No client account linked' });

      const { projectId } = request.query;

      const latestIntake = await prisma.intakeSubmission.findFirst({
        where: {
          clientId: client.id,
          ...(projectId ? { projectId } : { projectId: null }),
        },
        orderBy: { submittedAt: 'desc' },
      });

      return reply.send({ extractedData: latestIntake?.data || {} });
    }
  );

  // ── One conversation turn: extract fields, return the next question ──
  app.post(
    '/gap-interview/chat',
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
            currentData: { type: 'object', additionalProperties: true },
          },
          required: ['message', 'history', 'currentData'],
        },
      },
    },
    async (request, reply) => {
      if (!isAiConfigured()) {
        return reply.status(503).send({
          message: 'AI assistant is not configured. Set ANTHROPIC_API_KEY in your .env file.',
        });
      }

      const client = await resolvePrimaryClient(request);
      if (!client) return reply.status(404).send({ message: 'No client account linked' });

      const { message, history, currentData } = request.body;

      const systemPrompt = `You are the Localwave Assistant growth consultant running a Gap Interview to onboard a client.
Your goal is to gather detailed business intake information to build their content strategy profile.

Here is the list of target fields to collect:
${INTAKE_FIELDS}

Analyze the conversation history and the user's latest response. Update the "extractedData" JSON object below. If a field was already present, keep it unless corrected by the user. If the user mentions multiple points, extract them all at once.

Generate a friendly, brief next question in conversational English (max 2 sentences) focusing on the next missing field. Keep the question simple and natural for voice synthesis.
If all key fields (1 through 10) have been successfully extracted, set "isFinished" to true and thank the client.

You MUST respond ONLY with a valid JSON object in this format (no markdown code blocks, no other text):
{
  "nextQuestion": "The next brief question to ask the client in English.",
  "extractedData": {
    "websiteUrl": "extracted value or null",
    "primaryProduct": "extracted value or null",
    "keyMarkets": "extracted value or null",
    "targetCustomer": "extracted value or null",
    "uniqueSellingPoints": "extracted value or null",
    "primarySeoGoal": "traffic/keywords/competitors/local/ecommerce/other or null",
    "competitors": ["comp1", "comp2"],
    "targetKeywords": "extracted value or null",
    "geographicTarget": "local/national/international or null",
    "brandVoice": "professional/friendly/technical/bold/other or null",
    "topicsToAvoid": "extracted value or null",
    "seasonalEvents": "extracted value or null"
  },
  "isFinished": true/false
}`;

      const messages = [
        ...history.map((h) => ({ role: h.role, content: h.content })),
        {
          role: 'user',
          content: `Current extracted state: ${JSON.stringify(currentData)}\nLatest user message: ${message}`,
        },
      ];

      try {
        const { parsed } = await generateChat({
          system: systemPrompt,
          messages,
          json: true,
          maxTokens: 1024,
          feature: 'gap_interview_chat',
          userId: request.user.id,
          clientId: client.id,
        });

        if (parsed) return reply.send(parsed);

        return reply.send({
          nextQuestion: "I see, let's keep going. Could you tell me a bit more about your target customer and who you aim to serve?",
          extractedData: currentData,
          isFinished: false,
        });
      } catch (err) {
        request.log.error({ err }, 'Gap Interview AI turn failed');
        return reply.status(502).send({
          message: err.message || 'Growth Assistant is temporarily unavailable. Please try again.',
        });
      }
    }
  );

  // ── Persist the finished interview and advance onboarding ──
  app.post(
    '/gap-interview/submit',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
      schema: {
        body: {
          type: 'object',
          properties: {
            projectId: { type: 'string', nullable: true },
            data: { type: 'object', additionalProperties: true },
          },
          required: ['data'],
        },
      },
    },
    async (request, reply) => {
      const client = await resolvePrimaryClient(request);
      if (!client) return reply.status(404).send({ message: 'No client account linked' });

      const { projectId, data } = request.body;

      const ops = [
        prisma.intakeSubmission.create({
          data: {
            clientId: client.id,
            projectId: projectId || null,
            submittedById: request.user.id,
            data,
          },
        }),
      ];

      if (projectId) {
        ops.push(prisma.project.update({
          where: { id: projectId },
          data: { onboardingStep: 3 },
        }));
      } else {
        ops.push(prisma.clientAccount.update({
          where: { id: client.id },
          data: { onboardingStep: 3, onboardingStatus: 'IN_PROGRESS' },
        }));
      }

      await prisma.$transaction(ops);
      return reply.send({ success: true, onboardingStep: 3 });
    }
  );
}
