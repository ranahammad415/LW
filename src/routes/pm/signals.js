/**
 * First-party visit signals and lead attribution, staff side (EmDash contract v1.7.0 §38, plan §6.2). Prefix /api/pm.
 *
 * Who: OWNER (every site) and PM (their projects: ensureProjectAccess). TEAM_MEMBER / CONTRACTOR and clients: 403.
 * API tokens never use these routes (403 HUMAN_ONLY on every route); agent accounts may read but never write
 * (settings, erasure, reclassify, summary refresh → 403 HUMAN_ONLY before any site call). Reclassify is OWNER only.
 * Views are keyed on capabilities.signals; settings on the mirror (site-info.signals present).
 * Responses never carry SignalEvent.id (BIGINT) or payload outside the admin session timeline / lead JSON.
 */
import { prisma } from '../../lib/prisma.js';
import { ensureProjectAccess } from '../../lib/ensureProjectAccess.js';
import { isAgentOrToken } from '../../lib/apiTokens.js';
import { CmsBridgeError } from '../../lib/siteAdapters/emdash.js';
import { hasSignals, loadSignalsMirror, pullSignalsConfig, pullSignalsSummary, setSignalsConfig, signalsConfigView } from '../../lib/signals/config.js';
import { listSessions, sessionTimeline, attributionPaths, geoDeviceHour, dataQuality, staffOverview, staffCsv, leadEventsJson } from '../../lib/signals/views.js';
import { eraseVisitor } from '../../lib/signals/erase.js';
import { reclassifyProject } from '../../lib/signals/reclassify.js';
import { isLeadId } from '../../lib/signals/validate.js';

export const SIGNALS_ROLES = ['OWNER', 'PM'];

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
  log?.error?.({ code: err?.code || 'INTERNAL', message: err?.message }, 'Signals route failed');
  return reply.status(500).send({ message: 'Request failed' });
}

/** onRequest (after verifyJwt): API tokens never reach signals data. */
export async function rejectSignalsToken(request, reply) {
  if (request?.authMethod === 'apiToken') {
    return reply.status(403).send({ code: 'HUMAN_ONLY', message: 'API tokens cannot use visitor signals' });
  }
}

/** onRequest (after verifyJwt): writes are for people only (contract §38.1: signals-config-set is human OWNER / PM). */
export async function rejectSignalsAgentWrite(request, reply) {
  if (isAgentOrToken(request)) {
    return reply.status(403).send({ code: 'HUMAN_ONLY', message: 'Agent accounts and API tokens cannot change visitor-signal settings, erase visitors or reclassify' });
  }
}

async function projectFor(request, reply, roles = SIGNALS_ROLES) {
  if (!roles.includes(request.user?.role)) {
    reply.status(403).send({ message: 'Access denied' });
    return null;
  }
  const project = await prisma.project.findUnique({
    where: { id: String(request.params.projectId) },
    select: { id: true, name: true, clientId: true, leadPmId: true, cmsType: true, cmsCapabilities: true, cmsRepairNeededAt: true, wpUrl: true },
  });
  if (!project || !(await ensureProjectAccess(project, request.user))) {
    reply.status(project ? 403 : 404).send({ message: project ? 'Access denied' : 'Project not found' });
    return null;
  }
  return project;
}

const noStore = (reply) => reply.header('cache-control', 'no-store');

export async function pmSignalsRoutes(app) {
  const read = { onRequest: [app.verifyJwt, rejectSignalsToken] };
  const write = { onRequest: [app.verifyJwt, rejectSignalsAgentWrite] };
  const base = '/signals/projects/:projectId';

  const viewRoute = (suffix, fn) =>
    app.get(`${base}${suffix}`, read, async (request, reply) => {
      try {
        const project = await projectFor(request, reply);
        if (!project) return;
        noStore(reply);
        return reply.send(await fn(project, request));
      } catch (err) {
        return sendError(reply, err, request.log);
      }
    });

  viewRoute('/overview', async (project, request) => {
    const mirror = await loadSignalsMirror(project.id);
    return { ...(await staffOverview(project, request.query || {})), module: !!mirror, enabled: mirror?.config?.enabled ?? null };
  });
  viewRoute('/sessions', (project, request) => listSessions(project.id, request.query || {}));
  viewRoute('/paths', (project, request) => attributionPaths(project.id, request.query || {}));
  viewRoute('/geo', (project, request) => geoDeviceHour(project.id, request.query || {}));
  viewRoute('/quality', (project) => dataQuality(project.id));

  app.get(`${base}/sessions/:sessionId`, read, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      const view = await sessionTimeline(project.id, String(request.params.sessionId));
      if (!view) return reply.status(404).send({ message: 'Session not found' });
      noStore(reply);
      return reply.send(view);
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // Data quality: live signals-summary (one site call; 60/min per key shared by the four signals routes).
  app.post(`${base}/quality/refresh`, write, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      if (!(await loadSignalsMirror(project.id))) return reply.status(409).send({ code: 'NOT_IMPLEMENTED', message: 'This site has no visitor signals module yet.' });
      const summary = await pullSignalsSummary(project.id, { hours: Math.min(168, Math.max(1, Number(request.body?.hours) || 24)) });
      return reply.send({ summary, quality: await dataQuality(project.id) });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // ---- settings (signals-config-get / -set): mirror; human OWNER / PM writes with baseRev + idempotency key ----

  app.get(`${base}/config`, read, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      let view = await signalsConfigView(project.id);
      if (!view) return reply.send({ available: false });
      if ((request.query?.refresh === '1' || view.stale || !view.config) && !project.cmsRepairNeededAt && !request.user?.isAgent) {
        await pullSignalsConfig(project.id);
        view = await signalsConfigView(project.id);
      }
      noStore(reply);
      return reply.send({ available: true, ...view });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.post(`${base}/config`, write, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      if (!(await loadSignalsMirror(project.id))) return reply.status(409).send({ code: 'NOT_IMPLEMENTED', message: 'This site has no visitor signals module yet.' });
      const out = await setSignalsConfig(project.id, request.user, request.body, { idempotencyKey: request.headers['idempotency-key'] });
      return reply.send({ ...out, ...(await signalsConfigView(project.id)) });
    } catch (err) {
      if (err instanceof CmsBridgeError && err.code === 'CONFLICT_REV') {
        return reply.status(409).send({
          code: err.code,
          message: 'The visitor-signal settings were changed meanwhile. The form now shows the current settings; redo your change.',
          details: { currentRev: err.details?.currentRev ?? null, ...((await signalsConfigView(String(request.params.projectId)).catch(() => null)) || {}) },
        });
      }
      return sendError(reply, err, request.log);
    }
  });

  // ---- erasure by visitor id (subject request) ----
  app.post(`${base}/erase`, write, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      const out = await eraseVisitor({ projectId: project.id, visitorId: String(request.body?.visitorId || '').trim(), reason: request.body?.reason, user: request.user, log: request.log });
      return reply.send(out);
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // ---- exports (never payload; the staff CSV may carry visitor ids) ----
  app.get(`${base}/export.csv`, read, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      const csv = await staffCsv(project.id, request.query || {});
      const grain = request.query?.grain === 'day' ? 'days' : 'sessions';
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="visits-${grain}-${project.id.slice(0, 8)}.csv"`)
        .header('cache-control', 'private, no-store')
        .send(csv);
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.get(`${base}/leads/:leadId/events.json`, read, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      const leadId = String(request.params.leadId);
      if (!isLeadId(leadId)) return reply.status(400).send({ message: 'Invalid lead id' });
      const out = await leadEventsJson(project.id, leadId);
      if (!out) return reply.status(404).send({ message: 'No attribution for this lead' });
      noStore(reply);
      return reply.send(out);
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // ---- reclassify (manual, OWNER, after a referrer table update) ----
  app.post(`${base}/reclassify`, write, async (request, reply) => {
    try {
      const project = await projectFor(request, reply, ['OWNER']);
      if (!project) return;
      if (!hasSignals(project)) return reply.status(409).send({ code: 'NOT_IMPLEMENTED', message: 'Visitor signals are not on for this site.' });
      return reply.send(await reclassifyProject(project.id, { log: request.log }));
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });
}
