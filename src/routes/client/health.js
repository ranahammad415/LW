/**
 * Client portal health score (v2). Prefix /api/client. docs/ledger/features/health-score.md.
 * Scoped to the caller's client accounts (requireClient; an OWNER acts on a client through X-Client-Id).
 * Responses come from lib/health/healthViews.js clientHealthView, an allow-list: no factors, raw values, weights,
 * config, staff note, security number or check id.
 */
import { prisma } from '../../lib/prisma.js';
import { resolvePrimaryClientId } from '../../lib/clientContext.js';
import { loadClientHealthView, loadProjectClientView } from '../../lib/health/healthViews.js';

export async function clientHealthRoutes(app) {
  const guard = { onRequest: [app.verifyJwt, app.requireClient] };

  // Same client selection as GET /api/client/dashboard (primary contact link, else the first linked client).
  app.get('/health', guard, async (request, reply) => {
    const clientId = resolvePrimaryClientId(request);
    if (!clientId) return reply.status(404).send({ message: 'No client account linked to this user' });
    reply.header('cache-control', 'no-store');
    return reply.send(await loadClientHealthView(clientId));
  });

  app.get('/projects/:id/health', guard, async (request, reply) => {
    const clientIds = request.clientAccountIds || [];
    if (!clientIds.length) return reply.status(404).send({ message: 'No client account linked to this user' });
    const project = await prisma.project.findUnique({ where: { id: String(request.params.id) }, select: { id: true, clientId: true } });
    if (!project || !clientIds.includes(project.clientId)) return reply.status(404).send({ message: 'Project not found' });
    reply.header('cache-control', 'no-store');
    return reply.send(await loadProjectClientView(project.id));
  });
}
