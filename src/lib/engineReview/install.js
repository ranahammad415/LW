/**
 * Engine review issuer install + routes (OS-11/12/13). Off unless ENGINE_REVIEW_ISSUER_ENABLED=1.
 *
 * Routes (all behind app.verifyJwt):
 *   GET  /api/engine-review/status                              PM/OWNER: { enabled }
 *   POST /api/tasks/:id/engine-review/results      {commentId}  freeze an Engine report        (human PM/OWNER)
 *   GET  /api/tasks/:id/engine-review/results/:snapshotId       show the frozen report + hash   (human PM/OWNER)
 *   POST /api/tasks/:id/engine-review/challenges   {snapshotId,operation,decision,reason}  120 s challenge
 *   POST /api/tasks/:id/engine-review/confirm      {challengeId,confirmation}  → {keyId,event,signature}
 *   GET  /api/tasks/:id/engine-review/outbox                    the task's signed envelopes     (human PM/OWNER)
 *   GET  /api/engine-review/outbox                              pull outbox (OWNER or pinned Engine reporter)
 *   POST /api/engine-review/outbox/:eventId/ack                 mark collected (same callers)
 * Review routes refuse agent accounts and every API token (rejectAgentReviewer) and require a configured browser
 * Origin on writes. Delivery is pull-only (OS-13): no outbound HTTP from the OS.
 */
import { prisma as defaultPrisma } from '../prisma.js';
import { rejectAgentReviewer } from '../agentPolicy.js';
import { tokenProjectIds } from '../apiTokens.js';
import { EngineReviewError, createOsReviewIssuer, validateReviewerMap } from './issuer.js';
import { createPrismaReviewStore } from './store.js';

export function isEngineReviewEnabled(env = process.env) {
  return env.ENGINE_REVIEW_ISSUER_ENABLED === '1';
}

function parseJsonArray(raw, name) {
  try {
    const v = JSON.parse(raw || '[]');
    if (!Array.isArray(v)) throw new Error('not an array');
    return v;
  } catch {
    throw new EngineReviewError('REVIEW_ISSUER_CONFIG', `${name} must be a JSON array.`, 503);
  }
}

/** Reads the issuer config from env (names only in the ledger; values live in the secret store). */
export function loadEngineReviewConfig(env = process.env) {
  const pem = String(env.ENGINE_REVIEW_SIGNING_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
  return {
    issuer: env.ENGINE_REVIEW_ISSUER,
    tenantId: env.ENGINE_REVIEW_TENANT_ID,
    keyId: env.ENGINE_REVIEW_KEY_ID,
    privateKeyPem: pem,
    origins: String(env.FRONTEND_URL || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
    reporterUserIds: parseJsonArray(env.ENGINE_REVIEW_REPORTER_USER_IDS_JSON, 'ENGINE_REVIEW_REPORTER_USER_IDS_JSON').filter((x) => typeof x === 'string' && x),
    reviewers: parseJsonArray(env.ENGINE_REVIEW_REVIEWERS_JSON, 'ENGINE_REVIEW_REVIEWERS_JSON'),
  };
}

/**
 * Builds the issuer: env config → reviewer map checked against the DB (no agents, active, matching role,
 * not a reporter) → key check. Throws EngineReviewError on any problem.
 */
export async function buildEngineReviewIssuer({ prisma = defaultPrisma, env = process.env } = {}) {
  const config = loadEngineReviewConfig(env);
  await validateReviewerMap(prisma, config.reviewers, config.reporterUserIds);
  return createOsReviewIssuer({ prisma, store: createPrismaReviewStore(prisma), config });
}

function sendError(reply, err) {
  if (err instanceof EngineReviewError) return reply.status(err.status).send({ message: err.message, code: err.code });
  if (err?.code === 'P2034') return reply.status(409).send({ message: 'Review changed concurrently; retry.', code: 'REVIEW_RETRY' });
  throw err;
}

async function canPmTask(prisma, taskId, user) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, project: { select: { leadPmId: true, client: { select: { leadPmId: true, secondaryPmId: true } } } } },
  });
  if (!task) return null;
  if (user.role === 'OWNER') return task;
  const p = task.project;
  if (user.role === 'PM' && [p?.leadPmId, p?.client?.leadPmId, p?.client?.secondaryPmId].includes(user.id)) return task;
  return false;
}

function outboxItem(row) {
  return {
    eventId: row.eventId,
    taskId: row.taskId,
    osProjectId: row.osProjectId,
    resultId: row.resultId,
    version: row.version,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ackedAt: row.ackedAt,
    envelope: JSON.parse(row.data),
  };
}

/**
 * Registers the routes. `state` = { issuer } when enabled and valid, { issuer: null, reason } otherwise
 * (review/outbox routes then answer 503 REVIEW_ISSUER_DISABLED; status answers enabled:false).
 */
export function registerEngineReviewRoutes(app, { state, prisma = defaultPrisma }) {
  const disabled = (reply) =>
    reply.status(503).send({ message: 'The Engine review issuer is not enabled on this OS.', code: 'REVIEW_ISSUER_DISABLED' });
  const originGuard = async (request, reply) => {
    if (request.method === 'GET' || !state.issuer) return;
    if (!state.issuer.origins.includes(request.headers.origin)) {
      return reply.status(403).send({ message: 'Review writes require the configured OS browser origin.', code: 'FORBIDDEN' });
    }
  };
  const review = { onRequest: [app.verifyJwt, rejectAgentReviewer, originGuard] };
  const wrap = (fn) => async (request, reply) => {
    if (!state.issuer) return disabled(reply);
    try {
      return reply.send(await fn(request));
    } catch (err) {
      return sendError(reply, err);
    }
  };

  app.get('/api/engine-review/status', { onRequest: [app.verifyJwt, app.requirePM] }, async () => ({ enabled: !!state.issuer }));

  app.post('/api/tasks/:id/engine-review/results', review, wrap((r) => state.issuer.freeze(r.params.id, r.body, r.user)));
  app.get('/api/tasks/:id/engine-review/results/:snapshotId', review, wrap((r) => state.issuer.view(r.params.id, r.params.snapshotId, r.user)));
  app.post('/api/tasks/:id/engine-review/challenges', review, wrap((r) => state.issuer.challenge(r.params.id, r.body, r.user)));
  app.post('/api/tasks/:id/engine-review/confirm', review, wrap((r) => state.issuer.confirm(r.params.id, r.body, r.user, r)));

  app.get('/api/tasks/:id/engine-review/outbox', { onRequest: [app.verifyJwt, rejectAgentReviewer] }, async (request, reply) => {
    if (!state.issuer) return disabled(reply);
    const task = await canPmTask(prisma, request.params.id, request.user);
    if (task === null) return reply.status(404).send({ message: 'Task not found' });
    if (!task) return reply.status(403).send({ message: 'PM or Owner access to this task is required' });
    const rows = await prisma.engineReviewOutbox.findMany({ where: { taskId: task.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    reply.header('Cache-Control', 'no-store');
    return reply.send(rows.map(outboxItem));
  });

  // Pull outbox for the Engine / Workforce app (OS-13). OWNER, or the pinned Engine reporter account (its API token
  // may be narrowed with the engine-review:outbox scope and a project allowlist).
  const outboxCaller = async (request, reply) => {
    if (!state.issuer) return disabled(reply);
    const u = request.user;
    if (u?.role !== 'OWNER' && !state.issuer.reporterUserIds.includes(u?.id)) {
      return reply.status(403).send({ message: 'Only the OWNER or the Engine service account can read the review outbox' });
    }
  };
  app.get('/api/engine-review/outbox', { onRequest: [app.verifyJwt, outboxCaller] }, async (request, reply) => {
    const includeAcked = request.query?.includeAcked === '1';
    const includeExpired = request.query?.includeExpired === '1';
    const since = request.query?.since ? new Date(String(request.query.since)) : null;
    if (since && Number.isNaN(since.getTime())) return reply.status(400).send({ message: 'since must be an ISO date' });
    const allowed = tokenProjectIds(request);
    const where = {
      ...(includeAcked ? {} : { ackedAt: null }),
      ...(includeExpired ? {} : { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }),
      ...(since ? { createdAt: { gt: since } } : {}),
      ...(allowed ? { osProjectId: { in: allowed } } : {}),
    };
    const rows = await prisma.engineReviewOutbox.findMany({ where, orderBy: { createdAt: 'asc' }, take: 100 });
    reply.header('Cache-Control', 'no-store');
    return reply.send({ items: rows.map(outboxItem) });
  });

  app.post('/api/engine-review/outbox/:eventId/ack', { onRequest: [app.verifyJwt, outboxCaller] }, async (request, reply) => {
    const row = await prisma.engineReviewOutbox.findUnique({ where: { eventId: request.params.eventId } });
    const allowed = tokenProjectIds(request);
    if (!row || (allowed && !allowed.includes(row.osProjectId))) return reply.status(404).send({ message: 'Outbox event not found' });
    if (!row.ackedAt) {
      await prisma.engineReviewOutbox.updateMany({ where: { eventId: row.eventId, ackedAt: null }, data: { ackedAt: new Date(), ackedById: request.user.id } });
    }
    const updated = await prisma.engineReviewOutbox.findUnique({ where: { eventId: row.eventId } });
    return reply.send({ eventId: updated.eventId, ackedAt: updated.ackedAt });
  });
}

/** index.js entry point. Never throws: a bad config leaves the routes answering 503 and logs why. */
export async function installEngineReview(app, { prisma = defaultPrisma, env = process.env } = {}) {
  const state = { issuer: null, reason: 'disabled' };
  if (isEngineReviewEnabled(env)) {
    try {
      state.issuer = await buildEngineReviewIssuer({ prisma, env });
      state.reason = null;
      app.log.info('Engine review issuer enabled');
    } catch (err) {
      state.reason = err?.code || 'error';
      app.log.error({ code: err?.code, message: err?.message }, 'Engine review issuer disabled: configuration rejected');
    }
  }
  registerEngineReviewRoutes(app, { state, prisma });
  return state;
}
