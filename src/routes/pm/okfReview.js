/**
 * OKF draft review queue for the PM / SEO team.
 *
 * This is the only path by which voice-agent and gap-interview output reaches
 * a client's knowledge base. Approving a draft calls writeOkfFile (which records
 * an OkfVersion) and then reindexes the client's assets.
 */
import { rejectAgentReviewer } from '../../lib/agentPolicy.js';
import { prisma } from '../../lib/prisma.js';
import crypto from 'crypto';
import { z } from 'zod';
import { writeOkfFile, readOkfFile, setOkfContext, clearOkfContext } from '../../lib/knowledgeEngine.js';
import { reindexOkfAssets } from '../../lib/okfIndexingService.js';
import { rebaseDraftOnCurrent, approvalMetadata } from '../../lib/interviewConsolidation.js';

/** Optional interview filters on the queue (plan §6, §9, §23). */
const draftFilterSchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING'),
  clientId: z.string().max(191).optional(),
  sourceType: z.string().max(40).optional(),
  factType: z.string().max(30).optional(),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  changeKind: z.enum(['NEW', 'UPDATE', 'CONFIRM', 'CONFLICT']).optional(),
  inviteId: z.string().max(191).optional(),
  rootInviteId: z.string().max(191).optional(),
  sessionId: z.string().max(191).optional(),
  respondentRole: z.enum(['CLIENT', 'STAFF']).optional(),
});

function bodyHash(body) {
  return crypto.createHash('sha256').update(String(body ?? '')).digest('hex');
}

function safeReadOkf(clientId, folder, filename) {
  try {
    return readOkfFile(clientId, folder, filename);
  } catch {
    return null;
  }
}

/** True when the target file changed since consolidation hashed it. */
function isStale(draft, current) {
  if (!draft.currentBodyHash) return false;
  if (!current) return true;
  return bodyHash(current.body) !== draft.currentBodyHash;
}

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
      const parsedQuery = draftFilterSchema.safeParse(request.query || {});
      if (!parsedQuery.success) {
        return reply.status(400).send({ message: parsedQuery.error.issues?.[0]?.message || 'Invalid filter' });
      }
      const { status, clientId, ...filters } = parsedQuery.data;
      const extraWhere = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
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
          where: { ...clientFilter, ...extraWhere, status },
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
          where: { ...clientFilter, ...extraWhere },
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
      onRequest: [app.verifyJwt, requirePmOrOwner, rejectAgentReviewer],
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
      const { folder, filename, title, body, reviewNote, force } = request.body || {};
      const finalFolder = folder || draft.folder;
      const finalFilename = (filename || draft.filename).replace(/\.md$/, '');
      const finalTitle = title || draft.title;
      const staleAtApproval = isStale(draft, safeReadOkf(draft.clientId, draft.folder, draft.filename));
      // Review fix H2: rebase onto the file as it is now, so approving a draft
      // never erases another draft approved into the same file since.
      const current = safeReadOkf(draft.clientId, finalFolder, finalFilename);
      const rebase = rebaseDraftOnCurrent({ ...draft, title: finalTitle }, current);
      const reviewerEdited = typeof body === 'string' && body !== draft.proposedBody;
      if (reviewerEdited && rebase.rebased && !force) {
        return reply.status(409).send({
          message: 'This file changed since the draft was prepared. Reload the diff and edit again, or approve with force to keep your edit as the whole file.',
          code: 'STALE_DRAFT',
        });
      }
      const finalBody = reviewerEdited ? body : rebase.body;

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
            ...approvalMetadata(draft.proposedMetadata),
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

      return reply.send({ success: true, path: filePath, wasStale: staleAtApproval, rebased: rebase.rebased && !reviewerEdited });
    }
  );

  // ── Reject ────────────────────────────────────────────────────────────────
  app.post(
    '/okf-review/drafts/:id/reject',
    {
      onRequest: [app.verifyJwt, requirePmOrOwner, rejectAgentReviewer],
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
      onRequest: [app.verifyJwt, requirePmOrOwner, rejectAgentReviewer],
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
          // Sequential + rebased on the file as the previous draft left it (H2).
          const { body: rebasedBody } = rebaseDraftOnCurrent(draft, safeReadOkf(draft.clientId, draft.folder, draft.filename));
          writeOkfFile(
            draft.clientId,
            draft.folder,
            draft.filename,
            {
              ...approvalMetadata(draft.proposedMetadata),
              title: draft.title,
              source: draft.sourceType,
              approved_by: request.user.id,
              approved_at: new Date().toISOString(),
            },
            rebasedBody
          );
          await prisma.okfDraftChange.update({
            where: { id: draft.id },
            data: { status: 'APPROVED', reviewerId: request.user.id, reviewedAt: new Date(), proposedBody: rebasedBody },
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

  // ── Diff: current file vs proposed (plan §6 "Diff") ───────────────────────
  app.get(
    '/okf-review/drafts/:id/diff',
    { onRequest: [app.verifyJwt, requirePmOrOwner] },
    async (request, reply) => {
      const draft = await prisma.okfDraftChange.findUnique({ where: { id: request.params.id } });
      if (!draft) return reply.status(404).send({ message: 'Draft not found' });
      const allowedIds = await scopedClientIds(request);
      if (allowedIds && !allowedIds.includes(draft.clientId)) {
        return reply.status(403).send({ message: 'You do not manage this client' });
      }
      const current = safeReadOkf(draft.clientId, draft.folder, draft.filename);
      return reply.send({
        current: current ? { metadata: current.metadata, body: current.body } : null,
        proposed: { metadata: draft.proposedMetadata, body: draft.proposedBody },
        stale: isStale(draft, current),
        change: draft.proposedMetadata?.change || null,
        sourceQuote: draft.sourceQuote,
        transcriptRef: draft.transcriptRef,
      });
    }
  );

  // ── Bulk reject ───────────────────────────────────────────────────────────
  app.post(
    '/okf-review/drafts/bulk-reject',
    { onRequest: [app.verifyJwt, requirePmOrOwner, rejectAgentReviewer] },
    async (request, reply) => {
      const parsed = z.object({
        ids: z.array(z.string().max(191)).min(1).max(100),
        reviewNote: z.string().max(1000).optional(),
      }).safeParse(request.body || {});
      if (!parsed.success) return reply.status(400).send({ message: 'ids is required (max 100)' });
      const allowedIds = await scopedClientIds(request);
      const result = await prisma.okfDraftChange.updateMany({
        where: {
          id: { in: parsed.data.ids },
          status: 'PENDING',
          ...(allowedIds ? { clientId: { in: allowedIds } } : {}),
        },
        data: {
          status: 'REJECTED',
          reviewerId: request.user.id,
          reviewedAt: new Date(),
          reviewNote: parsed.data.reviewNote ? parsed.data.reviewNote.slice(0, 1000) : null,
        },
      });
      return reply.send({ success: true, rejected: result.count, skipped: parsed.data.ids.length - result.count });
    }
  );

  // ── Interviews (read-only for PMs: no tokens, no transcripts) ─────────────
  app.get(
    '/okf-review/interviews',
    { onRequest: [app.verifyJwt, requirePmOrOwner] },
    async (request, reply) => {
      const allowedIds = await scopedClientIds(request);
      if (allowedIds && allowedIds.length === 0) return reply.send({ interviews: [] });
      const invites = await prisma.knowledgeInterviewInvite.findMany({
        where: allowedIds ? { clientId: { in: allowedIds } } : {},
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          clientId: true,
          rootInviteId: true,
          parentInviteId: true,
          recipientName: true,
          respondentRole: true,
          respondentJobRole: true,
          templateKey: true,
          status: true,
          createdAt: true,
          sentAt: true,
          completedAt: true,
          expiresAt: true,
          totalVoiceSeconds: true,
          summaryStatus: true,
        },
      });
      const ids = invites.map((i) => i.id);
      const counts = ids.length
        ? await prisma.okfDraftChange.groupBy({ by: ['inviteId', 'status'], where: { inviteId: { in: ids } }, _count: { _all: true } })
        : [];
      const byInvite = new Map();
      for (const c of counts) {
        const cur = byInvite.get(c.inviteId) || { PENDING: 0, APPROVED: 0, REJECTED: 0 };
        cur[c.status] = c._count._all;
        byInvite.set(c.inviteId, cur);
      }
      const withNames = await attachClientNames(invites);
      return reply.send({
        interviews: withNames.map((i) => ({ ...i, drafts: byInvite.get(i.id) || { PENDING: 0, APPROVED: 0, REJECTED: 0 } })),
      });
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
