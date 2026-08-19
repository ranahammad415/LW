/**
 * Admin management of login-free knowledge interview links.
 *
 * Creating an invite is an Owner action: the resulting URL grants access to a
 * client's project details and knowledge base summary without a password, so
 * it is deliberately narrower than the read-only PM scope used elsewhere.
 */
import crypto from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { requireStaffKnowledgeWrite } from '../../lib/knowledgeScope.js';
import { sendEmail } from '../../lib/mailer.js';

const DEFAULT_TTL_DAYS = 14;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function inviteUrl(token) {
  const base = process.env.FRONTEND_URL || 'https://app.localwaves.ai';
  return `${base.replace(/\/$/, '')}/knowledge-interview/${token}`;
}

/** Never leak the hash to the browser. */
function publicShape(invite) {
  const { tokenHash: _hash, ...rest } = invite;
  return rest;
}

export async function staffKnowledgeInviteRoutes(app) {
  app.get(
    '/clients/:clientId/knowledge/invites',
    { onRequest: [app.verifyJwt, requireStaffKnowledgeWrite] },
    async (request, reply) => {
      const invites = await prisma.knowledgeInterviewInvite.findMany({
        where: { clientId: request.knowledgeClientId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return reply.send({ invites: invites.map(publicShape) });
    }
  );

  app.post(
    '/clients/:clientId/knowledge/invites',
    {
      onRequest: [app.verifyJwt, requireStaffKnowledgeWrite],
      schema: {
        body: {
          type: 'object',
          properties: {
            projectId: { type: 'string', nullable: true },
            recipientName: { type: 'string' },
            email: { type: 'string' },
            expiresInDays: { type: 'integer', minimum: 1, maximum: 90 },
          },
        },
      },
    },
    async (request, reply) => {
      const clientId = request.knowledgeClientId;
      const {
        projectId = null,
        recipientName = null,
        email = null,
        expiresInDays = DEFAULT_TTL_DAYS,
      } = request.body || {};

      if (projectId) {
        const project = await prisma.project.findFirst({
          where: { id: projectId, clientId },
          select: { id: true },
        });
        if (!project) return reply.status(404).send({ message: 'Project not found' });
      }

      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

      const invite = await prisma.knowledgeInterviewInvite.create({
        data: {
          clientId,
          projectId,
          tokenHash: hashToken(token),
          createdById: request.user.id,
          recipientName: recipientName ? String(recipientName).slice(0, 255) : null,
          sentToEmail: email ? String(email).slice(0, 255) : null,
          expiresAt,
        },
      });

      const url = inviteUrl(token);

      if (email) {
        const client = await prisma.clientAccount.findUnique({
          where: { id: clientId },
          select: { agencyName: true },
        });
        await sendEmail({
          to: email,
          subject: `Tell us about ${client?.agencyName || 'your business'}`,
          text: `Hi${recipientName ? ` ${recipientName}` : ''},\n\nWe would like to capture a bit more about your business so everything we write for you is accurate.\n\nOpen this link to get started — no login needed:\n${url}\n\nThe link expires on ${expiresAt.toDateString()}.`,
          html: `<p>Hi${recipientName ? ` ${recipientName}` : ''},</p>
<p>We would like to capture a bit more about your business so everything we write for you is accurate.</p>
<p><a href="${url}">Start the interview</a> — no login needed.</p>
<p style="color:#666;font-size:12px">The link expires on ${expiresAt.toDateString()}.</p>`,
        }).catch((err) => request.log.error({ err }, 'Failed to email knowledge interview invite'));
      }

      // The plaintext token is returned exactly once, here.
      return reply.status(201).send({ invite: publicShape(invite), url });
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
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      return reply.send({ invite: publicShape(updated) });
    }
  );
}

export default staffKnowledgeInviteRoutes;
