/**
 * SAFE cleanup of content-review EVENT LOG duplicates only.
 *
 * Guarantees:
 * - Never updates/deletes WpContentReview (current PM/client/worker comments live there)
 * - Never clears or rewrites comments on event rows
 * - Only deletes rows that are true log duplicates
 *
 * What it removes:
 * 1) Exact-duplicate events (same review + revision + status + eventType + same comments)
 *    → keeps ONE copy (preferring the row with the most comment text)
 * 2) pipeline_resend_notification events ONLY when another event already exists
 *    for the same review + revision + status (so no unique comment text is lost)
 *
 * Usage:
 *   node scripts/cleanup-pipeline-events.mjs           # dry-run (default)
 *   node scripts/cleanup-pipeline-events.mjs --apply   # write changes
 *
 * Uses DATABASE_URL from backend/.env (or process env).
 */
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const p = new PrismaClient();

function commentScore(e) {
  return [e.workerNote, e.pmComment, e.clientComment]
    .map((s) => (s ? String(s).length : 0))
    .reduce((a, b) => a + b, 0);
}

function eventKey(e) {
  return [
    e.contentReviewId,
    e.revisionNumber,
    e.status,
    e.eventType || '',
    e.workerNote || '',
    e.pmComment || '',
    e.clientComment || '',
    e.pmDecision || '',
    e.clientDecision || '',
  ].join('\0');
}

function snapshotReviewComments(reviews) {
  return reviews.map((r) => ({
    id: r.id,
    workerNote: r.workerNote,
    pmComment: r.pmComment,
    clientComment: r.clientComment,
    pmDecision: r.pmDecision,
    clientDecision: r.clientDecision,
  }));
}

try {
  const reviewsBefore = await p.wpContentReview.findMany({
    select: {
      id: true,
      workerNote: true,
      pmComment: true,
      clientComment: true,
      pmDecision: true,
      clientDecision: true,
    },
  });
  const reviewSnapshot = snapshotReviewComments(reviewsBefore);

  const all = await p.wpContentReviewEvent.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  // --- Exact duplicates: keep the richest comment copy, delete the rest ---
  const byKey = new Map();
  for (const e of all) {
    const key = eventKey(e);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }

  const exactDupeIds = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    // Keep the event with the most comment text; tie-break: oldest createdAt
    const sorted = [...group].sort((a, b) => {
      const scoreDiff = commentScore(b) - commentScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      return a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id));
    });
    for (const e of sorted.slice(1)) exactDupeIds.push(e.id);
  }

  // --- Resend spam: only if a non-resend event already covers same review/status/round ---
  const covered = new Set(
    all
      .filter((e) => e.eventType !== 'pipeline_resend_notification')
      .map((e) => `${e.contentReviewId}\0${e.revisionNumber}\0${e.status}`)
  );

  const resendIds = all
    .filter((e) => {
      if (e.eventType !== 'pipeline_resend_notification') return false;
      if (exactDupeIds.includes(e.id)) return false;
      const coverKey = `${e.contentReviewId}\0${e.revisionNumber}\0${e.status}`;
      return covered.has(coverKey);
    })
    .map((e) => e.id);

  const deleteIds = [...new Set([...exactDupeIds, ...resendIds])];

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? 'APPLY' : 'DRY_RUN',
        safety: {
          touchesCurrentReviews: false,
          rewritesEventComments: false,
          onlyDeletesDuplicateLogRows: true,
        },
        totalReviews: reviewsBefore.length,
        totalEvents: all.length,
        willDeleteExactDupes: exactDupeIds.length,
        willDeleteSafeResends: resendIds.length,
        willDeleteTotal: deleteIds.length,
        willKeepEvents: all.length - deleteIds.length,
        sampleDeletes: deleteIds.slice(0, 8),
      },
      null,
      2
    )
  );

  if (!APPLY) {
    console.log('\nDry-run only — no data changed.');
    console.log('Current review comments on WpContentReview are never touched.');
    console.log('Re-run with --apply to delete duplicate log rows only.');
    process.exit(0);
  }

  if (deleteIds.length === 0) {
    console.log('Nothing to delete.');
    process.exit(0);
  }

  const deleted = await p.wpContentReviewEvent.deleteMany({
    where: { id: { in: deleteIds } },
  });
  console.log(`Deleted duplicate event rows: ${deleted.count}`);

  // Verify current review comments are unchanged
  const reviewsAfter = await p.wpContentReview.findMany({
    select: {
      id: true,
      workerNote: true,
      pmComment: true,
      clientComment: true,
      pmDecision: true,
      clientDecision: true,
    },
  });
  const afterMap = new Map(reviewsAfter.map((r) => [r.id, r]));
  let drift = 0;
  for (const before of reviewSnapshot) {
    const after = afterMap.get(before.id);
    if (!after) {
      drift++;
      continue;
    }
    if (
      before.workerNote !== after.workerNote ||
      before.pmComment !== after.pmComment ||
      before.clientComment !== after.clientComment ||
      before.pmDecision !== after.pmDecision ||
      before.clientDecision !== after.clientDecision
    ) {
      drift++;
    }
  }

  if (drift > 0) {
    console.error(
      `SAFETY CHECK FAILED: ${drift} review comment snapshot(s) changed. This should be impossible — inspect immediately.`
    );
    process.exitCode = 1;
  } else {
    console.log('Safety check OK: all current review comments unchanged.');
  }
  console.log('Done.');
} catch (e) {
  console.error('ERR', e.message);
  process.exitCode = 1;
} finally {
  await p.$disconnect();
}
