import { prisma } from '../../lib/prisma.js';
import { notify } from '../../lib/notificationService.js';
import { syncPipelineFromWp } from '../../lib/pipelineSync.js';
import { recordPipelineTombstone } from '../../lib/pipelineReviewGuard.js';
import {
  STATUS_LABELS,
  STATUS_COLORS,
  formatHistoryEvent,
  reviewDisplayUpdatedAt,
  parseWpDate,
  contentTypeLabel,
  clientDecisionLabel,
  eventDisplayAt,
} from '../../lib/pipelineFormat.js';

function reviewStatusLabel(status, clientDecision) {
  if (status === 'changes_requested_by_client' && clientDecision === 'changes_publish') {
    return clientDecisionLabel('changes_publish') || 'Minor changes — then publish';
  }
  if (status === 'changes_requested_by_client' && clientDecision === 'changes_requested') {
    return clientDecisionLabel('changes_requested') || STATUS_LABELS[status] || status;
  }
  return STATUS_LABELS[status] || status;
}

const PM_ROLES = ['PM', 'OWNER'];
const STAFF_ROLES = ['OWNER', 'PM', 'TEAM_MEMBER', 'CONTRACTOR'];

async function requirePmOrOwner(request, reply) {
  if (!PM_ROLES.includes(request.user?.role)) {
    return reply.status(403).send({ message: 'PM or Owner access required' });
  }
}

/**
 * Any active staff user, or a CLIENT linked to the review's project,
 * can read/post comments on the unified review timeline.
 */
async function requirePipelineCommentAccess(request, reply) {
  const role = request.user?.role;
  if (!request.user?.id) {
    return reply.status(401).send({ message: 'Authentication required' });
  }
  if (STAFF_ROLES.includes(role)) return;

  if (role !== 'CLIENT') {
    return reply.status(403).send({ message: 'Access required' });
  }
  const { projectId } = request.params;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { clientId: true },
  });
  if (!project) {
    return reply.status(404).send({ message: 'Project not found' });
  }
  const link = await prisma.clientUser.findFirst({
    where: { userId: request.user.id, clientId: project.clientId },
    select: { id: true },
  });
  if (!link) {
    return reply.status(403).send({ message: 'No access to this project' });
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

/**
 * Abort OS→WP sooner than typical edge proxy_read_timeout so Fastify can
 * always return CORS-safe JSON (502) before the browser connection is reset.
 * Kept under ~5s so common edge/nginx read timeouts do not drop the browser
 * connection as a bare "Failed to fetch".
 */
const WP_MUTATION_TIMEOUT_MS = 4500;

/** Short budget for a best-effort preview-URL heal after a failed mutate. */
const WP_HEAL_TIMEOUT_MS = 2000;

/**
 * Best-effort: pull PM/client preview URLs for one pipeline from WordPress.
 * Used when regenerate times out/fails so OS can still backfill any URLs WP
 * is able to display (or when legacy rows omit token_plain until regenerate).
 */
async function fetchWpPipelinePreviewUrls({ baseUrl, apiKey, pipelineId, wpPostId }) {
  const headers = wpHeaders(apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WP_HEAL_TIMEOUT_MS);
  try {
    let item = null;
    if (wpPostId) {
      const res = await fetch(`${baseUrl}/wp-json/lwa/v1/pipeline/${wpPostId}`, {
        headers,
        signal: controller.signal,
      });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (json && Number(json.id) === pipelineId) item = json;
      }
    }
    if (!item) {
      const res = await fetch(
        `${baseUrl}/wp-json/lwa/v1/pipeline?page=1&per_page=100`,
        { headers, signal: controller.signal }
      );
      if (!res.ok) return null;
      const json = await res.json().catch(() => null);
      const batch = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
      item = batch.find((p) => Number(p.id) === pipelineId) || null;
    }
    if (!item) return null;
    const pmPreviewUrl = String(item.pmPreviewUrl || '').slice(0, 1000) || null;
    const clientPreviewUrl = String(item.clientPreviewUrl || '').slice(0, 1000) || null;
    if (!pmPreviewUrl && !clientPreviewUrl) return null;
    return { pmPreviewUrl, clientPreviewUrl };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function commentRoleLabel(role) {
  if (role === 'OWNER') return 'Admin';
  if (role === 'CLIENT') return 'Client';
  if (role === 'PM') return 'PM';
  if (role === 'TEAM_MEMBER') return 'Worker';
  if (role === 'CONTRACTOR') return 'Contractor';
  return role || 'User';
}

/** Format a WpContentReviewComment (+ user) for the unified timeline API. */
function formatOsComment(c) {
  const createdAt = c.createdAt instanceof Date ? c.createdAt : new Date(c.createdAt);
  const updatedAt = c.updatedAt instanceof Date ? c.updatedAt : new Date(c.updatedAt);
  const edited =
    updatedAt &&
    createdAt &&
    !Number.isNaN(updatedAt.getTime()) &&
    !Number.isNaN(createdAt.getTime()) &&
    updatedAt.getTime() - createdAt.getTime() > 1000;

  return {
    id: c.id,
    source: 'os_comment',
    role: commentRoleLabel(c.user?.role),
    authorName: c.user?.name || 'User',
    authorId: c.userId,
    decision: null,
    revisionNumber: null,
    content: c.content,
    workerNote: null,
    pmComment: null,
    clientComment: null,
    createdAt: createdAt.toISOString(),
    editedAt: edited ? updatedAt.toISOString() : null,
    eventType: null,
    status: null,
    statusLabel: 'Comment',
    statusColor: '#64748b',
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
    statusLabel: reviewStatusLabel(effectiveStatus, r.clientDecision),
    contentType: r.contentType || null,
    contentTypeLabel: contentTypeLabel(r.contentType),
    parentWpPostId: r.parentWpPostId ?? null,
    updateMode: r.parentWpPostId != null,
    isPublished: !!r.isPublished,
    publishedAt: r.publishedAt?.toISOString() || null,
    submittedByName: r.submittedByName,
    submittedById: r.submittedById,
    assignedWorkerId: r.assignedWorkerId || null,
    assignedWorkerName: r.assignedWorkerName || null,
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
    workerNote: r.workerNote || null,
    aiSummary: r.aiSummary || null,
    description: r.description || r.workerNote || r.aiSummary || null,
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

        // PM sees projects they lead or secondary-PM; OWNER sees all
        if (user.role === 'PM') {
          where.project = {
            OR: [
              { leadPmId: user.id },
              { client: { secondaryPmId: user.id } },
            ],
          };
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

  // GET /api/pm/pipeline/my-reviews — assigned, submitted, or commented-on by me
  app.get(
    '/pipeline/my-reviews',
    { onRequest: [app.verifyJwt] },
    async (request, reply) => {
      try {
        const userId = request.user.id;
        const includePublished = request.query?.includePublished === 'true';

        const reviews = await prisma.wpContentReview.findMany({
          where: {
            ...(includePublished ? {} : { isPublished: false }),
            OR: [
              { assignedWorkerId: userId },
              { submittedById: userId },
              { comments: { some: { userId } } },
            ],
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

  // PATCH /api/pm/pipeline/:projectId/:wpPipelineId/assign — Admin/PM assign worker
  app.patch(
    '/pipeline/:projectId/:wpPipelineId/assign',
    { onRequest: [app.verifyJwt, requirePmOrOwner] },
    async (request, reply) => {
      try {
        const { projectId, wpPipelineId } = request.params;
        const pipelineId = Number(wpPipelineId);
        if (!pipelineId) {
          return reply.status(400).send({ message: 'Invalid pipeline id' });
        }

        const workerUserId =
          request.body?.workerUserId === null || request.body?.workerUserId === ''
            ? null
            : String(request.body?.workerUserId || '').trim() || null;

        const existing = await prisma.wpContentReview.findUnique({
          where: { projectId_wpPipelineId: { projectId, wpPipelineId: pipelineId } },
          select: {
            id: true,
            postTitle: true,
            assignedWorkerId: true,
            project: { select: { name: true, leadPmId: true, client: { select: { secondaryPmId: true } } } },
          },
        });
        if (!existing) {
          return reply.status(404).send({ message: 'Review not found' });
        }

        // PMs may only assign on their own projects
        if (request.user.role === 'PM') {
          const lead = existing.project?.leadPmId === request.user.id;
          const secondary = existing.project?.client?.secondaryPmId === request.user.id;
          if (!lead && !secondary) {
            return reply.status(403).send({ message: 'Not allowed to assign on this project' });
          }
        }

        let assignedWorkerId = null;
        let assignedWorkerName = null;
        if (workerUserId) {
          const worker = await prisma.user.findFirst({
            where: {
              id: workerUserId,
              isActive: true,
              role: { in: ['TEAM_MEMBER', 'CONTRACTOR', 'PM'] },
            },
            select: { id: true, name: true },
          });
          if (!worker) {
            return reply.status(400).send({ message: 'Worker not found or not assignable' });
          }
          assignedWorkerId = worker.id;
          assignedWorkerName = worker.name || 'Worker';
        }

        const updated = await prisma.wpContentReview.update({
          where: { id: existing.id },
          data: { assignedWorkerId, assignedWorkerName },
        });

        if (
          assignedWorkerId &&
          assignedWorkerId !== existing.assignedWorkerId &&
          assignedWorkerId !== request.user.id
        ) {
          try {
            await notify({
              slug: 'content_submitted_for_review',
              recipientIds: [assignedWorkerId],
              variables: {
                postTitle: existing.postTitle || 'Content review',
                projectName: existing.project?.name || '',
                submittedByName: request.user.name || 'PM',
              },
              actionUrl: '/portal/pm/content-reviews',
            });
          } catch (notifyErr) {
            request.log.warn({ err: notifyErr }, 'Assign notify failed');
          }
        }

        return reply.send({
          assignedWorkerId: updated.assignedWorkerId,
          assignedWorkerName: updated.assignedWorkerName,
        });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to assign worker' });
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

  // Soft-await budget so we usually return 200 with real URLs/errors before the
  // edge kills the browser connection. Never use HTTP 502 (CORS stripped).
  const RENEW_SOFT_TIMEOUT_MS = Number(process.env.PIPELINE_RENEW_SOFT_TIMEOUT_MS || 3500);

  // POST /api/pm/pipeline/:projectId/:wpPipelineId/renew-preview
  // Rotate PM + client preview tokens on WordPress, persist URLs on OS.
  // Race WP work ~3.5s → 200 success | 200 success:false (real code/message) |
  // 202 regenerating (background). Legacy alias: regenerate-preview-links.
  const renewPreviewHandler = async (request, reply) => {
      try {
        const { projectId, wpPipelineId } = request.params;

        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { wpUrl: true, wpApiKey: true, leadPmId: true },
        });
        if (!project || !project.wpUrl || !project.wpApiKey) {
          return reply.status(404).send({ message: 'Project not found or no WP config' });
        }

        if (request.user.role === 'PM' && project.leadPmId !== request.user.id) {
          return reply.status(403).send({ message: 'Access denied' });
        }

        const pipelineId = Number(wpPipelineId);
        if (!pipelineId) {
          return reply.status(400).send({ message: 'Invalid pipeline id' });
        }

        const existing = await prisma.wpContentReview.findUnique({
          where: { projectId_wpPipelineId: { projectId, wpPipelineId: pipelineId } },
          select: {
            id: true,
            isPublished: true,
            status: true,
            wpPostId: true,
            revisionNumber: true,
          },
        });
        if (!existing) {
          return reply.status(404).send({ message: 'Content review not found' });
        }
        if (existing.isPublished || existing.status === 'cancelled' || existing.status === 'published') {
          return reply.status(400).send({
            message: 'Review links can only be regenerated while the pipeline is active.',
          });
        }

        const baseUrl = project.wpUrl.replace(/\/$/, '');
        // change-type first — already known to pass Milwaukee Signs WAF.
        const wpAttempts = [
          {
            method: 'POST',
            url: `${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/change-type`,
            body: JSON.stringify({ rotate_links: true }),
          },
          { method: 'POST', url: `${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/rotate`, body: '{}' },
          { method: 'GET', url: `${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/rotate` },
          {
            method: 'POST',
            url: `${baseUrl}/?rest_route=/lwa/v1/pipeline/${pipelineId}/rotate`,
            body: '{}',
          },
          { method: 'POST', url: `${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/renew-preview`, body: '{}' },
          { method: 'POST', url: `${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/regenerate-links`, body: '{}' },
        ];

        const reviewInclude = {
          events: { orderBy: { createdAt: 'desc' }, take: 50 },
          project: { select: { name: true, client: { select: { agencyName: true } } } },
        };

        const recordRenewFailed = async (message, code = 'WP_RENEW_FAILED') => {
          const msg = String(message || 'Preview link renew failed').slice(0, 500);
          try {
            await prisma.wpContentReviewEvent.create({
              data: {
                contentReviewId: existing.id,
                eventType: 'pipeline_links_renew_failed',
                status: existing.status || 'pending_pm_review',
                revisionNumber: existing.revisionNumber || 1,
                message: msg,
              },
            });
            await prisma.wpContentReview.update({
              where: { id: existing.id },
              data: { lastEventType: 'pipeline_links_renew_failed' },
            });
          } catch (err) {
            request.log.error({ err, reviewId: existing.id }, 'Failed to record renew_failed event');
          }
          return { ok: false, body: { success: false, code, message: msg } };
        };

        const tryHealPreviewUrls = async () => {
          const healed = await fetchWpPipelinePreviewUrls({
            baseUrl,
            apiKey: project.wpApiKey,
            pipelineId,
            wpPostId: existing.wpPostId || null,
          });
          if (!healed) return null;
          return prisma.wpContentReview.update({
            where: { id: existing.id },
            data: {
              ...(healed.pmPreviewUrl ? { pmPreviewUrl: healed.pmPreviewUrl } : {}),
              ...(healed.clientPreviewUrl ? { clientPreviewUrl: healed.clientPreviewUrl } : {}),
              wpUpdatedAt: new Date(),
            },
            include: reviewInclude,
          });
        };

        const callWpRenew = async ({ method, url, body }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), WP_MUTATION_TIMEOUT_MS);
          try {
            return await fetch(url, {
              method,
              headers: {
                ...wpHeaders(project.wpApiKey),
                ...(body ? { 'Content-Type': 'application/json' } : {}),
              },
              ...(body ? { body } : {}),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }
        };

        const runRegenerateWork = async () => {
          let res = null;
          let lastFetchErr = null;
          let usedUrl = wpAttempts[0].url;
          let sawMissingRoute = false;
          let lastWpMsg = '';

          for (let i = 0; i < wpAttempts.length; i += 1) {
            const attempt = wpAttempts[i];
            usedUrl = attempt.url;
            const wpStartedAt = Date.now();
            try {
              res = await callWpRenew(attempt);
              lastFetchErr = null;
              if (!res.ok) {
                const probe = await res.clone().json().catch(() => ({}));
                const wpCode = probe.code || probe.data?.status;
                const wpMsg = probe.message || '';
                lastWpMsg = wpMsg;
                const missingRoute =
                  res.status === 404 ||
                  wpCode === 'rest_no_route' ||
                  /no route was found/i.test(wpMsg);
                if (missingRoute) {
                  sawMissingRoute = true;
                  if (i < wpAttempts.length - 1) {
                    request.log.warn(
                      { url: attempt.url, method: attempt.method, status: res.status },
                      'WP rotate path missing; trying next'
                    );
                    continue;
                  }
                }
              }
              break;
            } catch (fetchErr) {
              lastFetchErr = fetchErr;
              const elapsedMs = Date.now() - wpStartedAt;
              request.log.error(
                {
                  err: fetchErr,
                  url: attempt.url,
                  method: attempt.method,
                  elapsedMs,
                  timeoutMs: WP_MUTATION_TIMEOUT_MS,
                },
                'WP rotate/renew fetch failed'
              );
              if (i < wpAttempts.length - 1) continue;
            }
          }

          if (lastFetchErr && !res) {
            const isTimeout =
              lastFetchErr?.name === 'TimeoutError' || lastFetchErr?.name === 'AbortError';
            const isReset = /ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(
              String(lastFetchErr?.message || lastFetchErr?.cause?.message || '')
            );
            const healedRow = await tryHealPreviewUrls().catch(() => null);
            if (healedRow?.pmPreviewUrl || healedRow?.clientPreviewUrl) {
              return {
                ok: true,
                body: {
                  success: true,
                  healedFromSync: true,
                  pmPreviewUrl: healedRow.pmPreviewUrl,
                  clientPreviewUrl: healedRow.clientPreviewUrl,
                  pipeline: formatReview(healedRow),
                  message: isTimeout
                    ? 'WordPress did not finish rotating links in time; refreshed existing preview URLs from the site.'
                    : 'Could not reach WordPress to rotate links; refreshed existing preview URLs from the site.',
                },
              };
            }
            if (isTimeout) {
              return recordRenewFailed(
                'WordPress did not respond in time while rotating preview links. Please try again.',
                'WP_TIMEOUT'
              );
            }
            return recordRenewFailed(
              isReset
                ? 'WordPress connection was reset while rotating preview links (site firewall/WAF). Ask the host to allow Agency OS API calls to /wp-json/lwa/v1/pipeline/*/change-type and /rotate.'
                : `Unable to reach WordPress to rotate preview links: ${lastFetchErr?.message || 'network error'}`,
              'WP_CONNECTION_RESET'
            );
          }

          const json = await res.json().catch(() => ({}));
          if (!res.ok) {
            const wpCode = json.code || json.data?.status;
            const wpMsg = json.message || lastWpMsg || '';
            const missingRoute =
              sawMissingRoute ||
              res.status === 404 ||
              wpCode === 'rest_no_route' ||
              /no route was found/i.test(wpMsg);
            const healedRow = await tryHealPreviewUrls().catch(() => null);
            if (healedRow?.pmPreviewUrl || healedRow?.clientPreviewUrl) {
              return {
                ok: true,
                body: {
                  success: true,
                  healedFromSync: true,
                  pmPreviewUrl: healedRow.pmPreviewUrl,
                  clientPreviewUrl: healedRow.clientPreviewUrl,
                  pipeline: formatReview(healedRow),
                  message: missingRoute
                    ? 'WordPress is missing the rotate endpoint; refreshed existing preview URLs. Update the Localwave Agent plugin to 1.9.8+ to rotate links.'
                    : wpMsg ||
                      'WordPress could not regenerate preview links; refreshed existing URLs instead.',
                },
              };
            }
            if (missingRoute) {
              return recordRenewFailed(
                'WordPress is missing the rotate / change-type rotate_links endpoint. Update the Localwave Agent (agency-os-bridge) plugin on that site to 1.9.8+, then try again.',
                'PLUGIN_MISSING_ROUTE'
              );
            }
            return recordRenewFailed(
              wpMsg || `WordPress could not regenerate preview links (HTTP ${res.status}).`,
              'WP_RENEW_FAILED'
            );
          }

          let pmPreviewUrl =
            String(json.pmPreviewUrl || json.pipeline?.pmPreviewUrl || '').slice(0, 1000) || null;
          let clientPreviewUrl =
            String(json.clientPreviewUrl || json.pipeline?.clientPreviewUrl || '').slice(0, 1000) ||
            null;

          if (!pmPreviewUrl && !clientPreviewUrl) {
            const healed = await fetchWpPipelinePreviewUrls({
              baseUrl,
              apiKey: project.wpApiKey,
              pipelineId,
              wpPostId: existing.wpPostId || null,
            }).catch(() => null);
            if (healed) {
              pmPreviewUrl = healed.pmPreviewUrl;
              clientPreviewUrl = healed.clientPreviewUrl;
            }
          }

          if (!pmPreviewUrl && !clientPreviewUrl) {
            return recordRenewFailed(
              'WordPress accepted the renew request but returned no preview URLs (legacy links without display tokens). Open the page in WP admin and regenerate preview links there, or re-submit the pipeline.',
              'WP_EMPTY_URLS'
            );
          }

          const updated = await prisma.wpContentReview.update({
            where: { id: existing.id },
            data: {
              ...(pmPreviewUrl ? { pmPreviewUrl } : {}),
              ...(clientPreviewUrl ? { clientPreviewUrl } : {}),
              lastEventType: 'pipeline_links_regenerated',
              wpUpdatedAt: new Date(),
            },
            include: reviewInclude,
          });

          try {
            await prisma.wpContentReviewEvent.create({
              data: {
                contentReviewId: existing.id,
                eventType: 'pipeline_links_regenerated',
                status: existing.status || 'pending_pm_review',
                revisionNumber: existing.revisionNumber || 1,
                message: 'Review links regenerated',
              },
            });
          } catch {
            // non-fatal
          }

          request.log.info(
            { reviewId: existing.id, usedUrl, pmPreviewUrl: !!updated.pmPreviewUrl },
            'Preview links renewed'
          );

          return {
            ok: true,
            body: {
              success: true,
              pmPreviewUrl: updated.pmPreviewUrl,
              clientPreviewUrl: updated.clientPreviewUrl,
              pipeline: formatReview(updated),
            },
          };
        };

        const workPromise = runRegenerateWork();
        const outcome = await Promise.race([
          workPromise.then(
            (result) => ({ kind: 'done', result }),
            (err) => ({ kind: 'error', err }),
          ),
          new Promise((resolve) =>
            setTimeout(() => resolve({ kind: 'pending' }), RENEW_SOFT_TIMEOUT_MS),
          ),
        ]);

        if (outcome.kind === 'pending') {
          workPromise
            .then((result) => {
              if (result?.ok) {
                request.log.info(
                  {
                    reviewId: existing.id,
                    projectId,
                    wpPipelineId: pipelineId,
                    healedFromSync: !!result.body?.healedFromSync,
                  },
                  'Preview links renew finished after soft timeout',
                );
              } else {
                request.log.warn(
                  {
                    reviewId: existing.id,
                    projectId,
                    wpPipelineId: pipelineId,
                    code: result?.body?.code,
                    message: result?.body?.message,
                  },
                  'Preview links renew failed after soft timeout',
                );
              }
            })
            .catch(async (err) => {
              request.log.error(
                { err, reviewId: existing.id, projectId, wpPipelineId: pipelineId },
                'Preview links renew crashed after soft timeout',
              );
              await recordRenewFailed(
                err?.message || 'Preview link renew crashed unexpectedly.',
                'WP_RENEW_FAILED'
              ).catch(() => null);
            });

          return reply.status(202).send({
            status: 'regenerating',
            projectId,
            wpPipelineId: pipelineId,
            reviewId: existing.id,
            message: 'Review links are regenerating. Poll until preview URLs appear.',
          });
        }

        if (outcome.kind === 'error') {
          request.log.error(outcome.err);
          // Never 502 — return CORS-safe JSON the browser can read.
          return reply.send({
            success: false,
            code: 'WP_RENEW_FAILED',
            message: outcome.err?.message || 'Failed to regenerate preview links',
          });
        }

        const { result } = outcome;
        // Always HTTP 200 with success true/false so edge proxies keep CORS headers.
        return reply.send(result?.body || {
          success: false,
          code: 'WP_RENEW_FAILED',
          message: 'Failed to regenerate preview links',
        });
      } catch (err) {
        request.log.error(err);
        return reply.send({
          success: false,
          code: 'WP_RENEW_FAILED',
          message: err?.message || 'Failed to regenerate preview links',
        });
      }
  };

  app.post(
    '/pipeline/:projectId/:wpPipelineId/renew-preview',
    { onRequest: [app.verifyJwt, requirePmOrOwner] },
    renewPreviewHandler
  );
  app.post(
    '/pipeline/:projectId/:wpPipelineId/regenerate-preview-links',
    { onRequest: [app.verifyJwt, requirePmOrOwner] },
    renewPreviewHandler
  );

  // POST /api/pm/pipeline/:projectId/:wpPipelineId/change-type
  // Path deliberately avoids the literal token "content-type" — some hosts'
  // WAF/ModSecurity rules reset connections to URLs containing it (same reason
  // the WP plugin uses /change-type).
  // Change a review's content type standalone (no resubmit). Round-trips to
  // WordPress (single source of truth); WP fires the pipeline_content_type_changed
  // webhook which creates the timeline event, so we only optimistically mirror
  // the contentType locally here for immediacy.
  app.post(
    '/pipeline/:projectId/:wpPipelineId/change-type',
    { onRequest: [app.verifyJwt, requirePmOrOwner] },
    async (request, reply) => {
      try {
        const { projectId, wpPipelineId } = request.params;
        const contentType = String(request.body?.contentType || '').trim();
        if (!contentType) {
          return reply.status(400).send({ message: 'contentType is required' });
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

        // Guard: only allow while the review is active (not published/cancelled).
        const pipelineId = Number(wpPipelineId);
        const existing = await prisma.wpContentReview.findUnique({
          where: { projectId_wpPipelineId: { projectId, wpPipelineId: pipelineId } },
          select: { id: true, isPublished: true, status: true },
        });
        if (existing && (existing.isPublished || existing.status === 'cancelled')) {
          return reply.status(400).send({ message: 'Content type can only be changed while the review is active.' });
        }

        const baseUrl = project.wpUrl.replace(/\/$/, '');
        // NOTE: the WP path deliberately avoids the literal token "content-type"
        // because some hosts' WAF/ModSecurity rules reset connections to URLs
        // containing it (flagged as header-injection), causing ECONNRESET.
        const url = `${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/change-type`;

        let res;
        const wpStartedAt = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), WP_MUTATION_TIMEOUT_MS);
          try {
            res = await fetch(url, {
              method: 'POST',
              headers: {
                ...wpHeaders(project.wpApiKey),
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ content_type: contentType, actor: request.user.name || '' }),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }
        } catch (fetchErr) {
          const elapsedMs = Date.now() - wpStartedAt;
          request.log.error(
            { err: fetchErr, url, elapsedMs, timeoutMs: WP_MUTATION_TIMEOUT_MS },
            'WP content-type fetch failed'
          );
          const isTimeout = fetchErr?.name === 'TimeoutError' || fetchErr?.name === 'AbortError';
          return reply.status(502).send({
            message: isTimeout
              ? 'WordPress did not respond in time. Please try again.'
              : 'Unable to reach WordPress site. Check the project WP URL and that the Localwave Agent plugin is active.',
          });
        }

        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          const wpCode = json.code || json.data?.status;
          const wpMsg = json.message || '';
          const missingRoute =
            res.status === 404 ||
            wpCode === 'rest_no_route' ||
            /no route was found/i.test(wpMsg);
          return reply
            .status(missingRoute ? 502 : res.status >= 400 && res.status < 600 ? res.status : 502)
            .send({
              message: missingRoute
                ? 'WordPress is missing the change-type endpoint. Update the Localwave Agent (agency-os-bridge) plugin on that site to 1.9.4+, then try again.'
                : wpMsg || 'WordPress could not change the content type.',
            });
        }

        // Optimistically mirror the new type locally (the webhook adds the event).
        if (existing) {
          try {
            await prisma.wpContentReview.update({
              where: { id: existing.id },
              data: { contentType },
            });
          } catch (dbErr) {
            request.log.error({ err: dbErr }, 'Local content-type update failed');
          }
        }

        return reply.send(json);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to change content type' });
      }
    }
  );

  // DELETE /api/pm/pipeline/:projectId/:wpPipelineId
  // Owner-only: hard-delete pipeline on WordPress and in OS (events cascade).
  app.delete(
    '/pipeline/:projectId/:wpPipelineId',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      try {
        const { projectId, wpPipelineId } = request.params;
        const pipelineId = Number(wpPipelineId);
        if (!pipelineId) {
          return reply.status(400).send({ message: 'Invalid pipeline id' });
        }

        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { wpUrl: true, wpApiKey: true },
        });
        if (!project) {
          return reply.status(404).send({ message: 'Project not found' });
        }

        const existing = await prisma.wpContentReview.findUnique({
          where: { projectId_wpPipelineId: { projectId, wpPipelineId: pipelineId } },
          select: { id: true },
        });

        // Best-effort WP cancel/delete (force so approved rows can be removed).
        if (project.wpUrl && project.wpApiKey) {
          const baseUrl = project.wpUrl.replace(/\/$/, '');
          const url = `${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/cancel`;
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: {
                ...wpHeaders(project.wpApiKey),
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ force: true, as_admin: true }),
              signal: AbortSignal.timeout(15000),
            });
            // 404 / not_found → already gone on WP; still wipe OS.
            if (!res.ok && res.status !== 404) {
              const json = await res.json().catch(() => ({}));
              request.log.warn(
                { status: res.status, url, message: json.message },
                'WP pipeline cancel returned a non-404 error; OS delete will still proceed'
              );
              // Continue to OS delete unless WP is unreachable in a hard way.
              if (res.status >= 500) {
                return reply.status(502).send({
                  message: json.message || 'Unable to delete pipeline on WordPress.',
                });
              }
            }
          } catch (fetchErr) {
            request.log.error({ err: fetchErr, url }, 'WP pipeline delete failed');
            // If OS row exists, still delete it so Owner can clean stuck reviews.
          }
        }

        await recordPipelineTombstone({
          projectId,
          wpPipelineId: pipelineId,
          deletedById: request.user?.id || null,
        });

        if (existing) {
          await prisma.wpContentReview.delete({ where: { id: existing.id } });
        }

        return reply.send({ success: true });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to delete pipeline' });
      }
    }
  );

  // PATCH description (OS-editable, task-style).
  app.patch(
    '/pipeline/:projectId/:wpPipelineId/description',
    { onRequest: [app.verifyJwt, requirePipelineCommentAccess] },
    async (request, reply) => {
      try {
        const { projectId, wpPipelineId } = request.params;
        const pipelineId = Number(wpPipelineId);
        const description =
          request.body?.description == null
            ? null
            : String(request.body.description).slice(0, 10000);

        const existing = await prisma.wpContentReview.findUnique({
          where: { projectId_wpPipelineId: { projectId, wpPipelineId: pipelineId } },
          select: { id: true },
        });
        if (!existing) {
          return reply.status(404).send({ message: 'Review not found' });
        }

        const updated = await prisma.wpContentReview.update({
          where: { id: existing.id },
          data: { description: description && description.trim() ? description.trim() : null },
          select: { description: true, workerNote: true, aiSummary: true },
        });

        return reply.send({
          description: updated.description || updated.workerNote || updated.aiSummary || null,
        });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to update description' });
      }
    }
  );

  // GET/POST comments: unified timeline (all review events + OS freeform comments).
  app.get(
    '/pipeline/:projectId/:wpPipelineId/comments',
    { onRequest: [app.verifyJwt, requirePipelineCommentAccess] },
    async (request, reply) => {
      try {
        const { projectId, wpPipelineId } = request.params;
        const pipelineId = Number(wpPipelineId);
        const review = await prisma.wpContentReview.findUnique({
          where: { projectId_wpPipelineId: { projectId, wpPipelineId: pipelineId } },
          include: {
            events: { orderBy: { createdAt: 'asc' } },
            comments: {
              orderBy: { createdAt: 'asc' },
              include: { user: { select: { id: true, name: true, role: true } } },
            },
          },
        });
        if (!review) {
          return reply.status(404).send({ message: 'Review not found' });
        }

        const fromEvents = [];
        for (const e of review.events) {
          if (e.eventType === 'pipeline_resend_notification') continue;

          const at = eventDisplayAt(e);
          const createdAt =
            at instanceof Date
              ? at.toISOString()
              : e.createdAt instanceof Date
                ? e.createdAt.toISOString()
                : e.createdAt;

          const isContentTypeChange = e.eventType === 'pipeline_content_type_changed';
          const statusLabel = isContentTypeChange
            ? 'Content Type Changed'
            : reviewStatusLabel(e.status, e.clientDecision);

          fromEvents.push({
            id: `evt-${e.id}`,
            source: 'timeline',
            role: null,
            authorName: null,
            decision: e.clientDecision
              ? clientDecisionLabel(e.clientDecision) || e.clientDecision
              : e.pmDecision || null,
            revisionNumber: e.revisionNumber,
            content: e.message || null,
            workerNote: e.workerNote || null,
            pmComment: e.pmComment || null,
            clientComment: e.clientComment || null,
            createdAt,
            eventType: e.eventType,
            status: e.status,
            statusLabel,
            statusColor: STATUS_COLORS[e.status] || '#888',
          });
        }

        const fromOs = (review.comments || []).map((c) => formatOsComment(c));

        const merged = [...fromEvents, ...fromOs].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

        return reply.send({
          items: merged,
          description: review.description || review.workerNote || review.aiSummary || null,
        });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to load comments' });
      }
    }
  );

  app.post(
    '/pipeline/:projectId/:wpPipelineId/comments',
    { onRequest: [app.verifyJwt, requirePipelineCommentAccess] },
    async (request, reply) => {
      try {
        const { projectId, wpPipelineId } = request.params;
        const pipelineId = Number(wpPipelineId);
        const content = String(request.body?.content || '').trim();
        if (!content) {
          return reply.status(400).send({ message: 'Comment content is required' });
        }

        const review = await prisma.wpContentReview.findUnique({
          where: { projectId_wpPipelineId: { projectId, wpPipelineId: pipelineId } },
          select: { id: true },
        });
        if (!review) {
          return reply.status(404).send({ message: 'Review not found' });
        }

        const created = await prisma.wpContentReviewComment.create({
          data: {
            contentReviewId: review.id,
            userId: request.user.id,
            content: content.slice(0, 10000),
          },
          include: { user: { select: { id: true, name: true, role: true } } },
        });

        return reply.send(formatOsComment(created));
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to post comment' });
      }
    }
  );

  // PATCH /api/pm/pipeline/:projectId/:wpPipelineId/comments/:commentId — edit own
  app.patch(
    '/pipeline/:projectId/:wpPipelineId/comments/:commentId',
    { onRequest: [app.verifyJwt, requirePipelineCommentAccess] },
    async (request, reply) => {
      try {
        const { projectId, wpPipelineId, commentId } = request.params;
        const pipelineId = Number(wpPipelineId);
        const content = String(request.body?.content || '').trim();
        if (!content) {
          return reply.status(400).send({ message: 'Comment content is required' });
        }

        const review = await prisma.wpContentReview.findUnique({
          where: { projectId_wpPipelineId: { projectId, wpPipelineId: pipelineId } },
          select: { id: true },
        });
        if (!review) {
          return reply.status(404).send({ message: 'Review not found' });
        }

        const comment = await prisma.wpContentReviewComment.findUnique({
          where: { id: commentId },
        });
        if (!comment || comment.contentReviewId !== review.id) {
          return reply.status(404).send({ message: 'Comment not found' });
        }
        if (comment.userId !== request.user.id) {
          return reply.status(403).send({ message: 'You can only edit your own comments' });
        }

        const updated = await prisma.wpContentReviewComment.update({
          where: { id: comment.id },
          data: { content: content.slice(0, 10000) },
          include: { user: { select: { id: true, name: true, role: true } } },
        });

        return reply.send(formatOsComment(updated));
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to update comment' });
      }
    }
  );

  // DELETE /api/pm/pipeline/:projectId/:wpPipelineId/comments/:commentId — delete own
  app.delete(
    '/pipeline/:projectId/:wpPipelineId/comments/:commentId',
    { onRequest: [app.verifyJwt, requirePipelineCommentAccess] },
    async (request, reply) => {
      try {
        const { projectId, wpPipelineId, commentId } = request.params;
        const pipelineId = Number(wpPipelineId);

        const review = await prisma.wpContentReview.findUnique({
          where: { projectId_wpPipelineId: { projectId, wpPipelineId: pipelineId } },
          select: { id: true },
        });
        if (!review) {
          return reply.status(404).send({ message: 'Review not found' });
        }

        const comment = await prisma.wpContentReviewComment.findUnique({
          where: { id: commentId },
        });
        if (!comment || comment.contentReviewId !== review.id) {
          return reply.status(404).send({ message: 'Comment not found' });
        }
        if (comment.userId !== request.user.id) {
          return reply.status(403).send({ message: 'You can only delete your own comments' });
        }

        await prisma.wpContentReviewComment.delete({ where: { id: comment.id } });
        return reply.send({ success: true });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ message: 'Failed to delete comment' });
      }
    }
  );
}
