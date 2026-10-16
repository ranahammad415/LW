/**
 * EmDash v1.4.0 (§25): read-only SEO profile views + proposals from the OS. Staff only; proposals by a human OWNER or
 * the project's lead PM; no contract decisions from the OS (D13 — those stay in the EmDash admin).
 */
import { prisma } from '../../lib/prisma.js';
import { ensureProjectAccess } from '../../lib/ensureProjectAccess.js';
import { CmsBridgeError } from '../../lib/siteAdapters/emdash.js';
import {
  loadProfileProject,
  listProfiles,
  getProfile,
  getKeywordRegistry,
  getBrief,
  createProposal,
  listProposals,
  canPropose,
  profileErrorMessage,
} from '../../lib/cmsSeoProfiles.js';

const STAFF = ['OWNER', 'PM', 'TEAM_MEMBER', 'CONTRACTOR'];

async function requireStaff(request, reply) {
  if (!STAFF.includes(request.user?.role)) return reply.status(403).send({ message: 'Staff access required' });
}

function sendError(reply, err, log) {
  if (err instanceof CmsBridgeError) {
    const friendly = profileErrorMessage(err);
    const auth = ['BAD_SIGNATURE', 'UNKNOWN_KEY', 'UNKNOWN_SITE', 'STALE_TIMESTAMP', 'REPLAY'].includes(err.code);
    let status = err.status || 502;
    if (auth || status === 401) status = 502;
    else if (status === 501) status = 409;
    else if (status >= 500 && status !== 503) status = 502;
    return reply.status(status).send({
      code: err.code,
      message: friendly || (auth ? `The EmDash site rejected Agency OS's signature (${err.code}).` : err.message),
      retryable: !!err.retryable,
      ...(err.details?.errors ? { details: { errors: err.details.errors } } : {}),
    });
  }
  if (err?.name === 'CmsKeyConfigError') return reply.status(503).send({ code: 'CMS_KEY_ENCRYPTION_KEY_MISSING', message: err.message });
  log?.error?.({ err }, 'SEO profile route failed');
  return reply.status(500).send({ message: 'Request failed' });
}

function formatProposal(p) {
  return {
    proposalId: p.proposalId,
    pageId: p.pageId,
    state: p.state,
    patch: p.patch,
    reason: p.reason,
    source: p.source,
    createdByName: p.createdByName,
    decidedByName: p.decidedByName,
    decidedAt: p.decidedAt,
    decisionNote: p.decisionNote,
    createdAt: p.siteCreatedAt || p.createdAt,
  };
}

export async function pmSeoProfileRoutes(app) {
  const staff = { onRequest: [app.verifyJwt, requireStaff] };

  const withProject = async (request, reply) => {
    const project = await loadProfileProject(request.params.projectId);
    if (!(await ensureProjectAccess(project, request.user))) {
      reply.status(403).send({ message: 'Access denied' });
      return null;
    }
    return project;
  };

  app.get('/projects/:projectId/seo-profiles', staff, async (request, reply) => {
    try {
      const project = await withProject(request, reply);
      if (!project) return;
      const res = await listProfiles(project.id, { cursor: request.query?.cursor, status: request.query?.status });
      return reply.send({ ...res, canPropose: canPropose(request.user, project) });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // Mirror only (no site call): last known profile summaries, e.g. when the site is warming up.
  app.get('/projects/:projectId/seo-profiles/mirror', staff, async (request, reply) => {
    try {
      const project = await prisma.project.findUnique({ where: { id: request.params.projectId }, select: { id: true, clientId: true, leadPmId: true } });
      if (!project || !(await ensureProjectAccess(project, request.user))) return reply.status(403).send({ message: 'Access denied' });
      const items = await prisma.cmsSeoProfile.findMany({ where: { projectId: project.id }, orderBy: { pageId: 'asc' }, take: 500 });
      return reply.send({ items });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.get('/projects/:projectId/seo-profiles/:pageId', staff, async (request, reply) => {
    try {
      const project = await withProject(request, reply);
      if (!project) return;
      const [profile, proposals] = await Promise.all([getProfile(project.id, request.params.pageId), listProposals(project.id, request.params.pageId)]);
      return reply.send({ profile, proposals: proposals.map(formatProposal), canPropose: canPropose(request.user, project) });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.get('/projects/:projectId/seo-profiles/:pageId/brief', staff, async (request, reply) => {
    try {
      const project = await withProject(request, reply);
      if (!project) return;
      return reply.send({ brief: await getBrief(project.id, request.params.pageId) });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.get('/projects/:projectId/seo-keywords', staff, async (request, reply) => {
    try {
      const project = await withProject(request, reply);
      if (!project) return;
      const role = ['primary', 'secondary', 'question', 'avoid', 'candidate'].includes(request.query?.role) ? request.query.role : null;
      return reply.send(await getKeywordRegistry(project.id, { cursor: request.query?.cursor, role }));
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // proposal-create: a request for the site's human editors; decided only in the EmDash admin (D13).
  app.post('/projects/:projectId/seo-profiles/:pageId/proposals', staff, async (request, reply) => {
    try {
      const project = await withProject(request, reply);
      if (!project) return;
      const b = request.body || {};
      const row = await createProposal({ projectId: project.id, pageId: request.params.pageId, patch: b.patch, reason: b.reason, user: request.user, log: request.log });
      return reply.status(201).send({ proposal: row ? formatProposal(row) : null });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });
}
