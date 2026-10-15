/**
 * Client portal: EmDash client review from the OS (contract v1.1.0 §21). WordPress projects keep the review-link
 * flow (these routes answer 400 for them). Every route is scoped to the caller's client account (an OWNER is
 * narrowed by X-Client-Id); decisions need a non-viewer client user (requireClientWriter) or an OWNER, who then acts
 * for the client (onBehalfOf).
 */
import { prisma } from '../../lib/prisma.js';
import {
  CLIENT_VISIBLE_STATUSES,
  loadClientReviewContext,
  submitEmdashClientDecision,
  loadClientContentView,
  listSuggestions,
  clientReviewErrorResponse,
} from '../../lib/emdashClientReview.js';

async function scopedProject(request, reply, projectId) {
  const clientIds = request.clientAccountIds || [];
  const project = await prisma.project.findUnique({ where: { id: String(projectId) }, select: { id: true, clientId: true } });
  if (!project || !clientIds.includes(project.clientId)) {
    reply.status(404).send({ message: 'Project not found' });
    return null;
  }
  return project;
}

function clientVisible(row) {
  return !row.isPublished && CLIENT_VISIBLE_STATUSES.includes(row.status);
}

export async function clientContentReviewsEmdashRoutes(app) {
  const read = { onRequest: [app.verifyJwt, app.requireClient] };
  const write = { onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter] };

  // GET /api/client/projects/:id/pipeline/:reviewId/content — text of the draft under review (no ids, no edit URL)
  app.get('/projects/:id/pipeline/:reviewId/content', read, async (request, reply) => {
    const project = await scopedProject(request, reply, request.params.id);
    if (!project) return;
    try {
      const { row } = await loadClientReviewContext(project.id, request.params.reviewId, { requireCapability: false });
      if (!clientVisible(row)) return reply.status(404).send({ message: 'Content review not found' });
      const content = await loadClientContentView(project.id, row);
      return reply.send({ content });
    } catch (err) {
      const { status, body } = clientReviewErrorResponse(err, request.log);
      return reply.status(status).send(body);
    }
  });

  // GET /api/client/projects/:id/pipeline/:reviewId/suggestions — mirrored suggestions with their states
  app.get('/projects/:id/pipeline/:reviewId/suggestions', read, async (request, reply) => {
    const project = await scopedProject(request, reply, request.params.id);
    if (!project) return;
    const row = await prisma.wpContentReview.findFirst({
      where: { id: String(request.params.reviewId), projectId: project.id },
      select: { id: true, status: true, isPublished: true },
    });
    if (!row) return reply.status(404).send({ message: 'Content review not found' });
    return reply.send({ suggestions: await listSuggestions(row.id, { forClient: true }) });
  });

  // POST /api/client/projects/:id/pipeline/:reviewId/decision — approve / request changes / minor changes
  app.post('/projects/:id/pipeline/:reviewId/decision', write, async (request, reply) => {
    const project = await scopedProject(request, reply, request.params.id);
    if (!project) return;
    const role = request.user?.role;
    if (role !== 'CLIENT' && role !== 'OWNER') return reply.status(403).send({ message: 'Only the client can decide here.' });
    const b = request.body || {};
    try {
      await submitEmdashClientDecision({
        projectId: project.id,
        rowId: request.params.reviewId,
        user: request.user,
        input: {
          decision: b.decision,
          comment: b.comment,
          expectedRound: b.expectedRound,
          suggestions: Array.isArray(b.suggestions)
            ? b.suggestions.map((s) => ({ target: { field: s?.field }, quote: s?.quote, proposedText: s?.proposedText, note: s?.note }))
            : undefined,
        },
        clientAccountId: role === 'OWNER' ? project.clientId : null,
        log: request.log,
      });
      const fresh = await prisma.wpContentReview.findUnique({
        where: { id: String(request.params.reviewId) },
        select: { status: true, clientDecision: true, revisionNumber: true },
      });
      return reply.send({ success: true, review: fresh, suggestions: await listSuggestions(String(request.params.reviewId), { forClient: true }) });
    } catch (err) {
      const { status, body } = clientReviewErrorResponse(err, request.log);
      return reply.status(status).send(body);
    }
  });
}
