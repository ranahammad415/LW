/**
 * Local SEO, client portal (docs/ledger/features/local-seo.md). Prefix /api/client.
 * Scoped to the caller's client accounts (an OWNER acts on a client through X-Client-Id via requireClient).
 * "Google Maps ranking" tile: an allow-list built in lib/localRank.js (keyword, position or "not in the top N",
 * change, trend, nearby competitor names). No vendor name, cost, listing ids, match method or error codes.
 */
import { prisma } from '../../lib/prisma.js';
import { clientMapsRankingView } from '../../lib/localRank.js';

export async function clientLocalSeoRoutes(app) {
  const guard = { onRequest: [app.verifyJwt, app.requireClient] };

  app.get('/projects/:id/maps-ranking', guard, async (request, reply) => {
    const clientIds = request.clientAccountIds;
    if (!clientIds?.length) return reply.status(404).send({ message: 'No client account linked to this user' });
    const project = await prisma.project.findUnique({ where: { id: String(request.params.id) }, select: { id: true, clientId: true } });
    if (!project || !clientIds.includes(project.clientId)) return reply.status(404).send({ message: 'Project not found' });
    reply.header('cache-control', 'no-store');
    return reply.send(await clientMapsRankingView(project));
  });
}
