import { prisma } from './prisma.js';

const ORPHAN_WP_STATUSES = new Set(['', 'trash', 'deleted']);

/**
 * True when WordPress no longer has a usable post for this pipeline
 * (missing page, trash, or explicit deleted status).
 */
export function isOrphanWpPostStatus(wpPostStatus) {
  return ORPHAN_WP_STATUSES.has(String(wpPostStatus || '').trim().toLowerCase());
}

export function hasWpPostStatus(item) {
  return item != null && (
    Object.prototype.hasOwnProperty.call(item, 'wpPostStatus')
    || Object.prototype.hasOwnProperty.call(item, 'wp_post_status')
  );
}

export async function isPipelineTombstoned(projectId, wpPipelineId) {
  try {
    const row = await prisma.wpContentReviewTombstone.findUnique({
      where: { projectId_wpPipelineId: { projectId, wpPipelineId } },
      select: { id: true },
    });
    return Boolean(row);
  } catch (err) {
    console.warn('[pipeline-tombstone] lookup failed:', err.message);
    return false;
  }
}

export async function listTombstonedPipelineIds(projectId) {
  try {
    const rows = await prisma.wpContentReviewTombstone.findMany({
      where: { projectId },
      select: { wpPipelineId: true },
    });
    return new Set(rows.map((r) => r.wpPipelineId));
  } catch (err) {
    console.warn('[pipeline-tombstone] list failed:', err.message);
    return new Set();
  }
}

export async function recordPipelineTombstone({ projectId, wpPipelineId, deletedById = null }) {
  return prisma.wpContentReviewTombstone.upsert({
    where: { projectId_wpPipelineId: { projectId, wpPipelineId } },
    create: { projectId, wpPipelineId, deletedById },
    update: { deletedAt: new Date(), deletedById },
  });
}
