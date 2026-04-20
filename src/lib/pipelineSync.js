import { prisma } from './prisma.js';

/** Build WP agent headers. */
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

          // Sync history entries from WP as events (if not already stored)
          const history = Array.isArray(p.history) ? p.history : [];
          if (history.length > 0) {
            // Check how many events we already have
            const existingCount = await prisma.wpContentReviewEvent.count({
              where: { contentReviewId: review.id },
            });

            // If WP has more history entries than we have events, backfill missing ones
            if (history.length > existingCount) {
              // Get existing events to avoid duplicates
              const existing = await prisma.wpContentReviewEvent.findMany({
                where: { contentReviewId: review.id },
                select: { revisionNumber: true, eventType: true, status: true },
              });

              const existingKeys = new Set(
                existing.map((e) => `${e.revisionNumber}_${e.status}`)
              );

              for (const h of history) {
                const key = `${h.revisionNumber}_${h.status}`;
                if (existingKeys.has(key)) continue;

                await prisma.wpContentReviewEvent.create({
                  data: {
                    contentReviewId: review.id,
                    eventType: `sync_${h.status}`,
                    status: h.status || '',
                    revisionNumber: h.revisionNumber || 1,
                    workerNote: h.workerNote || null,
                    pmComment: h.pmComment || null,
                    pmDecision: h.pmDecision || null,
                    clientComment: h.clientComment || null,
                    clientDecision: h.clientDecision || null,
                    pmReviewedAt: h.pmReviewedAt || null,
                    clientReviewedAt: h.clientReviewedAt || null,
                  },
                });
              }
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
