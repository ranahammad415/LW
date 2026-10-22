/**
 * Health score v2, staff side. Prefix /api/pm. docs/ledger/features/health-score.md.
 *
 * Who: OWNER (everything) and PM (projects: ensureProjectAccess; clients: lead or secondary PM). Everyone else 403.
 * Agents (isAgent) may read; agents and API tokens never write the note or recompute (403 HUMAN_ONLY). API tokens
 * cannot reach these routes at all (lib/apiTokens.js DENIED_ROUTES).
 */
import { prisma } from '../../lib/prisma.js';
import { ensureProjectAccess } from '../../lib/ensureProjectAccess.js';
import { isAgentOrToken } from '../../lib/apiTokens.js';
import { loadProjectStaffView, loadClientStaffView } from '../../lib/health/healthViews.js';
import { recomputeProject } from '../../lib/health/healthScoreService.js';
import { computeDeliveryHealth } from '../../lib/health/deliveryHealth.js';

export const HEALTH_NOTE_MAX = 500;

/** onRequest hook (after verifyJwt): health writes (config, note, recompute) are for people only. */
export async function rejectAgentHealthWrite(request, reply) {
  if (isAgentOrToken(request)) {
    return reply.status(403).send({ code: 'HUMAN_ONLY', message: 'Agent accounts and API tokens cannot change health score settings, notes or recompute scores' });
  }
}

function compareOf(q) {
  return String(q?.compare) === '7' ? 7 : 28;
}

async function projectFor(request, reply) {
  const project = await prisma.project.findUnique({
    where: { id: String(request.params.projectId) },
    select: { id: true, clientId: true, leadPmId: true },
  });
  if (!project) {
    reply.status(404).send({ message: 'Project not found' });
    return null;
  }
  if (!(await ensureProjectAccess(project, request.user))) {
    reply.status(403).send({ message: 'Access denied' });
    return null;
  }
  return project;
}

/** OWNER: any client. PM: only a client they lead or second-lead. */
async function clientFor(request, reply) {
  const client = await prisma.clientAccount.findUnique({
    where: { id: String(request.params.clientId) },
    select: { id: true, leadPmId: true, secondaryPmId: true },
  });
  if (!client) {
    reply.status(404).send({ message: 'Client not found' });
    return null;
  }
  if (request.user.role !== 'OWNER' && client.leadPmId !== request.user.id && client.secondaryPmId !== request.user.id) {
    reply.status(403).send({ message: 'Access denied' });
    return null;
  }
  return client;
}

export async function pmHealthRoutes(app) {
  const read = { onRequest: [app.verifyJwt, app.requirePM] };
  const write = { onRequest: [app.verifyJwt, app.requirePM, rejectAgentHealthWrite] };

  app.get('/projects/:projectId/health', read, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    reply.header('cache-control', 'no-store');
    return reply.send(await loadProjectStaffView(project.id, { compare: compareOf(request.query) }));
  });

  app.post('/projects/:projectId/health/recompute', write, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    const payload = await recomputeProject(project.id);
    if (!payload) return reply.status(409).send({ code: 'NOT_SCORED', message: 'This project type has no health score' });
    return reply.send(await loadProjectStaffView(project.id, { compare: compareOf(request.query) }));
  });

  app.get('/clients/:clientId/health', read, async (request, reply) => {
    const client = await clientFor(request, reply);
    if (!client) return;
    const [view, deliveryHealth] = await Promise.all([
      loadClientStaffView(client.id, { compare: compareOf(request.query) }),
      computeDeliveryHealth(client.id),
    ]);
    reply.header('cache-control', 'no-store');
    return reply.send({ ...view, deliveryHealth });
  });

  app.put('/clients/:clientId/health-note', write, async (request, reply) => {
    const client = await clientFor(request, reply);
    if (!client) return;
    const raw = request.body?.note;
    if (raw != null && typeof raw !== 'string') return reply.status(400).send({ message: 'note must be a string' });
    const text = (raw || '').trim();
    if (text.length > HEALTH_NOTE_MAX) return reply.status(400).send({ message: `A note is at most ${HEALTH_NOTE_MAX} characters.` });
    const at = new Date();
    await prisma.clientAccount.update({
      where: { id: client.id },
      data: { healthNote: text || null, healthNoteById: request.user.id, healthNoteAt: at },
    });
    return reply.send({ note: text || null, by: request.user.name || null, at: at.toISOString() });
  });
}
