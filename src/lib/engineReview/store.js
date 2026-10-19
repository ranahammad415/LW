/**
 * Prisma store for the Engine review issuer (adapted from the bundle's prisma-store.mjs).
 * Every issuer step runs inside a Serializable interactive transaction. Frozen snapshots and outbox rows are only
 * ever inserted by this module (append-only); challenge consumption and head moves are conditional (CAS) updates.
 */
const parse = (row) => (row ? JSON.parse(row.data) : null);

function adapter(tx) {
  return {
    snapshot: async (id) => parse(await tx.engineReviewFrozenResult.findUnique({ where: { id } })),
    snapshotByComment: async (commentId) => parse(await tx.engineReviewFrozenResult.findUnique({ where: { commentId } })),
    createSnapshot: (value) =>
      tx.engineReviewFrozenResult.create({
        data: { id: value.id, taskId: value.taskId, commentId: value.commentId, reportHash: value.reportHash, data: JSON.stringify(value) },
      }),
    head: (taskId) => tx.engineReviewTaskHead.findUnique({ where: { taskId } }),
    createHead: (value) => tx.engineReviewTaskHead.create({ data: value }),
    advanceHead: async (taskId, expected, next) =>
      (await tx.engineReviewTaskHead.updateMany({
        where: { taskId, resultId: expected.resultId, version: expected.version, state: expected.state },
        data: next,
      })).count === 1,
    challenge: async (id) => parse(await tx.engineReviewChallenge.findUnique({ where: { id } })),
    createChallenge: (value) =>
      tx.engineReviewChallenge.create({ data: { id: value.id, taskId: value.taskId, userId: value.userId, data: JSON.stringify(value) } }),
    consumeChallenge: async (id, userId) =>
      (await tx.engineReviewChallenge.updateMany({ where: { id, userId, consumed: false }, data: { consumed: true } })).count === 1,
    outboxByChallenge: async (challengeId) => parse(await tx.engineReviewOutbox.findUnique({ where: { challengeId } })),
    createOutbox: (value) =>
      tx.engineReviewOutbox.create({
        data: {
          eventId: value.eventId,
          challengeId: value.challengeId,
          taskId: value.taskId,
          osProjectId: value.osProjectId ?? null,
          resultId: value.resultId,
          version: value.version,
          expiresAt: value.expiresAt ? new Date(value.expiresAt) : null,
          data: JSON.stringify(value.envelope),
        },
      }),
  };
}

export function createPrismaReviewStore(prisma) {
  return { transaction: (fn) => prisma.$transaction((tx) => fn(adapter(tx)), { isolationLevel: 'Serializable' }) };
}
