/**
 * Login-free knowledge interview, reached through a tokenised invite link.
 *
 * These routes are intentionally unauthenticated, so they:
 *   - resolve the client from the token alone and never trust a body-supplied id,
 *   - expose only a summary of the knowledge base, not file contents,
 *   - are rate limited per IP, and
 *   - write to IntakeSubmission and the OKF draft queue, never straight to disk.
 */
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { generateChat, isAiConfigured } from '../lib/ai.js';
import { listOkfIndex } from '../lib/okfIndexingService.js';

const INTERVIEW_FIELDS = `1. websiteUrl: The business website URL.
2. primaryProduct: Main products or services offered.
3. keyMarkets: Main cities or regions targeted.
4. targetCustomer: Ideal client/customer persona.
5. uniqueSellingPoints: USPs, what sets the business apart.
6. primarySeoGoal: Allowed options: "traffic", "keywords", "competitors", "local", "ecommerce", "other".
7. competitors: List of top 1-5 competitors (names or URLs).
8. targetKeywords: Seed keywords they want to rank for.
9. geographicTarget: Allowed options: "local", "national", "international".
10. brandVoice: Allowed options: "professional", "friendly", "technical", "bold", "other".
11. topicsToAvoid: Sensitive topics or themes to bypass (optional).
12. seasonalEvents: Key dates or seasonal campaigns (optional).`;

const SYSTEM_PROMPT = `You are a friendly growth consultant interviewing a business owner so their marketing team can write accurately about them.

Collect these fields:
${INTERVIEW_FIELDS}

Read the history and the latest reply, then update "extractedData". Keep values you already have unless the user corrects them. Extract several fields at once when the user volunteers them.

Ask one brief, natural next question (max 2 sentences) about the most important missing field. When fields 1 to 10 are filled, set "isFinished" to true and thank them.

Respond with JSON only:
{"nextQuestion":"...","extractedData":{"websiteUrl":null,"primaryProduct":null,"keyMarkets":null,"targetCustomer":null,"uniqueSellingPoints":null,"primarySeoGoal":null,"competitors":[],"targetKeywords":null,"geographicTarget":null,"brandVoice":null,"topicsToAvoid":null,"seasonalEvents":null},"isFinished":false}`;

const RATE_LIMIT = { max: 40, timeWindow: '10 minutes' };

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Resolves an invite from its plaintext token, rejecting anything revoked,
 * expired or already completed. Returns null after replying with the reason.
 */
async function resolveInvite(request, reply) {
  const token = request.params?.token;
  if (!token || token.length < 20) {
    reply.status(404).send({ message: 'This link is not valid.' });
    return null;
  }

  const invite = await prisma.knowledgeInterviewInvite.findUnique({
    where: { tokenHash: hashToken(token) },
  });

  if (!invite) {
    reply.status(404).send({ message: 'This link is not valid.' });
    return null;
  }
  if (invite.status === 'REVOKED') {
    reply.status(410).send({ message: 'This link has been revoked. Ask your team for a new one.' });
    return null;
  }
  if (invite.status === 'COMPLETED') {
    reply.status(410).send({ message: 'This interview has already been completed. Thank you!' });
    return null;
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    reply.status(410).send({ message: 'This link has expired. Ask your team for a new one.' });
    return null;
  }

  return invite;
}

export async function publicKnowledgeInterviewRoutes(app) {
  app.get(
    '/knowledge-interview/:token',
    { config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const invite = await resolveInvite(request, reply);
      if (!invite) return;

      const [client, project, assets] = await Promise.all([
        prisma.clientAccount.findUnique({
          where: { id: invite.clientId },
          select: { agencyName: true, websiteUrl: true, industry: true },
        }),
        invite.projectId
          ? prisma.project.findUnique({
              where: { id: invite.projectId },
              select: { name: true, projectType: true, status: true },
            })
          : Promise.resolve(null),
        listOkfIndex(invite.clientId, {}).catch(() => []),
      ]);

      await prisma.knowledgeInterviewInvite
        .update({
          where: { id: invite.id },
          data: { lastOpenedAt: new Date(), status: invite.status === 'PENDING' ? 'OPENED' : invite.status },
        })
        .catch(() => {});

      // Titles and folders only — an unauthenticated caller never sees bodies.
      const byFolder = {};
      for (const asset of assets) {
        byFolder[asset.folder] = (byFolder[asset.folder] || 0) + 1;
      }

      return reply.send({
        client: {
          agencyName: client?.agencyName || 'your business',
          websiteUrl: client?.websiteUrl || null,
          industry: client?.industry || null,
        },
        project: project
          ? { name: project.name, projectType: project.projectType, status: project.status }
          : null,
        knowledgeBase: {
          fileCount: assets.length,
          folders: Object.entries(byFolder).map(([folder, count]) => ({ folder, count })),
          documents: assets.slice(0, 50).map((a) => ({
            title: a.title,
            folder: a.folder,
            type: a.type,
            lastModified: a.lastModified,
          })),
        },
        invite: {
          recipientName: invite.recipientName,
          expiresAt: invite.expiresAt,
          draftData: invite.draftData || null,
        },
      });
    }
  );

  app.post(
    '/knowledge-interview/:token/chat',
    {
      config: { rateLimit: RATE_LIMIT },
      schema: {
        body: {
          type: 'object',
          properties: {
            message: { type: 'string', maxLength: 4000 },
            history: {
              type: 'array',
              maxItems: 60,
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['user', 'assistant'] },
                  content: { type: 'string', maxLength: 4000 },
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
      const invite = await resolveInvite(request, reply);
      if (!invite) return;

      if (!isAiConfigured()) {
        return reply.status(503).send({ message: 'The assistant is temporarily unavailable.' });
      }

      const { message, history, currentData } = request.body;

      try {
        const { parsed } = await generateChat({
          system: SYSTEM_PROMPT,
          messages: [
            ...history.map((h) => ({ role: h.role, content: h.content })),
            {
              role: 'user',
              content: `Current extracted state: ${JSON.stringify(currentData)}\nLatest user message: ${message}`,
            },
          ],
          json: true,
          maxTokens: 1024,
          feature: 'knowledge_interview_public',
          clientId: invite.clientId,
        });

        const result = parsed || {
          nextQuestion: "Thanks. Could you tell me a bit more about who your ideal customer is?",
          extractedData: currentData,
          isFinished: false,
        };

        // Persist progress so a closed tab does not lose the conversation.
        await prisma.knowledgeInterviewInvite
          .update({
            where: { id: invite.id },
            data: { draftData: result.extractedData ?? currentData, status: 'IN_PROGRESS' },
          })
          .catch(() => {});

        return reply.send(result);
      } catch (err) {
        request.log.error({ err }, 'Public knowledge interview turn failed');
        return reply.status(502).send({ message: 'The assistant is temporarily unavailable.' });
      }
    }
  );

  app.post(
    '/knowledge-interview/:token/submit',
    {
      config: { rateLimit: RATE_LIMIT },
      schema: {
        body: {
          type: 'object',
          properties: { data: { type: 'object', additionalProperties: true } },
          required: ['data'],
        },
      },
    },
    async (request, reply) => {
      const invite = await resolveInvite(request, reply);
      if (!invite) return;

      const { data } = request.body;

      const body = Object.entries(data)
        .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
        .map(([k, v]) => {
          const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
          return `### ${label}\n\n${Array.isArray(v) ? v.join(', ') : v}\n`;
        })
        .join('\n');

      await prisma.$transaction([
        // IntakeSubmission requires a submitter, and there is no logged-in user
        // here, so the answers are attributed to the admin who sent the invite.
        ...(invite.createdById
          ? [
              prisma.intakeSubmission.create({
                data: {
                  clientId: invite.clientId,
                  projectId: invite.projectId,
                  submittedById: invite.createdById,
                  data,
                },
              }),
            ]
          : []),
        prisma.okfDraftChange.create({
          data: {
            clientId: invite.clientId,
            folder: 'company',
            filename: `interview-${new Date().toISOString().slice(0, 10)}`,
            title: 'Knowledge interview',
            proposedMetadata: {
              type: 'client-interview',
              title: 'Knowledge interview',
              source: 'INTERVIEW_LINK',
              respondent: invite.recipientName || null,
              captured_at: new Date().toISOString(),
            },
            proposedBody: `# Knowledge interview\n\n${body}`,
            sourceType: 'INTERVIEW_LINK',
            status: 'PENDING',
          },
        }),
        prisma.knowledgeInterviewInvite.update({
          where: { id: invite.id },
          data: { status: 'COMPLETED', completedAt: new Date(), draftData: data },
        }),
      ]);

      return reply.send({ success: true });
    }
  );
}

export default publicKnowledgeInterviewRoutes;
