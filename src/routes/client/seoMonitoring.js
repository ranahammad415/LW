/**
 * Client portal "Business listings" and "AI answers" tiles (EmDash contract 1.8.0 §39). Prefix /api/client.
 * Scoped to the caller's client accounts (an OWNER acts on a client through X-Client-Id via requireClient).
 * Allow-lists built in lib/citations/citations.js (clientListingsView) and lib/analytics/aiVisibilityScheduled.js
 * (clientAiAnswersView): counts and plain sentences only. No vendor or model name, cost, ids, URLs, notes or answers.
 */
import { prisma } from '../../lib/prisma.js';
import { clientListingsView } from '../../lib/citations/citations.js';
import { clientAiAnswersView } from '../../lib/analytics/aiVisibilityScheduled.js';

export async function clientSeoMonitoringRoutes(app) {
  const guard = { onRequest: [app.verifyJwt, app.requireClient] };

  async function projectFor(request, reply) {
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

  app.get('/projects/:id/business-listings', guard, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    reply.header('cache-control', 'no-store');
    return reply.send(await clientListingsView(project));
  });

  app.get('/projects/:id/ai-answers', guard, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    reply.header('cache-control', 'no-store');
    return reply.send(await clientAiAnswersView(project));
  });
}
