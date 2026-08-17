import { prisma } from './prisma.js';
import {
  commentsForStatus,
  parseWpDate,
} from './pipelineFormat.js';
import { mirrorPipelineToMaps } from './contentMapSync.js';

/** Build WP agent headers. */
function wpHeaders(apiKey) {
  return {
    'X-LWA-API-Key': apiKey,
    Accept: 'application/json',
    'User-Agent': 'Localwaves-AgencyOS/1.0 (+https://localwaves; pipeline sync)',
  };
}

/**
 * Sync pipeline data from WP sites into local WpContentReview + WpContentReviewEvent tables.
 * Pass `{ projectId }` to self-heal / refresh a single project's rows (e.g. to
 * pull fresh preview URLs after one expires); omit it for the full sweep.
 * Returns { synced: number, errors: number }
 */
export async function syncPipelineFromWp({ projectId } = {}) {
  const projects = await prisma.project.findMany({
    where: {
      wpUrl: { not: null },
      wpApiKey: { not: null },
      ...(projectId ? { id: projectId } : {}),
    },
    select: { id: true, name: true, wpUrl: true, wpApiKey: true },
  });

  if (projects.length === 0) return { synced: 0, errors: 0 };

  let synced = 0;
  let errors = 0;

  const fetches = projects.map(async (project) => {
    const baseUrl = project.wpUrl.replace(/\/$/, '');
    try {
      // Paginate WP pipeline list (default 50/page) so sync heals all rows.
      const items = [];
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages && page <= 40) {
        const url = `${baseUrl}/wp-json/lwa/v1/pipeline?page=${page}&per_page=100`;
        const res = await fetch(url, {
          headers: wpHeaders(project.wpApiKey),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          errors++;
          return;
        }
        const json = await res.json();
        const batch = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
        items.push(...batch);
        totalPages = Math.max(1, Number(json?.total_pages) || 1);
        if (batch.length === 0) break;
        page += 1;
      }

      for (const p of items) {
        const wpPipelineId = Number(p.id);
        if (!wpPipelineId) continue;

        // Preserve an already-published state; never let sync regress it.
        // Do NOT treat WP post_status=publish alone as "review done" — active
        // pipelines (especially blogs submitted while live) stay visible until
        // the pipeline itself is published or already marked published in OS.
        const existing = await prisma.wpContentReview.findUnique({
          where: { projectId_wpPipelineId: { projectId: project.id, wpPipelineId } },
          select: {
            isPublished: true,
            publishedAt: true,
            assignedWorkerId: true,
            assignedWorkerName: true,
          },
        });
        const pipelineStatus = String(p.status || '').slice(0, 50);
        const wpSaysPublished =
          pipelineStatus === 'published' || pipelineStatus === 'publish';
        const isPublished = Boolean(existing?.isPublished || wpSaysPublished);
        const submittedById = p.submittedBy?.memberId
          ? String(p.submittedBy.memberId).slice(0, 100)
          : null;
        const submittedByName = p.submittedBy?.name
          ? String(p.submittedBy.name).slice(0, 200)
          : null;

        const resolvedStatus = isPublished ? 'published' : pipelineStatus;
        // WP is source of truth: clear stale decisions on pending_* stages.
        const clearClient = resolvedStatus === 'pending_client_review';
        const clearPm = resolvedStatus === 'pending_pm_review';

        const data = {
          wpPostId: Number(p.postId) || 0,
          // Don't overwrite a stored title with an empty string (can happen for a
          // deleted update-mode draft before the parent fallback resolves).
          ...(p.postTitle ? { postTitle: String(p.postTitle).slice(0, 500) } : {}),
          // "Update Content" reviews: keep the parent-page link.
          ...(p.parentPostId ? { parentWpPostId: Number(p.parentPostId) } : {}),
          status: resolvedStatus,
          submittedByName,
          submittedById,
          pmMemberName: p.pmAssigned?.name ? String(p.pmAssigned.name).slice(0, 200) : null,
          pmMemberId: p.pmAssigned?.memberId ? String(p.pmAssigned.memberId).slice(0, 100) : null,
          // Don't wipe stored preview URLs when WP omits them (expired display
          // cache / legacy rows without token_plain) — match webhook semantics.
          ...(p.pmPreviewUrl ? { pmPreviewUrl: String(p.pmPreviewUrl).slice(0, 1000) } : {}),
          ...(p.clientPreviewUrl
            ? { clientPreviewUrl: String(p.clientPreviewUrl).slice(0, 1000) }
            : {}),
          pmDecision: clearPm ? null : (p.pmDecision ? String(p.pmDecision).slice(0, 50) : null),
          pmComment: p.pmComment ? String(p.pmComment).slice(0, 10000) : null,
          clientDecision: clearClient
            ? null
            : (p.clientDecision ? String(p.clientDecision).slice(0, 50) : null),
          clientComment: clearClient
            ? null
            : (p.clientComment ? String(p.clientComment).slice(0, 10000) : null),
          workerNote: p.workerNote ? String(p.workerNote).slice(0, 10000) : null,
          // Don't wipe a stored content type if WP omits it for legacy rows.
          ...(p.contentType ? { contentType: String(p.contentType).slice(0, 50) } : {}),
          pmReviewedAt: clearPm
            ? null
            : (p.pmReviewedAt ? String(p.pmReviewedAt).slice(0, 50) : null),
          clientReviewedAt: clearClient
            ? null
            : (p.clientReviewedAt ? String(p.clientReviewedAt).slice(0, 50) : null),
          revisionNumber: Number(p.revisionNumber) || 1,
          ...(parseWpDate(p.createdAt) ? { wpCreatedAt: parseWpDate(p.createdAt) } : {}),
          ...(parseWpDate(p.updatedAt) ? { wpUpdatedAt: parseWpDate(p.updatedAt) } : {}),
          // Preserve / set publish flags without ever clearing them.
          ...(isPublished
            ? {
                isPublished: true,
                ...(existing?.publishedAt ? {} : { publishedAt: new Date() }),
              }
            : {}),
        };

        try {
          // Default OS assignee to submitter on create only; never overwrite an
          // existing Admin/PM assignment on later syncs.
          const createAssignee =
            !existing?.assignedWorkerId && submittedById
              ? {
                  assignedWorkerId: submittedById,
                  assignedWorkerName: submittedByName,
                }
              : {};

          const review = await prisma.wpContentReview.upsert({
            where: { projectId_wpPipelineId: { projectId: project.id, wpPipelineId } },
            update: data,
            create: {
              projectId: project.id,
              wpPipelineId,
              // postTitle is required on create; data may omit it when WP sent an
              // empty title, so provide a fallback.
              postTitle: String(p.postTitle || 'Untitled').slice(0, 500),
              ...data,
              // On create, allow null preview URLs when WP has none yet.
              pmPreviewUrl: p.pmPreviewUrl ? String(p.pmPreviewUrl).slice(0, 1000) : null,
              clientPreviewUrl: p.clientPreviewUrl
                ? String(p.clientPreviewUrl).slice(0, 1000)
                : null,
              ...createAssignee,
            },
          });

          // Reflect pipeline progress on any matching content map node.
          mirrorPipelineToMaps(project.id, review).catch(() => {});

          // Only backfill when this review has no events yet. WP's `history`
          // array is post-wide (all pipeline rows for the post), so importing
          // it onto every review duplicated comments across timelines and
          // stamped every row with the sync clock.
          const existingCount = await prisma.wpContentReviewEvent.count({
            where: { contentReviewId: review.id },
          });

          if (existingCount === 0) {
            const history = Array.isArray(p.history) ? p.history : [];
            // Prefer the history entry for THIS pipeline id when WP provides it.
            const own = history.filter((h) => Number(h.id) === wpPipelineId);
            const snapshots = own.length > 0
              ? own
              : [{
                  id: wpPipelineId,
                  revisionNumber: data.revisionNumber,
                  status: data.status,
                  workerNote: data.workerNote,
                  pmComment: data.pmComment,
                  pmDecision: data.pmDecision,
                  clientComment: data.clientComment,
                  clientDecision: data.clientDecision,
                  pmReviewedAt: data.pmReviewedAt,
                  clientReviewedAt: data.clientReviewedAt,
                  createdAt: p.createdAt,
                  updatedAt: p.updatedAt,
                }];

            for (const h of snapshots) {
              const status = String(h.status || data.status || '').slice(0, 50);
              const scoped = commentsForStatus(status, {
                workerNote: h.workerNote || null,
                pmComment: h.pmComment || null,
                pmDecision: h.pmDecision || null,
                clientComment: h.clientComment || null,
                clientDecision: h.clientDecision || null,
              });
              const at =
                parseWpDate(h.updatedAt) ||
                parseWpDate(h.createdAt) ||
                parseWpDate(h.clientReviewedAt) ||
                parseWpDate(h.pmReviewedAt) ||
                new Date();

              // Only attach reviewer times that belong to this status snapshot.
              const pmAt =
                status === 'pm_approved' || status === 'changes_requested_by_pm'
                  ? h.pmReviewedAt || null
                  : null;
              const clientAt =
                status === 'client_approved' || status === 'changes_requested_by_client'
                  ? h.clientReviewedAt || null
                  : null;
              await prisma.wpContentReviewEvent.create({
                data: {
                  contentReviewId: review.id,
                  eventType: `sync_${status}`,
                  status,
                  revisionNumber: Number(h.revisionNumber) || data.revisionNumber || 1,
                  workerNote: scoped.workerNote,
                  pmComment: scoped.pmComment,
                  pmDecision: scoped.pmDecision,
                  clientComment: scoped.clientComment,
                  clientDecision: scoped.clientDecision,
                  pmReviewedAt: pmAt,
                  clientReviewedAt: clientAt,
                  createdAt: at,
                },
              });
            }
          }

          synced++;
        } catch {
          errors++;
        }
      }
    } catch {
      errors++;
    }
  });

  await Promise.all(fetches);
  return { synced, errors };
}

let syncIntervalId = null;

/**
 * Start the automatic pipeline sync interval.
 * @param {object} logger - Fastify logger instance
 */
export function startPipelineSyncInterval(logger) {
  // Default the safety-net polling ON (5 min) so missed webhooks self-correct.
  // Set PIPELINE_SYNC_INTERVAL_MS=0 to explicitly disable it.
  const raw = process.env.PIPELINE_SYNC_INTERVAL_MS;
  const ms = raw === undefined || raw === '' ? 5 * 60 * 1000 : Number(raw) || 0;
  if (ms <= 0) {
    logger.info('Pipeline sync interval disabled (PIPELINE_SYNC_INTERVAL_MS=0)');
    return;
  }

  logger.info(`Starting pipeline sync interval every ${ms}ms`);
  syncIntervalId = setInterval(async () => {
    try {
      const result = await syncPipelineFromWp();
      if (result.synced > 0 || result.errors > 0) {
        logger.info({ result }, 'Pipeline sync complete');
      }
    } catch (err) {
      logger.error({ err }, 'Pipeline sync failed');
    }
  }, ms);
}

/**
 * Stop the automatic pipeline sync interval.
 */
export function stopPipelineSyncInterval() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
}
