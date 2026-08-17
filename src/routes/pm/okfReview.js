/**
 * OKF draft review queue for the PM / SEO team.
 *
 * This is the only path by which voice-agent and gap-interview output reaches
 * a client's knowledge base. Approving a draft calls writeOkfFile (which records
 * an OkfVersion) and then reindexes the client's assets.
 */
import { prisma } from '../../lib/prisma.js';
import { writeOkfFile, setOkfContext, clearOkfContext } from '../../lib/knowledgeEngine.js';
import { reindexOkfAssets } from '../../lib/okfIndexingService.js';

const PM_ROLES = ['PM', 'OWNER'];

async function requirePmOrOwner(request, reply) {
  if (!PM_ROLES.includes(request.user?.role)) {
    return reply.status(403).send({ message: 'PM or Owner access required' });
  }
}

/**
 * PMs only see clients they lead; owners see everything.
 * Returns null when no scoping is needed.
 */
async function scopedClientIds(request) {
  if (request.user.role === 'OWNER') return null;
  const clients = await prisma.clientAccount.findMany({
    where: {
      OR: [{ leadPmId: request.user.id }, { secondaryPmId: request.user.id }],
    },
    select: { id: true },
  });
  return clients.map((c) => c.id);
}

async function attachClientNames(drafts) {
  const clientIds = [...new Set(drafts.map((d) => d.clientId))];
  if (clientIds.length === 0) return drafts;

  const clients = await prisma.clientAccount.findMany({
    where: { id: { in: clientIds } },
    select: { id: true, agencyName: true },
  });
  const nameById = new Map(clients.map((c) => [c.id, c.agencyName]));

  return drafts.map((d) => ({ ...d, clientName: nameById.get(d.clientId) || 'Unknown client' }));
}

export async function pmOkfReviewRoutes(app) {
  // ── Queue ─────────────────────────────────────────────────────────────────
  app.get(
    '/okf-review/drafts',
    {
      onRequest: [app.verifyJwt, requirePmOrOwner],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] },
            clientId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { status = 'PENDING', clientId } = request.query || {};
      const allowedIds = await scopedClientIds(request);

      if (allowedIds && allowedIds.length === 0) {
        return reply.send({ drafts: [], counts: { PENDING: 0, APPROVED: 0, REJECTED: 0 } });
      }
      if (clientId && allowedIds && !allowedIds.includes(clientId)) {
        return reply.status(403).send({ message: 'You do not manage this client' });
      }

      const clientFilter = clientId
        ? { clientId }
        : allowedIds
          ? { clientId: { in: allowedIds } }
          : {};

      const [drafts, grouped] = await Promise.all([
        prisma.okfDraftChange.findMany({
          where: { ...clientFilter, status },
          orderBy: { createdAt: 'desc' },
          take: 200,
          include: {
            session: {
              select: { id: true, startedAt: true, durationSeconds: true, summary: true },
            },
          },
        }),
        prisma.okfDraftChange.groupBy({
          by: ['status'],
          where: clientFilter,
          _count: { _all: true },
        }),
      ]);

      const counts = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
      for (const row of grouped) counts[row.status] = row._count._all;

      return reply.send({ drafts: await attachClientNames(drafts), counts });
    }
  );

  // ── Approve: write into OKF and reindex ───────────────────────────────────
  app.post(
    '/okf-review/drafts/:id/approve',
    {
      onRequest: [app.verifyJwt, requirePmOrOwner],
      schema: {
        body: {
          type: 'object',
          properties: {
            folder: { type: 'string' },
            filename: { type: 'string' },
            title: { type: 'string' },
            body: { type: 'string' },
            reviewNote: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const draft = await prisma.okfDraftChange.findUnique({ where: { id: request.params.id } });
      if (!draft) return reply.status(404).send({ message: 'Draft not found' });
      if (draft.status !== 'PENDING') {
        return reply.status(409).send({ message: 'This draft has already been reviewed.' });
      }

      const allowedIds = await scopedClientIds(request);
      if (allowedIds && !allowedIds.includes(draft.clientId)) {
        return reply.status(403).send({ message: 'You do not manage this client' });
      }

      // The reviewer can correct the agent's filing and wording before it lands.
      const { folder, filename, title, body, reviewNote } = request.body || {};
      const finalFolder = folder || draft.folder;
      const finalFilename = (filename || draft.filename).replace(/\.md$/, '');
      const finalTitle = title || draft.title;
      const finalBody = body ?? draft.proposedBody;

      setOkfContext({
        userId: request.user.id,
        agentName: draft.sourceType === 'VOICE_AGENT' ? 'Voice Business Agent' : draft.sourceType,
        reason: `Approved draft ${draft.id}`,
      });

      let filePath;
      try {
        filePath = writeOkfFile(
          draft.clientId,
          finalFolder,
          finalFilename,
          {
            ...(draft.proposedMetadata || {}),
            title: finalTitle,
            source: draft.sourceType,
            approved_by: request.user.id,
            approved_at: new Date().toISOString(),
            change_summary: reviewNote || `Approved from ${draft.sourceType}`,
          },
          finalBody
        );
      } catch (err) {
        request.log.error({ err }, 'Failed to write approved OKF draft');
        return reply.status(500).send({ message: err.message });
      } finally {
        clearOkfContext();
      }

      await prisma.okfDraftChange.update({
        where: { id: draft.id },
        data: {
          status: 'APPROVED',
          folder: finalFolder,
          filename: finalFilename,
          title: finalTitle,
          proposedBody: finalBody,
          reviewerId: request.user.id,
          reviewedAt: new Date(),
          reviewNote: reviewNote ? String(reviewNote).slice(0, 1000) : null,
        },
      });

      await reindexOkfAssets(draft.clientId);

      return reply.send({ success: true, path: filePath });
    }
  );

  // ── Reject ────────────────────────────────────────────────────────────────
  app.post(
    '/okf-review/drafts/:id/reject',
    {
      onRequest: [app.verifyJwt, requirePmOrOwner],
      schema: {
        body: {
          type: 'object',
          properties: { reviewNote: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const draft = await prisma.okfDraftChange.findUnique({ where: { id: request.params.id } });
      if (!draft) return reply.status(404).send({ message: 'Draft not found' });
      if (draft.status !== 'PENDING') {
        return reply.status(409).send({ message: 'This draft has already been reviewed.' });
      }

      const allowedIds = await scopedClientIds(request);
      if (allowedIds && !allowedIds.includes(draft.clientId)) {
        return reply.status(403).send({ message: 'You do not manage this client' });
      }

      await prisma.okfDraftChange.update({
        where: { id: draft.id },
        data: {
          status: 'REJECTED',
          reviewerId: request.user.id,
          reviewedAt: new Date(),
          reviewNote: request.body?.reviewNote ? String(request.body.reviewNote).slice(0, 1000) : null,
        },
      });

      return reply.send({ success: true });
    }
  );

  // ── Bulk approve ──────────────────────────────────────────────────────────
  app.post(
    '/okf-review/drafts/bulk-approve',
    {
      onRequest: [app.verifyJwt, requirePmOrOwner],
      schema: {
        body: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' }, maxItems: 100 },
          },
          required: ['ids'],
        },
      },
    },
    async (request, reply) => {
      const allowedIds = await scopedClientIds(request);
      const drafts = await prisma.okfDraftChange.findMany({
        where: {
          id: { in: request.body.ids },
          status: 'PENDING',
          ...(allowedIds ? { clientId: { in: allowedIds } } : {}),
        },
      });

      const touchedClients = new Set();
      let approved = 0;

      for (const draft of drafts) {
        setOkfContext({
          userId: request.user.id,
          agentName: draft.sourceType === 'VOICE_AGENT' ? 'Voice Business Agent' : draft.sourceType,
          reason: `Bulk-approved draft ${draft.id}`,
        });
        try {
          writeOkfFile(
            draft.clientId,
            draft.folder,
            draft.filename,
            {
              ...(draft.proposedMetadata || {}),
              title: draft.title,
              source: draft.sourceType,
              approved_by: request.user.id,
              approved_at: new Date().toISOString(),
            },
            draft.proposedBody
          );
          await prisma.okfDraftChange.update({
            where: { id: draft.id },
            data: { status: 'APPROVED', reviewerId: request.user.id, reviewedAt: new Date() },
          });
          touchedClients.add(draft.clientId);
          approved++;
        } catch (err) {
          request.log.error({ err, draftId: draft.id }, 'Bulk approve failed for draft');
        } finally {
          clearOkfContext();
        }
      }

      for (const clientId of touchedClients) {
        await reindexOkfAssets(clientId);
      }

      return reply.send({ success: true, approved, skipped: request.body.ids.length - approved });
    }
  );

  // ── Voice interview sessions across managed clients ───────────────────────
  app.get(
    '/okf-review/sessions',
    { onRequest: [app.verifyJwt, requirePmOrOwner] },
    async (request, reply) => {
      const allowedIds = await scopedClientIds(request);
      if (allowedIds && allowedIds.length === 0) return reply.send({ sessions: [] });

      const sessions = await prisma.voiceInterviewSession.findMany({
        where: allowedIds ? { clientId: { in: allowedIds } } : {},
        orderBy: { startedAt: 'desc' },
        take: 50,
        select: {
          id: true,
          clientId: true,
          status: true,
          startedAt: true,
          endedAt: true,
          durationSeconds: true,
          summary: true,
          _count: { select: { drafts: true } },
        },
      });

      return reply.send({ sessions: await attachClientNames(sessions) });
    }
  );
}
