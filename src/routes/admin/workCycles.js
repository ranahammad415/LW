import { openNextCycle, previewOpenNext, ensureCurrentCycle } from '../../lib/workCycle.js';

/**
 * Owner-only work-cycle actions. Mounted under /api/admin.
 */
export async function adminWorkCycleRoutes(app) {
  // Preview what "Start next month" will do (for the confirm dialog).
  app.get(
    '/work-cycles/open-next/preview',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      const preview = await previewOpenNext();
      return reply.send(preview);
    }
  );

  // Close the current month and open the next one (agency-wide).
  app.post(
    '/work-cycles/open-next',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      const result = await openNextCycle({ userId: request.user?.id, log: request.log });
      return reply.send({
        closedCycle: result.closedCycle,
        newCycle: result.newCycle,
        carried: result.carried,
        reports: result.reports ?? null,
        snapshots: result.snapshots ?? null,
      });
    }
  );

  // Ensure a current cycle exists (bootstrap) — safe to call anytime.
  app.post(
    '/work-cycles/ensure-current',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      const current = await ensureCurrentCycle({ userId: request.user?.id });
      return reply.send(current);
    }
  );
}
