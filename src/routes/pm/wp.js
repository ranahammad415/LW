import { prisma } from '../../lib/prisma.js';

/** GET /api/pm/wp-presets — list WP access presets (PM/OWNER only) */
export async function pmWpRoutes(app) {
  app.get(
    '/wp-presets',
    { onRequest: [app.verifyJwt, app.requirePM] },
    async (request, reply) => {
      const presets = await prisma.wpAccessPreset.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, capabilities: true, createdAt: true },
      });
      return reply.send(presets);
    }
  );
}
