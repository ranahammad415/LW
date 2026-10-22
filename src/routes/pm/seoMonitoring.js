/**
 * Business listings (citations / NAP, EmDash contract 1.8.0 §39) and AI-answer prompts, staff side. Prefix /api/pm.
 * docs/ledger/features/local-seo.md §Citations, features/analytics.md §AI visibility.
 *
 * Who: OWNER (every project) and PM (their projects: ensureProjectAccess). TEAM_MEMBER / CONTRACTOR / CLIENT: 403.
 * Writes (pull, canonical NAP, listing edit, Check now) are for people only: agent accounts and API tokens get 403
 * HUMAN_ONLY before any site or vendor call (the site refuses agents again). Each write route is rate limited; the paid
 * "Check now" also needs CITATIONS_MONITOR_ENABLED and has a 6 h per-project cooldown read from the database.
 */
import { prisma } from '../../lib/prisma.js';
import { ensureProjectAccess } from '../../lib/ensureProjectAccess.js';
import { isAgentOrToken } from '../../lib/apiTokens.js';
import { CmsBridgeError } from '../../lib/siteAdapters/emdash.js';
import { LOCAL_PROJECT_SELECT } from '../../lib/localRank.js';
import { startBackgroundRun, runView } from '../../lib/analytics/syncRuns.js';
import {
  hasSeoCitations,
  pullCitations,
  setCanonicalNap,
  staffCitationsView,
  staffUpsertCitation,
} from '../../lib/citations/citations.js';
import { checkProjectCitations, isCitationsMonitorEnabled, isPageCheckEnabled, manualCheckBlocker, PAGE_CHECKS_PER_PROJECT } from '../../lib/citations/monitor.js';
import { staffAiPromptsView } from '../../lib/analytics/aiVisibilityScheduled.js';
import { idempotency } from '../../lib/idempotency.js';

export const SEO_MONITORING_ROLES = ['OWNER', 'PM'];
const WRITE_LIMIT = { rateLimit: { max: 20, timeWindow: '10 minutes' } };
const PROJECT_SELECT = Object.freeze({ ...LOCAL_PROJECT_SELECT, cmsType: true, cmsCapabilities: true, cmsRepairNeededAt: true });

export async function rejectAgentWrite(request, reply) {
  if (isAgentOrToken(request)) {
    return reply.status(403).send({ code: 'HUMAN_ONLY', message: 'Agent accounts and API tokens cannot change business listings or start a check' });
  }
}

async function projectFor(request, reply) {
  if (!SEO_MONITORING_ROLES.includes(request.user?.role)) {
    reply.status(403).send({ message: 'Access denied' });
    return null;
  }
  const project = await prisma.project.findUnique({ where: { id: String(request.params.id) }, select: PROJECT_SELECT });
  if (!project || !(await ensureProjectAccess(project, request.user))) {
    reply.status(project ? 403 : 404).send({ message: project ? 'Access denied' : 'Project not found' });
    return null;
  }
  return project;
}

function sendError(reply, err, log) {
  if (err instanceof CmsBridgeError) {
    let status = err.status || 502;
    if (status === 401 || (status >= 500 && status !== 503)) status = 502;
    if (status === 501) status = 409;
    return reply.status(status).send({ code: err.code, message: err.message, ...(err.details && typeof err.details === 'object' ? { details: err.details } : {}) });
  }
  log?.error?.({ code: err?.code || 'INTERNAL', message: err?.message }, 'Business listings route failed');
  return reply.status(500).send({ message: 'Request failed' });
}

function needCapability(project, reply) {
  if (hasSeoCitations(project)) return false;
  reply.status(409).send({ code: 'NO_CAPABILITY', message: 'The site does not share its business listings yet (EmDash sites with the 1.8.0 bridge).' });
  return true;
}

const view = (project) => staffCitationsView(project, { monitorEnabled: isCitationsMonitorEnabled() });

/** The staff UI sends its key as body.idempotencyKey (one per user action); a valid one also keys the OS-05 store. */
const BODY_KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;
export const citationUpsertKey = (request) => {
  const k = request.body?.idempotencyKey;
  return typeof k === 'string' && BODY_KEY_RE.test(k) ? k : undefined;
};

export async function pmSeoMonitoringRoutes(app) {
  const read = { onRequest: [app.verifyJwt] };
  const write = { onRequest: [app.verifyJwt, rejectAgentWrite], config: WRITE_LIMIT };
  // O-C180-1: a repeated key is answered from the stored first response (re-sending would carry a fresh last_checked
  // and the new baseRev → 409 CONFLICT_REV / IDEMPOTENCY_MISMATCH). Same key + different body → 409
  // IDEMPOTENCY_KEY_REUSED. 5xx releases the key (OS-05 semantics).
  const idemUpsert = idempotency('POST /api/pm/projects/:id/citations/upsert', { keyFrom: citationUpsertKey });
  const upsertOpts = { ...write, preHandler: idemUpsert.preHandler, onSend: idemUpsert.onSend };

  app.get('/projects/:id/citations', read, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    reply.header('cache-control', 'no-store');
    return reply.send(await view(project));
  });

  // Re-read the site's list now (free, read-only).
  app.post('/projects/:id/citations/pull', write, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    if (needCapability(project, reply)) return;
    try {
      await pullCitations(project.id);
    } catch (err) {
      return sendError(reply, err, request.log);
    }
    return reply.send(await view(project));
  });

  // Canonical NAP (the record listings are compared with): body { nap: {name, phone, address, zip, city, hours, website} | null }.
  app.put('/projects/:id/citations/canonical', write, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    try {
      await setCanonicalNap(project.id, request.body?.nap === null ? null : request.body?.nap, request.user);
    } catch (err) {
      return sendError(reply, err, request.log);
    }
    return reply.send(await view(project));
  });

  // Edit one listing (OS fields) or add one: { baseRev, item, create?, idempotencyKey? } → seo-citations-upsert as the person.
  app.post('/projects/:id/citations/upsert', upsertOpts, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    if (needCapability(project, reply)) return;
    try {
      const out = await staffUpsertCitation(project.id, request.user, request.body || {}, { idempotencyKey: request.body?.idempotencyKey });
      return reply.send({ result: { applied: out.applied, rejected: out.rejected, warnings: out.warnings, rev: out.rev }, ...(await view(project)) });
    } catch (err) {
      if (err instanceof CmsBridgeError && err.code === 'CONFLICT_REV') {
        return reply.status(409).send({ code: 'CONFLICT_REV', message: 'The listings changed on the site since you opened them. Review the current list and redo the edit.', currentRev: err.details?.currentRev ?? null, view: await view(project) });
      }
      return sendError(reply, err, request.log);
    }
  });

  // Check now (paid: one listings search + optional page checks). Background 202 with a run id (GET /local-seo/runs/:runId).
  app.post('/projects/:id/citations/check', write, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    const blocker = await manualCheckBlocker(project);
    if (blocker) {
      if (blocker.retryAfterSec) reply.header('retry-after', String(blocker.retryAfterSec));
      return reply.status(blocker.status).send({ code: blocker.code, message: blocker.message, ...(blocker.retryAfterSec ? { retryAfterSec: blocker.retryAfterSec } : {}) });
    }
    const { run, existing } = await startBackgroundRun(
      { kind: 'citations_check', projectId: project.id, requestedById: request.user.id, log: request.log },
      () => checkProjectCitations(project, { trigger: 'manual', userId: request.user.id, pageBudget: isPageCheckEnabled() ? PAGE_CHECKS_PER_PROJECT : 0 })
    );
    return reply.status(202).send({ run: runView(run), existing });
  });

  // AI answers: the latest monthly run per prompt and platform (staff only: platforms, competitors, cost).
  app.get('/projects/:id/ai-prompts', read, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    reply.header('cache-control', 'no-store');
    return reply.send(await staffAiPromptsView(project));
  });
}
