import { prisma } from '../../lib/prisma.js';
import { syncPipelineFromWp } from '../../lib/pipelineSync.js';

const PM_ROLES = ['PM', 'OWNER'];

async function requirePmOrOwner(request, reply) {
  if (!PM_ROLES.includes(request.user?.role)) {
    return reply.status(403).send({ message: 'PM or Owner access required' });
  }
}

/** Build WP agent headers matching wpSync.js pattern. */
function wpHeaders(apiKey) {
  return {
    'X-LWA-API-Key': apiKey,
    Accept: 'application/json',
    'User-Agent': 'Localwaves-AgencyOS/1.0 (+https://localwaves; pipeline sync)',
  };
}

/** Status label map */
const STATUS_LABELS = {
  draft: 'Draft',
  pending_pm_review: 'Pending PM Review',
  pm_approved: 'PM Approved',
  pending_client_review: 'Pending Client',
  client_approved: 'Approved',
  changes_requested_by_pm: 'Changes (PM)',
  changes_requested_by_client: 'Changes (Client)',
  cancelled: 'Cancelled',
};

/** Status color map */
const STATUS_COLORS = {
  draft: '#888',
  pending_pm_review: '#f0b849',
  pm_approved: '#f0b849',
  pending_client_review: '#f0b849',
  client_approved: '#00a32a',
  changes_requested_by_pm: '#d63638',
  changes_requested_by_client: '#d63638',
  cancelled: '#888',
};

function formatReview(r) {
  return {
    id: r.id,
    projectId: r.projectId,
    projectName: r.project?.name || '',
    clientName: r.project?.client?.agencyName || null,
    wpPipelineId: r.wpPipelineId,
    wpPostId: r.wpPostId,
    postTitle: r.postTitle,
    wpPostStatus: '',
    status: r.status,
    statusLabel: STATUS_LABELS[r.status] || r.status,
    submittedByName: r.submittedByName,
    submittedById: r.submittedById,
    pmMemberName: r.pmMemberName,
    pmMemberId: r.pmMemberId,
    pmPreviewUrl: r.pmPreviewUrl,
    clientPreviewUrl: r.clientPreviewUrl,
    pmDecision: r.pmDecision,
    pmComment: r.pmComment,
    pmReviewedAt: r.pmReviewedAt || null,
    clientDecision: r.clientDecision,
    clientComment: r.clientComment,
    clientReviewedAt: r.clientReviewedAt || null,
    revisionNumber: r.revisionNumber,
    createdAt: r.createdAt?.toISOString() || null,
    updatedAt: r.updatedAt?.toISOString() || null,
    history: (r.events || []).map((e) => ({
      revisionNumber: e.revisionNumber,
      status: e.status,
      statusLabel: STATUS_LABELS[e.status] || e.status,
      statusColor: STATUS_COLORS[e.status] || '#888',
      pmComment: e.pmComment,
      clientComment: e.clientComment,
      workerNote: e.workerNote,
      pmReviewedAt: e.pmReviewedAt,
      clientReviewedAt: e.clientReviewedAt,
      createdAt: e.createdAt?.toISOString() || null,
      updatedAt: e.createdAt?.toISOString() || null,
    })),
  };
}

export async function pmPipelineRoutes(app) {
  // GET /api/pm/pipeline — read from local Agency OS database
  app.get(
    '/pipeline',
    { onRequest: [app.verifyJwt, requirePmOrOwner] },
    async (request, reply) => {
      try {
        const user = request.user;
        const { projectId, status, includePublished } = request.query || {};

        const where = {};

        // PM sees only their projects, OWNER sees all
        if (user.role === 'PM') {
          where.project = { leadPmId: user.id };
        }

        if (projectId) {
          where.projectId = projectId;
        }

        if (status) {
          where.status = status;
        }

        // By default hide published/cancelled items
        if (includePublished !== 'true') {
          where.isPublished = false;
        }

        const reviews = await prisma.wpContentReview.findMany({
          where,
          include: {
            events: { orderBy: { createdAt: 'desc' } },
            project: {
              select: {
                name: true,
                client: { select: { agencyName: true } },
              },
            },
          },
          orderBy: { updatedAt: 'desc' },
        });

        return reply.send(reviews.map(formatReview));
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to fetch pipeline reviews' });
      }
    }
  );

  // GET /api/pm/pipeline/my-reviews — content reviews where current user is the submitter
  app.get(
    '/pipeline/my-reviews',
    { onRequest: [app.verifyJwt] },
    async (request, reply) => {
      try {
        const userId = request.user.id;

        const reviews = await prisma.wpContentReview.findMany({
          where: {
            submittedById: userId,
            isPublished: false,
          },
          include: {
            events: { orderBy: { createdAt: 'desc' } },
            project: {
              select: {
                name: true,
                client: { select: { agencyName: true } },
              },
            },
          },
          orderBy: { updatedAt: 'desc' },
        });

        return reply.send(reviews.map(formatReview));
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to fetch your content reviews' });
      }
    }
  );

  // POST /api/pm/pipeline/sync — manual trigger to pull from all WP sites
  app.post(
    '/pipeline/sync',
    { onRequest: [app.verifyJwt, requirePmOrOwner] },
    async (request, reply) => {
      try {
        const result = await syncPipelineFromWp();
        return reply.send({ success: true, ...result });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Pipeline sync failed' });
      }
    }
  );

  // POST /api/pm/pipeline/:projectId/:wpPipelineId/review
  app.post(
    '/pipeline/:projectId/:wpPipelineId/review',
    { onRequest: [app.verifyJwt, requirePmOrOwner] },
    async (request, reply) => {
      try {
        const { projectId, wpPipelineId } = request.params;
        const { decision, comment } = request.body || {};

        if (!['approved', 'changes_requested'].includes(decision)) {
          return reply.status(400).send({ message: 'Decision must be "approved" or "changes_requested"' });
        }

        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { wpUrl: true, wpApiKey: true, leadPmId: true },
        });
        if (!project || !project.wpUrl || !project.wpApiKey) {
          return reply.status(404).send({ message: 'Project not found or no WP config' });
        }

        // Access check
        if (request.user.role === 'PM' && project.leadPmId !== request.user.id) {
          return reply.status(403).send({ message: 'Access denied' });
        }

        const baseUrl = project.wpUrl.replace(/\/$/, '');
        const url = `${baseUrl}/wp-json/lwa/v1/pipeline/${wpPipelineId}/pm-review`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            ...wpHeaders(project.wpApiKey),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ decision, comment: comment || '' }),
          signal: AbortSignal.timeout(15000),
        });

        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return reply.status(res.status).send({ message: json.message || 'WP API error' });
        }

        return reply.send(json);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to submit review' });
      }
    }
  );
}
