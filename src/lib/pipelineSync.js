import { prisma } from './prisma.js';
import {
  commentsForStatus,
  parseWpDate,
} from './pipelineFormat.js';

/** Build WP agent headers. */
function wpHeaders(apiKey) {
  return {
    'X-LWA-API-Key': apiKey,
    Accept: 'application/json',
    'User-Agent': 'Localwaves-AgencyOS/1.0 (+https://localwaves; pipeline sync)',
  };
}

/**
 * Sync pipeline data from all WP sites into local WpContentReview + WpContentReviewEvent tables.
 * Returns { synced: number, errors: number }
 */
export async function syncPipelineFromWp() {
  const projects = await prisma.project.findMany({
    where: { wpUrl: { not: null }, wpApiKey: { not: null } },
    select: { id: true, name: true, wpUrl: true, wpApiKey: true },
  });

  if (projects.length === 0) return { synced: 0, errors: 0 };

  let synced = 0;
  let errors = 0;

  const fetches = projects.map(async (project) => {
    const baseUrl = project.wpUrl.replace(/\/$/, '');
    const url = `${baseUrl}/wp-json/lwa/v1/pipeline`;
    try {
      const res = await fetch(url, {
        headers: wpHeaders(project.wpApiKey),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { errors++; return; }
      const json = await res.json();
      const items = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];

      for (const p of items) {
        const wpPipelineId = Number(p.id);
        if (!wpPipelineId) continue;

        const data = {
          wpPostId: Number(p.postId) || 0,
          postTitle: String(p.postTitle || '').slice(0, 500),
          status: String(p.status || '').slice(0, 50),
          submittedByName: p.submittedBy?.name ? String(p.submittedBy.name).slice(0, 200) : null,
          submittedById: p.submittedBy?.memberId ? String(p.submittedBy.memberId).slice(0, 100) : null,
          pmMemberName: p.pmAssigned?.name ? String(p.pmAssigned.name).slice(0, 200) : null,
          pmMemberId: p.pmAssigned?.memberId ? String(p.pmAssigned.memberId).slice(0, 100) : null,
          pmPreviewUrl: p.pmPreviewUrl ? String(p.pmPreviewUrl).slice(0, 1000) : null,
          clientPreviewUrl: p.clientPreviewUrl ? String(p.clientPreviewUrl).slice(0, 1000) : null,
          pmDecision: p.pmDecision ? String(p.pmDecision).slice(0, 50) : null,
          pmComment: p.pmComment ? String(p.pmComment).slice(0, 10000) : null,
          clientDecision: p.clientDecision ? String(p.clientDecision).slice(0, 50) : null,
          clientComment: p.clientComment ? String(p.clientComment).slice(0, 10000) : null,
          workerNote: p.workerNote ? String(p.workerNote).slice(0, 10000) : null,
          pmReviewedAt: p.pmReviewedAt ? String(p.pmReviewedAt).slice(0, 50) : null,
          clientReviewedAt: p.clientReviewedAt ? String(p.clientReviewedAt).slice(0, 50) : null,
          revisionNumber: Number(p.revisionNumber) || 1,
        };

        try {
          const review = await prisma.wpContentReview.upsert({
            where: { projectId_wpPipelineId: { projectId: project.id, wpPipelineId } },
            update: data,
            create: { projectId: project.id, wpPipelineId, ...data },
          });

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
                  pmReviewedAt: h.pmReviewedAt || null,
                  clientReviewedAt: h.clientReviewedAt || null,
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
  const ms = Number(process.env.PIPELINE_SYNC_INTERVAL_MS) || 0;
  if (ms <= 0) {
    logger.info('Pipeline sync interval disabled (PIPELINE_SYNC_INTERVAL_MS=0 or unset)');
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
