/**
 * Health score v2, OWNER admin. Prefix /api/admin. docs/ledger/features/health-score.md.
 * requireOwner on every route; writes are humans only (agents and API tokens: 403 HUMAN_ONLY; tokens cannot reach
 * /api/admin/health/* at all, lib/apiTokens.js DENIED_PREFIXES).
 */
import { prisma } from '../../lib/prisma.js';
import { rejectAgentHealthWrite } from '../pm/health.js';
import {
  getActiveConfig,
  validateConfig,
  listConfigVersions,
  createConfigVersion,
  activateConfigVersion,
  ConfigActivationError,
} from '../../lib/health/healthConfig.js';
import {
  recomputeProject, recomputeClient, recomputeAll, backfillProject, profileFor, SCORED_STATUSES,
} from '../../lib/health/healthScoreService.js';
import { HEALTH_PROJECT_SELECT } from '../../lib/health/healthBundle.js';

export const BACKFILL_ROUTE_MAX_DAYS = 90;
export const BACKFILL_ROUTE_MAX_PROJECTS = 50;

async function activeView() {
  const [row, versions] = await Promise.all([
    prisma.healthScoreConfig.findFirst({ where: { isActive: true }, orderBy: { version: 'desc' } }),
    listConfigVersions(),
  ]);
  if (row) return { active: { version: row.version, config: row.config, note: row.note, createdAt: row.createdAt }, versions };
  const cfg = await getActiveConfig();
  return { active: { version: cfg.version, config: cfg, note: 'built-in defaults (no row)', createdAt: null }, versions };
}

export async function adminHealthRoutes(app) {
  const read = { onRequest: [app.verifyJwt, app.requireOwner] };
  const write = { onRequest: [app.verifyJwt, app.requireOwner, rejectAgentHealthWrite] };

  app.get('/health/config', read, async (_request, reply) => reply.send(await activeView()));

  app.put('/health/config', write, async (request, reply) => {
    const v = validateConfig(request.body?.config);
    if (!v.ok) return reply.status(400).send({ code: 'INVALID_CONFIG', message: 'The health score config is not valid', errors: v.errors });
    const note = request.body?.note == null ? null : String(request.body.note).trim().slice(0, 500) || null;
    const row = await createConfigVersion({ config: v.config, note, userId: request.user.id });
    // Today's rows with the new version: in the background (idempotent upserts; the response does not wait).
    recomputeAll({ log: request.log }).catch((err) => request.log.error({ err: err?.message }, 'Health recompute after config change failed'));
    return reply.send({ active: { version: row.version, config: row.config, note: row.note, createdAt: row.createdAt }, recompute: 'started' });
  });

  // Activate a stored version (e.g. the v3 Bing proposal stored inactive by 20261114_bing_webmaster). Owner, people only.
  app.post('/health/config/:version/activate', write, async (request, reply) => {
    try {
      const row = await activateConfigVersion(request.params.version);
      recomputeAll({ log: request.log }).catch((err) => request.log.error({ err: err?.message }, 'Health recompute after config activation failed'));
      return reply.send({ active: { version: row.version, config: row.config, note: row.note, createdAt: row.createdAt }, recompute: 'started' });
    } catch (err) {
      if (err instanceof ConfigActivationError) return reply.status(err.status).send({ code: err.code, message: err.message });
      throw err;
    }
  });

  app.post('/health/recompute', write, async (request, reply) => {
    const projectId = request.body?.projectId ? String(request.body.projectId) : null;
    const clientId = request.body?.clientId ? String(request.body.clientId) : null;
    if (projectId) {
      const out = await recomputeProject(projectId);
      if (!out) return reply.status(404).send({ message: 'Project not found or not scored' });
      return reply.send({ recomputed: 1 });
    }
    if (clientId) {
      const exists = await prisma.clientAccount.findUnique({ where: { id: clientId }, select: { id: true } });
      if (!exists) return reply.status(404).send({ message: 'Client not found' });
      const out = await recomputeClient(clientId);
      return reply.send({ recomputed: out.recomputed });
    }
    const out = await recomputeAll({ log: request.log });
    return reply.send({ recomputed: out.projects, errors: out.errors?.length || 0 });
  });

  app.post('/health/backfill', write, async (request, reply) => {
    const days = Number(request.body?.days ?? BACKFILL_ROUTE_MAX_DAYS);
    if (!Number.isInteger(days) || days < 1 || days > BACKFILL_ROUTE_MAX_DAYS) {
      return reply.status(400).send({ message: `days must be an integer from 1 to ${BACKFILL_ROUTE_MAX_DAYS}` });
    }
    const projectId = request.body?.projectId ? String(request.body.projectId) : null;
    const offset = Math.max(0, Number(request.body?.offset) || 0);
    const projects = projectId
      ? await prisma.project.findMany({ where: { id: projectId }, select: HEALTH_PROJECT_SELECT })
      : await prisma.project.findMany({ where: { status: { in: SCORED_STATUSES } }, select: HEALTH_PROJECT_SELECT, orderBy: { id: 'asc' } });
    const scored = projects.filter((p) => profileFor(p));
    if (projectId && !scored.length) return reply.status(404).send({ message: 'Project not found or not scored' });
    const batch = scored.slice(offset, offset + BACKFILL_ROUTE_MAX_PROJECTS);
    let rows = 0;
    const errors = [];
    for (const p of batch) {
      try {
        rows += (await backfillProject(p.id, { days })).rows;
      } catch (err) {
        errors.push({ projectId: p.id, message: String(err?.message || err).slice(0, 200) });
      }
    }
    const next = offset + batch.length;
    return reply.send({ projects: batch.length, rows, errors, nextOffset: next < scored.length ? next : null });
  });
}
