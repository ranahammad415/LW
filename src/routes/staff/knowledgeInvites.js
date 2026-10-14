/**
 * Admin management of login-free knowledge interview links (the KB page's
 * "quick invite"). The full scheduler lives in routes/admin/interviews.js.
 *
 * Creating an invite is an Owner action: the resulting URL grants access to a
 * client's project details and knowledge base summary without a password, so
 * it is deliberately narrower than the read-only PM scope used elsewhere.
 *
 * Invite creation goes through lib/interviewInvites.createInvites() so quick
 * invites get an agenda, the branded agenda email and SEND_FAILED tracking.
 */
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireStaffKnowledgeWrite } from '../../lib/knowledgeScope.js';
import { createInvites, publicShape, logDispatch, DEFAULT_TTL_DAYS, MAX_TTL_DAYS } from '../../lib/interviewInvites.js';
import { TEMPLATE_KEYS } from '../../lib/interviewQuestionBank.js';

const createSchema = z.object({
  projectId: z.string().max(191).optional().nullable(),
  recipientName: z.string().max(255).optional().nullable(),
  email: z.string().trim().email().max(255).optional().nullable().or(z.literal('')),
  expiresInDays: z.number().int().min(1).max(MAX_TTL_DAYS).optional(),
  templateKey: z.enum(TEMPLATE_KEYS).optional(),
  scheduledSendAt: z.string().datetime({ offset: true }).optional().nullable(),
});

export async function staffKnowledgeInviteRoutes(app) {
  app.get(
    '/clients/:clientId/knowledge/invites',
    { onRequest: [app.verifyJwt, requireStaffKnowledgeWrite] },
    async (request, reply) => {
      const invites = await prisma.knowledgeInterviewInvite.findMany({
        where: { clientId: request.knowledgeClientId, delegationDepth: 0 },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return reply.send({ invites: invites.map((i) => ({ ...publicShape(i), agenda: undefined })) });
    }
  );

  app.post(
    '/clients/:clientId/knowledge/invites',
    { onRequest: [app.verifyJwt, requireStaffKnowledgeWrite] },
    async (request, reply) => {
      const clientId = request.knowledgeClientId;
      const parsed = createSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ message: parsed.error.issues?.[0]?.message || 'Invalid request' });
      }
      const {
        projectId = null,
        recipientName = null,
        email = null,
        expiresInDays = DEFAULT_TTL_DAYS,
        templateKey = 'CUSTOM',
        scheduledSendAt = null,
      } = parsed.data;

      if (projectId) {
        const project = await prisma.project.findFirst({
          where: { id: projectId, clientId },
          select: { id: true },
        });
        if (!project) return reply.status(404).send({ message: 'Project not found' });
      }

      const { invites, urls } = await createInvites({
        clientId,
        projectId,
        createdById: request.user.id,
        templateKey,
        recipients: [{ name: recipientName || null, email: email || null }],
        scheduledSendAt,
        expiresInDays,
        sendEmail: Boolean(email),
      });

      // The plaintext link is returned exactly once, here (null when scheduled).
      return reply.status(201).send({
        invite: publicShape(invites[0]),
        url: urls[0]?.url || null,
        emailed: urls[0]?.emailed ?? false,
        emailError: urls[0]?.error || null,
      });
    }
  );

  app.post(
    '/clients/:clientId/knowledge/invites/:inviteId/revoke',
    { onRequest: [app.verifyJwt, requireStaffKnowledgeWrite] },
    async (request, reply) => {
      const invite = await prisma.knowledgeInterviewInvite.findUnique({
        where: { id: request.params.inviteId },
      });
      if (!invite || invite.clientId !== request.knowledgeClientId) {
        return reply.status(404).send({ message: 'Invite not found' });
      }

      const updated = await prisma.knowledgeInterviewInvite.update({
        where: { id: invite.id },
        data: { status: 'REVOKED', revokedAt: new Date(), statusReason: 'revoked by owner' },
      });
      await logDispatch({ inviteId: invite.id, kind: 'REVOKE', detail: `by ${request.user.id}` });
      return reply.send({ invite: publicShape(updated) });
    }
  );
}

export default staffKnowledgeInviteRoutes;
