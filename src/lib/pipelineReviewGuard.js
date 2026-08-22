import { randomUUID } from 'node:crypto';
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

let tableReady = false;

/**
 * Raw SQL so this works even when the running Prisma client was generated
 * before WpContentReviewTombstone existed (the production delete 500).
 */
async function ensureTombstoneTable() {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS \`wpcontentreviewtombstone\` (
      \`id\` VARCHAR(191) NOT NULL,
      \`projectId\` VARCHAR(191) NOT NULL,
      \`wpPipelineId\` INT NOT NULL,
      \`deletedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      \`deletedById\` VARCHAR(191) NULL,
      INDEX \`wpcontentreviewtombstone_projectId_idx\`(\`projectId\`),
      UNIQUE INDEX \`wpcontentreviewtombstone_projectId_wpPipelineId_key\`(\`projectId\`, \`wpPipelineId\`),
      PRIMARY KEY (\`id\`)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  tableReady = true;
}

export async function isPipelineTombstoned(projectId, wpPipelineId) {
  try {
    await ensureTombstoneTable();
    const rows = await prisma.$queryRaw`
      SELECT id FROM wpcontentreviewtombstone
      WHERE projectId = ${projectId} AND wpPipelineId = ${wpPipelineId}
      LIMIT 1
    `;
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    console.warn('[pipeline-tombstone] lookup failed:', err.message);
    return false;
  }
}

export async function listTombstonedPipelineIds(projectId) {
  try {
    await ensureTombstoneTable();
    const rows = await prisma.$queryRaw`
      SELECT wpPipelineId FROM wpcontentreviewtombstone
      WHERE projectId = ${projectId}
    `;
    return new Set((rows || []).map((r) => Number(r.wpPipelineId)));
  } catch (err) {
    console.warn('[pipeline-tombstone] list failed:', err.message);
    return new Set();
  }
}

export async function recordPipelineTombstone({ projectId, wpPipelineId, deletedById = null }) {
  await ensureTombstoneTable();
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO wpcontentreviewtombstone (id, projectId, wpPipelineId, deletedAt, deletedById)
    VALUES (${id}, ${projectId}, ${wpPipelineId}, NOW(3), ${deletedById})
    ON DUPLICATE KEY UPDATE
      deletedAt = NOW(3),
      deletedById = VALUES(deletedById)
  `;
}
