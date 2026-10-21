/**
 * Security platform, staff side (EmDash contract v1.6.0 §36 / v1.6.1 §37, plan §5.5). Prefix /api/pm.
 *
 * Who: OWNER (every site) and PM (their projects: ensureProjectAccess). TEAM_MEMBER / CONTRACTOR and clients: 403.
 * Agents: API tokens never reach /api/pm/security (lib/apiTokens.js DENIED_PREFIXES); agent accounts (isAgent) may
 * read but never write, refresh, note, change settings, run scans or acknowledge (403 before any site call).
 */
import { prisma } from '../../lib/prisma.js';
import { ensureProjectAccess } from '../../lib/ensureProjectAccess.js';
import { isAgentOrToken } from '../../lib/apiTokens.js';
import { CmsBridgeError } from '../../lib/siteAdapters/emdash.js';
import { isCheckId, isoOrNull } from '../../lib/siteAdapters/security.js';
import { pullSecurity, hasSecurityConfig } from '../../lib/security/securitySync.js';
import { fleetView, siteSecurityView } from '../../lib/security/securityViews.js';
import { configView, pullSecurityConfig, setSecurityConfig, runSecurityScan, ackSecurityCheck } from '../../lib/security/securityConfig.js';

export const SECURITY_ROLES = ['OWNER', 'PM'];

function sendError(reply, err, log) {
  if (err instanceof CmsBridgeError) {
    let status = err.status || 502;
    if (status === 401 || (status >= 500 && status !== 503)) status = 502;
    if (status === 501) status = 409;
    if (err.code === 'RATE_LIMITED') {
      const sec = Number(err.details?.retryAfterSec) || 60;
      reply.header('retry-after', String(sec));
      return reply.status(429).send({ code: err.code, message: err.message, retryAfterSec: sec });
    }
    return reply.status(status).send({ code: err.code, message: err.message, ...(err.details && typeof err.details === 'object' ? { details: err.details } : {}) });
  }
  log?.error?.({ code: err?.code || 'INTERNAL', message: err?.message }, 'Security route failed');
  return reply.status(500).send({ message: 'Request failed' });
}

/** onRequest hook (after verifyJwt): security writes are for people only (agents author, never act on security). */
export async function rejectAgentSecurityWrite(request, reply) {
  if (isAgentOrToken(request)) {
    return reply.status(403).send({ code: 'HUMAN_ONLY', message: 'Agent accounts and API tokens cannot change security settings, run scans or acknowledge findings' });
  }
}

async function projectFor(request, reply) {
  if (!SECURITY_ROLES.includes(request.user?.role)) {
    reply.status(403).send({ message: 'Access denied' });
    return null;
  }
  const project = await prisma.project.findUnique({
    where: { id: String(request.params.projectId) },
    select: { id: true, name: true, clientId: true, leadPmId: true, cmsType: true, cmsCapabilities: true, cmsRepairNeededAt: true },
  });
  if (!project || !(await ensureProjectAccess(project, request.user))) {
    reply.status(project ? 403 : 404).send({ message: project ? 'Access denied' : 'Project not found' });
    return null;
  }
  return project;
}

export async function pmSecurityRoutes(app) {
  const read = { onRequest: [app.verifyJwt] };
  const write = { onRequest: [app.verifyJwt, rejectAgentSecurityWrite] };

  app.get('/security/fleet', read, async (request, reply) => {
    if (!SECURITY_ROLES.includes(request.user?.role)) return reply.status(403).send({ message: 'Access denied' });
    try {
      return reply.send({ sites: await fleetView(request.user) });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.get('/security/projects/:projectId', read, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      const days = Number(request.query?.days) || 90;
      reply.header('cache-control', 'no-store');
      return reply.send(await siteSecurityView(project, { days }));
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.post('/security/projects/:projectId/refresh', write, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      const result = await pullSecurity(project.id, { interactive: true, log: request.log });
      return reply.send({ result, site: await siteSecurityView(project) });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // OS-side "what the agency is doing" note + ETA for one item (shown to the client next to the item's plain text).
  app.put('/security/projects/:projectId/notes/:checkId', write, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      const checkId = String(request.params.checkId);
      if (!isCheckId(checkId)) return reply.status(400).send({ message: 'Invalid check id' });
      const text = request.body?.note == null ? '' : String(request.body.note).trim();
      if (text.length > 1000) return reply.status(400).send({ message: 'A note is at most 1000 characters.' });
      const etaRaw = request.body?.eta;
      const eta = etaRaw ? isoOrNull(String(etaRaw).length === 10 ? `${etaRaw}T12:00:00Z` : String(etaRaw)) : null;
      if (etaRaw && !eta) return reply.status(400).send({ message: 'Invalid ETA date.' });
      const row = await prisma.securityCheckState.findUnique({ where: { projectId_checkId: { projectId: project.id, checkId } } });
      if (!row) return reply.status(404).send({ message: 'Check not found' });
      await prisma.securityCheckState.update({
        where: { id: row.id },
        data: text
          ? { pmNote: text, pmNoteEta: eta ? new Date(eta) : null, pmNoteById: request.user.id, pmNoteAt: new Date() }
          : { pmNote: null, pmNoteEta: null, pmNoteById: request.user.id, pmNoteAt: new Date() },
      });
      return reply.send({ ok: true, note: text ? { text, eta, by: request.user.name || null } : null });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // ---- v1.6.1 §37: security settings from the OS (capability securityConfig) ----

  const needConfig = (project, reply) => {
    if (hasSecurityConfig(project)) return true;
    reply.status(409).send({ code: 'NOT_IMPLEMENTED', message: 'This site does not allow security settings from Agency OS yet.' });
    return false;
  };

  app.get('/security/projects/:projectId/config', read, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      if (!hasSecurityConfig(project)) return reply.send({ available: false });
      let view = await configView(project.id);
      if (!view || request.query?.refresh === '1' || view.stale) {
        if (project.cmsRepairNeededAt) return reply.send({ available: true, config: view });
        await pullSecurityConfig(project.id);
        view = await configView(project.id);
      }
      reply.header('cache-control', 'no-store');
      return reply.send({ available: true, config: view });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.post('/security/projects/:projectId/config', write, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project || !needConfig(project, reply)) return;
      const out = await setSecurityConfig(project.id, request.user, request.body, { idempotencyKey: request.headers['idempotency-key'] });
      return reply.send({ ...out, config: await configView(project.id) });
    } catch (err) {
      if (err instanceof CmsBridgeError && err.code === 'CONFLICT_REV') {
        return reply.status(409).send({ code: err.code, message: 'The settings were changed meanwhile. The table now shows the current settings; redo your change.', details: { currentRev: err.details?.currentRev ?? null, config: await configView(String(request.params.projectId)).catch(() => null) } });
      }
      return sendError(reply, err, request.log);
    }
  });

  app.post('/security/projects/:projectId/run', write, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project || !needConfig(project, reply)) return;
      const out = await runSecurityScan(project.id, request.user, request.body || {}, { idempotencyKey: request.headers['idempotency-key'] });
      return reply.send(out);
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.post('/security/projects/:projectId/ack', write, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project || !needConfig(project, reply)) return;
      const out = await ackSecurityCheck(project.id, request.user, request.body || {}, { idempotencyKey: request.headers['idempotency-key'] });
      return reply.send(out);
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });
}
