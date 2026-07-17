import { prisma } from '../../lib/prisma.js';
import { notify } from '../../lib/notificationService.js';
import { syncPipelineFromWp } from '../../lib/pipelineSync.js';
import { STATUS_LABELS, formatHistoryEvent, reviewDisplayUpdatedAt, parseWpDate, contentTypeLabel } from '../../lib/pipelineFormat.js';

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

function formatReview(r) {
  const activityAt = reviewDisplayUpdatedAt(r);
  // Once published, present a distinct "Published" state regardless of the raw
  // WP pipeline status (which can linger at client_approved). Cancelled rows
  // also carry isPublished=true (to hide them from active queues) but must
  // keep their "Cancelled" label.
  const isCancelled = r.status === 'cancelled' || r.lastEventType === 'pipeline_cancelled';
  const effectiveStatus = r.isPublished && !isCancelled ? 'published' : r.status;
  return {
    id: r.id,
    projectId: r.projectId,
    projectName: r.project?.name || '',
    clientName: r.project?.client?.agencyName || null,
    wpPipelineId: r.wpPipelineId,
    wpPostId: r.wpPostId,
    postTitle: r.postTitle,
    wpPostStatus: '',
    status: effectiveStatus,
    statusLabel: STATUS_LABELS[effectiveStatus] || effectiveStatus,
    contentType: r.contentType || null,
    contentTypeLabel: contentTypeLabel(r.contentType),
    isPublished: !!r.isPublished,
    publishedAt: r.publishedAt?.toISOString() || null,
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
    createdAt:
      (r.wpCreatedAt instanceof Date
        ? r.wpCreatedAt
        : parseWpDate(r.wpCreatedAt)
      )?.toISOString() ||
      r.createdAt?.toISOString() ||
      null,
    updatedAt: activityAt?.toISOString() || null,
    history: (r.events || [])
      .filter((e) => e.eventType !== 'pipeline_resend_notification')
      .map((e) => formatHistoryEvent(e)),
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
          orderBy: [{ wpUpdatedAt: 'desc' }, { updatedAt: 'desc' }],
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
          orderBy: [{ wpUpdatedAt: 'desc' }, { updatedAt: 'desc' }],
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

  // POST /api/pm/pipeline/:projectId/refresh — self-heal one project's rows by
  // re-pulling from WP (refreshes expired preview URLs), then return the fresh
  // reviews for that project.
  app.post(
    '/pipeline/:projectId/refresh',
    { onRequest: [app.verifyJwt, requirePmOrOwner] },
    async (request, reply) => {
      try {
        const { projectId } = request.params;

        if (request.user.role === 'PM') {
          const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { leadPmId: true },
          });
          if (!project) return reply.status(404).send({ message: 'Project not found' });
          if (project.leadPmId !== request.user.id) {
            return reply.status(403).send({ message: 'Access denied' });
          }
        }

        await syncPipelineFromWp({ projectId });

        const where = { projectId };
        if (request.user.role === 'PM') where.project = { leadPmId: request.user.id };

        const reviews = await prisma.wpContentReview.findMany({
          where,
          include: {
            events: { orderBy: { createdAt: 'desc' } },
            project: { select: { name: true, client: { select: { agencyName: true } } } },
          },
          orderBy: [{ wpUpdatedAt: 'desc' }, { updatedAt: 'desc' }],
        });
        return reply.send(reviews.map(formatReview));
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to refresh pipeline' });
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

        // OWNER acts as admin — bypass the WP pipeline state-machine guard so
        // approve / request-changes never fails with "This action is not allowed
        // in the current state." regardless of the current pipeline status. The
        // reviewer name is forwarded so the WP plugin can prefix the stored
        // comment with [Admin override by <reviewer>] for the audit trail.
        const isAdmin = request.user.role === 'OWNER';
        const wpBody = { decision, comment: comment || '' };
        if (isAdmin) {
          wpBody.as_admin = true;
          if (request.user.name) wpBody.reviewer = request.user.name;
          request.log.info(
            { pipelineId: wpPipelineId, projectId, reviewer: request.user.name, decision },
            'Admin override on pipeline pm-review'
          );
        }

        const baseUrl = project.wpUrl.replace(/\/$/, '');
        const url = `${baseUrl}/wp-json/lwa/v1/pipeline/${wpPipelineId}/pm-review`;

        let res;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: {
              ...wpHeaders(project.wpApiKey),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(wpBody),
            signal: AbortSignal.timeout(15000),
          });
        } catch (fetchErr) {
          // Network / timeout / DNS failure talking to WP — surface a clean
          // error instead of leaking the raw stack trace.
          request.log.error({ err: fetchErr, url }, 'WP pm-review fetch failed');
          const isTimeout = fetchErr?.name === 'TimeoutError' || fetchErr?.name === 'AbortError';
          return reply.status(502).send({
            message: isTimeout
              ? 'WordPress did not respond in time. Please try again.'
              : 'Unable to reach WordPress site.',
          });
        }

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

  // POST /api/pm/pipeline/:projectId/:wpPipelineId/publish
  app.post(
    '/pipeline/:projectId/:wpPipelineId/publish',
    { onRequest: [app.verifyJwt, requirePmOrOwner] },
    async (request, reply) => {
      try {
        const { projectId, wpPipelineId } = request.params;

        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { wpUrl: true, wpApiKey: true, leadPmId: true, name: true, clientId: true },
        });
        if (!project || !project.wpUrl || !project.wpApiKey) {
          return reply.status(404).send({ message: 'Project not found or no WP config' });
        }

        // Access check
        if (request.user.role === 'PM' && project.leadPmId !== request.user.id) {
          return reply.status(403).send({ message: 'Access denied' });
        }

        const baseUrl = project.wpUrl.replace(/\/$/, '');
        const url = `${baseUrl}/wp-json/lwa/v1/pipeline/${wpPipelineId}/publish`;

        let res;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: {
              ...wpHeaders(project.wpApiKey),
              'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(15000),
          });
        } catch (fetchErr) {
          request.log.error({ err: fetchErr, url }, 'WP publish fetch failed');
          const isTimeout = fetchErr?.name === 'TimeoutError' || fetchErr?.name === 'AbortError';
          return reply.status(502).send({
            message: isTimeout
              ? 'WordPress did not respond in time. Please try again.'
              : 'Unable to reach WordPress site.',
          });
        }

        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return reply.status(res.status).send({ message: json.message || 'WP API error' });
        }

        // Mark the review published in the OS immediately so the state is
        // correct even if the async WP webhook is dropped. Idempotent: skip if
        // it is already published so we don't clobber the original publishedAt.
        try {
          const pipelineId = Number(wpPipelineId);
          const existing = await prisma.wpContentReview.findUnique({
            where: { projectId_wpPipelineId: { projectId, wpPipelineId: pipelineId } },
            select: { id: true, isPublished: true, revisionNumber: true },
          });
          if (existing && !existing.isPublished) {
            const updated = await prisma.wpContentReview.update({
              where: { id: existing.id },
              data: {
                isPublished: true,
                publishedAt: new Date(),
                status: 'published',
                lastEventType: 'pipeline_published',
              },
            });
            await prisma.wpContentReviewEvent.create({
              data: {
                contentReviewId: existing.id,
                eventType: 'pipeline_published',
                status: 'published',
                revisionNumber: existing.revisionNumber || 1,
              },
            });

            // Best-effort content_published notification (Owners + Client
            // users). The WP webhook guards on isPublished, so whichever path
            // marks it published first is the single source of the notice.
            try {
              const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));
              const owners = await prisma.user.findMany({
                where: { role: 'OWNER', isActive: true },
                select: { id: true },
              });
              let clientUserIds = [];
              if (project.clientId) {
                const clientUsers = await prisma.clientUser.findMany({
                  where: { clientId: project.clientId },
                  select: { userId: true },
                });
                clientUserIds = clientUsers.map((cu) => cu.userId);
              }
              const recipients = uniq([...owners.map((o) => o.id), ...clientUserIds]);
              if (recipients.length > 0) {
                const nowFormatted = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
                notify({
                  slug: 'content_published',
                  recipientIds: recipients,
                  variables: {
                    postTitle: updated.postTitle,
                    contentTitle: updated.postTitle,
                    projectName: project.name || '',
                    postType: contentTypeLabel(updated.contentType) || 'Page',
                    submittedBy: updated.submittedByName || 'Team member',
                    submittedAt: nowFormatted,
                    aiSummary: updated.aiSummary || '',
                  },
                  actionUrl: updated.clientPreviewUrl || updated.pmPreviewUrl || `/portal/admin/projects/${projectId}?tab=content-reviews`,
                  metadata: { contentReviewId: updated.id, projectId },
                }).catch(() => {});
              }
            } catch (notifyErr) {
              request.log.error({ err: notifyErr }, 'Publish notification failed');
            }
          }
        } catch (dbErr) {
          // Non-fatal: the WP webhook / periodic sync will reconcile.
          request.log.error({ err: dbErr }, 'Local publish state update failed');
        }

        return reply.send(json);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to publish post' });
      }
    }
  );
}
