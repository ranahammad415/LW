/**
 * Retention for the Engine review issuer's copies (OS-14). These tables hold copies of Engine reports and review
 * reasons; an Engine-side project purge cannot delete them, so the OS owns this rule:
 *   - challenges: deleted 1 day after creation (they expire after 120 s; kept a day for debugging);
 *   - outbox envelopes: deleted 30 days after creation (the signed event itself expires after 15 min);
 *   - frozen results: deleted 365 days after creation (review evidence for a year);
 *   - task heads: kept (no report content: resultId/version/state only).
 * Run hourly on the PM2 leader (index.js). Plain conditional deletes: safe if two instances run it.
 * Offboarding a client: deleteEngineReviewRecordsForTasks(taskIds) removes every copy for those tasks.
 */
import { prisma } from '../prisma.js';

const DAY = 24 * 60 * 60 * 1000;
export const ENGINE_REVIEW_RETENTION = { challengeDays: 1, outboxDays: 30, frozenResultDays: 365 };

export async function purgeEngineReviewRecords(now = new Date()) {
  const t = now.getTime();
  const [challenges, outbox, frozen] = await Promise.all([
    prisma.engineReviewChallenge.deleteMany({ where: { createdAt: { lt: new Date(t - ENGINE_REVIEW_RETENTION.challengeDays * DAY) } } }),
    prisma.engineReviewOutbox.deleteMany({ where: { createdAt: { lt: new Date(t - ENGINE_REVIEW_RETENTION.outboxDays * DAY) } } }),
    prisma.engineReviewFrozenResult.deleteMany({ where: { createdAt: { lt: new Date(t - ENGINE_REVIEW_RETENTION.frozenResultDays * DAY) } } }),
  ]);
  return { challenges: challenges.count, outbox: outbox.count, frozenResults: frozen.count };
}

export async function deleteEngineReviewRecordsForTasks(taskIds) {
  const ids = (Array.isArray(taskIds) ? taskIds : []).filter((x) => typeof x === 'string' && x);
  if (!ids.length) return { challenges: 0, outbox: 0, frozenResults: 0, heads: 0 };
  const where = { taskId: { in: ids } };
  const [challenges, outbox, frozen, heads] = await prisma.$transaction([
    prisma.engineReviewChallenge.deleteMany({ where }),
    prisma.engineReviewOutbox.deleteMany({ where }),
    prisma.engineReviewFrozenResult.deleteMany({ where }),
    prisma.engineReviewTaskHead.deleteMany({ where }),
  ]);
  return { challenges: challenges.count, outbox: outbox.count, frozenResults: frozen.count, heads: heads.count };
}
