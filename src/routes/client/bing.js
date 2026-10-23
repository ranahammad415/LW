/**
 * Bing Webmaster, client portal (docs/ledger/features/bing-webmaster.md). Prefix /api/client.
 * Scoped to the caller's client accounts (an OWNER acts on a client through X-Client-Id via requireClient).
 * The tile is an allow-list built in lib/bing/bingViews.js (clicks, impressions, change, share of search clicks, a
 * short trend and one sentence). No site URL, ids, error text, crawl-issue URLs or vendor cost.
 */
import { prisma } from '../../lib/prisma.js';
import { clientBingSummary } from '../../lib/bing/bingViews.js';

export async function clientBingRoutes(app) {
  const guard = { onRequest: [app.verifyJwt, app.requireClient] };

  app.get('/projects/:id/bing-summary', guard, async (request, reply) => {
    const clientIds = request.clientAccountIds;
    if (!clientIds?.length) return reply.status(404).send({ message: 'No client account linked to this user' });
    const project = await prisma.project.findUnique({
      where: { id: String(request.params.id) },
      select: { id: true, clientId: true, gscSiteUrl: true, bingSiteUrl: true, bingLastSyncedAt: true },
    });
    if (!project || !clientIds.includes(project.clientId)) return reply.status(404).send({ message: 'Project not found' });
    reply.header('cache-control', 'no-store');
    return reply.send(await clientBingSummary(project));
  });
}
