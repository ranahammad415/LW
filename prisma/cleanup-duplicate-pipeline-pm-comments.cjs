/**
 * Null duplicate pmComment on sent_to_client / pending_client_review events
 * when the same review+revision already has that note on a PM-decision event.
 *
 * Usage:
 *   node prisma/cleanup-duplicate-pipeline-pm-comments.cjs           # dry-run
 *   node prisma/cleanup-duplicate-pipeline-pm-comments.cjs --apply
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  const candidates = await prisma.wpContentReviewEvent.findMany({
    where: {
      pmComment: { not: null },
      OR: [
        { eventType: 'pipeline_sent_to_client' },
        { status: 'pending_client_review' },
        { eventType: { startsWith: 'sync_pending_client_review' } },
      ],
    },
    select: {
      id: true,
      contentReviewId: true,
      revisionNumber: true,
      pmComment: true,
      eventType: true,
      status: true,
    },
  });

  let wouldClear = 0;
  for (const row of candidates) {
    const note = (row.pmComment || '').trim();
    if (!note) continue;

    const sibling = await prisma.wpContentReviewEvent.findFirst({
      where: {
        contentReviewId: row.contentReviewId,
        revisionNumber: row.revisionNumber,
        id: { not: row.id },
        pmComment: note,
        OR: [
          { eventType: 'pipeline_pm_approved' },
          { eventType: 'pipeline_pm_changes_requested' },
          { status: 'pm_approved' },
          { status: 'changes_requested_by_pm' },
          { eventType: { startsWith: 'sync_pm_approved' } },
          { eventType: { startsWith: 'sync_changes_requested_by_pm' } },
        ],
      },
      select: { id: true },
    });

    if (!sibling) continue;
    wouldClear++;
    console.log(
      `  clear pmComment on ${row.id} (${row.eventType || row.status}) rev=${row.revisionNumber}`
    );
    if (APPLY) {
      await prisma.wpContentReviewEvent.update({
        where: { id: row.id },
        data: { pmComment: null },
      });
    }
  }

  console.log(
    APPLY
      ? `\nCleared ${wouldClear} duplicate PM note(s).`
      : `\nDry-run: ${wouldClear} event(s) would be cleared. Re-run with --apply.`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
