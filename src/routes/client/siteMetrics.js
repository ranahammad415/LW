/**
 * Site metrics, client portal (docs/ledger/features/site-metrics.md). Prefix /api/client.
 * Scoped to the caller's client accounts (an OWNER acts on a client through X-Client-Id via requireClient).
 * Both responses are allow-lists built in lib/pageSpeed.js / lib/backlinkSnapshots.js: plain labels, a sentence and a
 * trend. No vendor name, cost, URL, raw Lighthouse data, rank, spam score or error code.
 */
import { prisma } from '../../lib/prisma.js';
import { clientPageSpeedView } from '../../lib/pageSpeed.js';
import { clientAuthorityView } from '../../lib/backlinkSnapshots.js';

async function scopedProject(request, reply) {
  const clientIds = request.clientAccountIds;
  if (!clientIds?.length) {
    reply.status(404).send({ message: 'No client account linked to this user' });
    return null;
  }
  const project = await prisma.project.findUnique({ where: { id: String(request.params.id) }, select: { id: true, clientId: true } });
  if (!project || !clientIds.includes(project.clientId)) {
    reply.status(404).send({ message: 'Project not found' });
    return null;
  }
  return project;
}

export async function clientSiteMetricsRoutes(app) {
  const guard = { onRequest: [app.verifyJwt, app.requireClient] };

  app.get('/projects/:id/page-speed', guard, async (request, reply) => {
    const project = await scopedProject(request, reply);
    if (!project) return;
    reply.header('cache-control', 'no-store');
    return reply.send(await clientPageSpeedView(project));
  });

  app.get('/projects/:id/authority', guard, async (request, reply) => {
    const project = await scopedProject(request, reply);
    if (!project) return;
    reply.header('cache-control', 'no-store');
    return reply.send(await clientAuthorityView(project));
  });
}
