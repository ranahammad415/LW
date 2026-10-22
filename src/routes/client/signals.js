/**
 * Client portal "Where your leads come from" (EmDash contract v1.7.0 §38, plan §6.1). Prefix /api/client.
 * Scoped to the caller's client accounts (an OWNER acts on a client through X-Client-Id via requireClient).
 * Only with capabilities.signals (EmDash); every other project gets { available: false } and the UI renders nothing
 * (never a section of empty zeros on WordPress projects). The response is the allow-list built by
 * lib/signals/views.js clientSignalsView: no ids, visitor ids, city, payload or paths beyond landing pages.
 * The CSV is daily aggregates only.
 */
import { prisma } from '../../lib/prisma.js';
import { clientSignalsView, clientDailyCsv } from '../../lib/signals/views.js';
import { hasSignals } from '../../lib/signals/config.js';

async function scopedProject(request, reply) {
  const clientIds = request.clientAccountIds;
  if (!clientIds?.length) {
    reply.status(404).send({ message: 'No client account linked to this user' });
    return null;
  }
  const project = await prisma.project.findUnique({ where: { id: String(request.params.id) }, select: { id: true, clientId: true, cmsType: true, cmsCapabilities: true } });
  if (!project || !clientIds.includes(project.clientId)) {
    reply.status(404).send({ message: 'Project not found' });
    return null;
  }
  return project;
}

export async function clientSignalsRoutes(app) {
  const auth = { onRequest: [app.verifyJwt, app.requireClient] };

  app.get('/projects/:id/signals', auth, async (request, reply) => {
    const project = await scopedProject(request, reply);
    if (!project) return;
    reply.header('cache-control', 'no-store');
    return reply.send(await clientSignalsView(project));
  });

  app.get('/projects/:id/signals/export.csv', auth, async (request, reply) => {
    const project = await scopedProject(request, reply);
    if (!project) return;
    if (!hasSignals(project)) return reply.status(404).send({ message: 'Not available for this project' });
    const csv = await clientDailyCsv(project.id, request.query || {});
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="visits-by-day.csv"')
      .header('cache-control', 'private, no-store')
      .send(csv);
  });
}
