import { prisma } from '../lib/prisma.js';
import { ensureCurrentCycle } from '../lib/workCycle.js';

/**
 * Read-only work-cycle (monthly session) endpoints for every authenticated
 * portal. Mounted under /api/work-cycles.
 */
export async function workCycleRoutes(app) {
  // List all cycles (newest first) so any portal can build a month switcher.
  app.get('/', { onRequest: [app.verifyJwt] }, async (request, reply) => {
    // Make sure at least the current cycle exists so the switcher is never empty.
    await ensureCurrentCycle({ userId: request.user?.id });
    const cycles = await prisma.workCycle.findMany({
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      select: {
        id: true,
        month: true,
        year: true,
        status: true,
        label: true,
        openedAt: true,
        closedAt: true,
      },
    });
    return reply.send(cycles);
  });

  // Resolve the current (OPEN) cycle — the default focus for every portal.
  app.get('/current', { onRequest: [app.verifyJwt] }, async (request, reply) => {
    const current = await ensureCurrentCycle({ userId: request.user?.id });
    return reply.send(current);
  });
}
