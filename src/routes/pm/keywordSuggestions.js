import { prisma } from '../../lib/prisma.js';
import { notify } from '../../lib/notificationService.js';

export async function pmKeywordSuggestionRoutes(app) {
  /**
   * GET /keyword-suggestions
   * List all keyword suggestions (PM/OWNER only).
   * Optional query: ?status=PENDING (default), APPROVED, REJECTED, or ALL
   */
  app.get(
    '/keyword-suggestions',
    {
      onRequest: [app.verifyJwt, app.requirePM],
    },
    async (request, reply) => {
      const statusFilter = (request.query?.status || 'PENDING').toUpperCase();

      const where = statusFilter === 'ALL' ? {} : { status: statusFilter };

      const suggestions = await prisma.keywordSuggestion.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        include: {
          client: { select: { id: true, agencyName: true } },
          project: { select: { id: true, name: true } },
          reviewer: { select: { id: true, name: true } },
        },
      });

      return reply.send(
        suggestions.map((s) => ({
          id: s.id,
          keyword: s.keyword,
          targetPage: s.targetPage,
          priority: s.priority,
          notes: s.notes,
          status: s.status,
          submittedAt: s.submittedAt,
          reviewedAt: s.reviewedAt,
          reviewNote: s.reviewNote,
          client: s.client
            ? { id: s.client.id, name: s.client.agencyName }
            : null,
          project: s.project
            ? { id: s.project.id, name: s.project.name }
            : null,
          reviewer: s.reviewer
            ? { id: s.reviewer.id, name: s.reviewer.name }
            : null,
        }))
      );
    }
  );

  /**
   * PATCH /keyword-suggestions/:id/approve
   * Approve a pending keyword suggestion.
   * Optionally promotes it to a KeywordTrack entry if the suggestion has a projectId.
   * Body: { reviewNote?: string, promoteToTrack?: boolean }
   */
  app.patch(
    '/keyword-suggestions/:id/approve',
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
            reviewNote: { type: 'string', nullable: true },
            promoteToTrack: { type: 'boolean', nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { reviewNote, promoteToTrack } = request.body || {};

      const suggestion = await prisma.keywordSuggestion.findUnique({
        where: { id },
      });
      if (!suggestion) {
        return reply.status(404).send({ message: 'Keyword suggestion not found' });
      }
      if (suggestion.status !== 'PENDING') {
        return reply
          .status(400)
          .send({ message: `Suggestion already ${suggestion.status.toLowerCase()}` });
      }

      const updated = await prisma.keywordSuggestion.update({
        where: { id },
        data: {
          status: 'APPROVED',
          reviewedBy: request.user.id,
          reviewedAt: new Date(),
          reviewNote: reviewNote?.trim() || null,
        },
      });

      // Optionally promote to KeywordTrack so it appears in the project keyword list
      let promoted = null;
      if (promoteToTrack && suggestion.projectId) {
        promoted = await prisma.keywordTrack.create({
          data: {
            projectId: suggestion.projectId,
            keyword: suggestion.keyword,
            targetUrl: suggestion.targetPage || null,
            status: 'PROPOSED',
          },
        });
      }

      // Notify client users that their keyword was approved
      try {
        const clientUsers = await prisma.clientUser.findMany({
          where: { clientId: suggestion.clientId },
          select: { userId: true },
        });
        if (clientUsers.length > 0) {
          notify({
            slug: 'keyword_suggestion_approved',
            recipientIds: clientUsers.map((cu) => cu.userId),
            variables: { keyword: suggestion.keyword },
            actionUrl: `/portal/client/inputs`,
            metadata: { keywordSuggestionId: id },
          }).catch(() => {});
        }
      } catch (_) {}

      return reply.send({ suggestion: updated, promotedKeywordTrack: promoted });
    }
  );

  /**
   * PATCH /keyword-suggestions/:id/reject
   * Reject a pending keyword suggestion.
   * Body: { reviewNote?: string }
   */
  app.patch(
    '/keyword-suggestions/:id/reject',
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
            reviewNote: { type: 'string', nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { reviewNote } = request.body || {};

      const suggestion = await prisma.keywordSuggestion.findUnique({
        where: { id },
      });
      if (!suggestion) {
        return reply.status(404).send({ message: 'Keyword suggestion not found' });
      }
      if (suggestion.status !== 'PENDING') {
        return reply
          .status(400)
          .send({ message: `Suggestion already ${suggestion.status.toLowerCase()}` });
      }

      const updated = await prisma.keywordSuggestion.update({
        where: { id },
        data: {
          status: 'REJECTED',
          reviewedBy: request.user.id,
          reviewedAt: new Date(),
          reviewNote: reviewNote?.trim() || null,
        },
      });

      // Notify client users that their keyword was rejected
      try {
        const clientUsers = await prisma.clientUser.findMany({
          where: { clientId: suggestion.clientId },
          select: { userId: true },
        });
        if (clientUsers.length > 0) {
          notify({
            slug: 'keyword_suggestion_rejected',
            recipientIds: clientUsers.map((cu) => cu.userId),
            variables: { keyword: suggestion.keyword },
            actionUrl: `/portal/client/inputs`,
            metadata: { keywordSuggestionId: id },
          }).catch(() => {});
        }
      } catch (_) {}

      return reply.send(updated);
    }
  );
}
