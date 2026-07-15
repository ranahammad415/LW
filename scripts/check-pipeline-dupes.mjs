import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();

try {
  const reviews = await p.wpContentReview.count();
  const events = await p.wpContentReviewEvent.count();
  console.log(JSON.stringify({ reviews, events }, null, 2));

  // Find duplicate-looking events: same review + revision + status (+ same comments)
  const all = await p.wpContentReviewEvent.findMany({
    select: {
      id: true,
      contentReviewId: true,
      eventType: true,
      status: true,
      revisionNumber: true,
      workerNote: true,
      pmComment: true,
      clientComment: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const resend = all.filter((e) => e.eventType === 'pipeline_resend_notification');
  const byKey = new Map();
  for (const e of all) {
    const key = [
      e.contentReviewId,
      e.revisionNumber,
      e.status,
      e.eventType,
      e.workerNote || '',
      e.pmComment || '',
      e.clientComment || '',
    ].join('||');
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }
  const dupeGroups = [...byKey.values()].filter((g) => g.length > 1);
  const dupeExtra = dupeGroups.reduce((n, g) => n + g.length - 1, 0);

  // Events that carry comments that don't belong to their status (legacy noise)
  const carryForward = all.filter((e) => {
    const st = e.status;
    const hasPm = !!e.pmComment;
    const hasClient = !!e.clientComment;
    const hasWorker = !!e.workerNote;
    if (['pending_pm_review', 'draft'].includes(st)) return hasPm || hasClient;
    if (['pm_approved', 'changes_requested_by_pm'].includes(st)) return hasClient || hasWorker;
    if (st === 'pending_client_review') return hasClient || hasWorker;
    if (['client_approved', 'changes_requested_by_client'].includes(st)) return hasWorker || hasPm;
    return false;
  });

  console.log(
    JSON.stringify(
      {
        resendNotificationEvents: resend.length,
        exactDuplicateGroups: dupeGroups.length,
        exactDuplicateExtraRows: dupeExtra,
        carryForwardCommentEvents: carryForward.length,
        sampleResend: resend.slice(0, 3).map((e) => ({
          id: e.id,
          status: e.status,
          createdAt: e.createdAt,
        })),
        sampleCarryForward: carryForward.slice(0, 5).map((e) => ({
          id: e.id,
          status: e.status,
          eventType: e.eventType,
          hasPm: !!e.pmComment,
          hasClient: !!e.clientComment,
          hasWorker: !!e.workerNote,
        })),
      },
      null,
      2
    )
  );
} catch (e) {
  console.error('ERR', e.message);
  process.exitCode = 1;
} finally {
  await p.$disconnect();
}
