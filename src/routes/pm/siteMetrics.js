/**
 * Site metrics, staff side (docs/ledger/features/site-metrics.md). Prefix /api/pm.
 *
 * Who: OWNER (every project) and PM (their projects: ensureProjectAccess). TEAM_MEMBER / CONTRACTOR / CLIENT: 403.
 * Refresh routes are for people only: agent accounts and API tokens get 403 HUMAN_ONLY before any outside call.
 * The backlink refresh costs money (DataForSEO), so it is OWNER-only. Every write (page-speed refresh, backlink refresh,
 * uptime check) is rate-limited per instance (route rateLimit) and per project through the database (cooldown on the
 * latest stored row, cluster-safe). GET /uptime/fleet: OWNER sees every site, a PM only their own.
 */
import { prisma } from '../../lib/prisma.js';
import { ensureProjectAccess } from '../../lib/ensureProjectAccess.js';
import { isAgentOrToken } from '../../lib/apiTokens.js';
import {
  isPageSpeedEnabled,
  runPageSpeedForProject,
  staffPageSpeedView,
  REFRESH_COOLDOWN_MS,
} from '../../lib/pageSpeed.js';
import {
  hasDataForSeoCredentials,
  snapshotProject,
  staffBacklinkView,
  backlinkTarget,
  monthKey,
  BACKLINK_REFRESH_COOLDOWN_MS,
} from '../../lib/backlinkSnapshots.js';
import { isUptimeEnabled, probeProject, staffUptimeView, uptimeFleetView, siteHomeUrl } from '../../lib/uptime.js';

export const SITE_METRICS_ROLES = ['OWNER', 'PM'];

export async function rejectAgentRefresh(request, reply) {
  if (isAgentOrToken(request)) {
    return reply.status(403).send({ code: 'HUMAN_ONLY', message: 'Agent accounts and API tokens cannot start a refresh' });
  }
}

async function projectFor(request, reply) {
  if (!SITE_METRICS_ROLES.includes(request.user?.role)) {
    reply.status(403).send({ message: 'Access denied' });
    return null;
  }
  const project = await prisma.project.findUnique({
    where: { id: String(request.params.id) },
    select: { id: true, name: true, clientId: true, leadPmId: true, wpUrl: true, dataforseoDomain: true, cmsType: true },
  });
  if (!project || !(await ensureProjectAccess(project, request.user))) {
    reply.status(project ? 403 : 404).send({ message: project ? 'Access denied' : 'Project not found' });
    return null;
  }
  return project;
}

function cooldown(reply, sinceMs, windowMs) {
  const sec = Math.max(1, Math.ceil((windowMs - sinceMs) / 1000));
  reply.header('retry-after', String(sec));
  return reply.status(429).send({ code: 'COOLDOWN', message: 'This was refreshed a moment ago. Try again later.', retryAfterSec: sec });
}

const UPTIME_CHECK_COOLDOWN_MS = 60_000;
const REFRESH_LIMIT ={ rateLimit: { max: 6, timeWindow: '10 minutes' } };

export async function pmSiteMetricsRoutes(app) {
  const read = { onRequest: [app.verifyJwt] };
  const write = { onRequest: [app.verifyJwt, rejectAgentRefresh], config: REFRESH_LIMIT };

  app.get('/projects/:id/page-speed', read, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    reply.header('cache-control', 'no-store');
    return reply.send(await staffPageSpeedView(project));
  });

  app.post('/projects/:id/page-speed/refresh', write, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    if (!isPageSpeedEnabled()) return reply.status(409).send({ code: 'DISABLED', message: 'Page speed checks are turned off (PAGESPEED_ENABLED=false).' });
    const last = await prisma.pageSpeedDaily.findFirst({ where: { projectId: project.id }, orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } });
    const since = last ? Date.now() - new Date(last.fetchedAt).getTime() : Infinity;
    if (since < REFRESH_COOLDOWN_MS) return cooldown(reply, since, REFRESH_COOLDOWN_MS);
    const out = await runPageSpeedForProject(project, { parallel: true });
    if (out.skipped) {
      return reply.status(409).send({ code: out.skipped, message: 'This project has no public https site URL to test.' });
    }
    if (out.rateLimited && !Object.values(out.results).includes('ok')) {
      reply.header('retry-after', '3600');
      return reply.status(429).send({ code: 'RATE_LIMITED', message: 'Google PageSpeed quota reached. Try again later.' });
    }
    request.log.info({ projectId: project.id, results: out.results }, 'PageSpeed manual refresh');
    return reply.send({ results: out.results, view: await staffPageSpeedView(project) });
  });

  app.get('/projects/:id/backlinks-summary', read, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    reply.header('cache-control', 'no-store');
    return reply.send(await staffBacklinkView(project));
  });

  app.get('/projects/:id/uptime', read, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    reply.header('cache-control', 'no-store');
    return reply.send(await staffUptimeView(project));
  });

  // Probe now (same rules as the prober, incl. incident logic). People only, once per project per minute.
  app.post('/projects/:id/uptime/check', write, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    if (!isUptimeEnabled()) return reply.status(409).send({ code: 'DISABLED', message: 'Uptime monitoring is turned off (UPTIME_ENABLED=false).' });
    if (!siteHomeUrl(project)) return reply.status(409).send({ code: 'NO_URL', message: 'This project has no public https site URL to monitor.' });
    const last = await prisma.uptimeCheck.findFirst({ where: { projectId: project.id, target: 'home' }, orderBy: { at: 'desc' }, select: { at: true } });
    const since = last ? Date.now() - new Date(last.at).getTime() : Infinity;
    if (since < UPTIME_CHECK_COOLDOWN_MS) return cooldown(reply, since, UPTIME_CHECK_COOLDOWN_MS);
    const out = await probeProject(project, { log: request.log });
    return reply.send({ result: { ok: out.ok ?? null, errorClass: out.errorClass ?? null }, view: await staffUptimeView(project) });
  });

  app.get('/uptime/fleet', read, async (request, reply) => {
    if (!SITE_METRICS_ROLES.includes(request.user?.role)) return reply.status(403).send({ message: 'Access denied' });
    reply.header('cache-control', 'no-store');
    return reply.send({ sites: await uptimeFleetView(request.user) });
  });

  // Costs one DataForSEO call: OWNER only, people only, once per project per hour.
  app.post('/projects/:id/backlinks-summary/refresh', write, async (request, reply) => {
    if (request.user?.role !== 'OWNER') return reply.status(403).send({ message: 'Only the agency owner can refresh backlink data' });
    const project = await projectFor(request, reply);
    if (!project) return;
    if (!hasDataForSeoCredentials()) return reply.status(409).send({ code: 'NOT_CONFIGURED', message: 'DataForSEO credentials are not configured.' });
    if (!backlinkTarget(project)) return reply.status(409).send({ code: 'NO_DOMAIN', message: 'Set a domain or site URL for this project first.' });
    const row = await prisma.backlinkSnapshotMonthly.findUnique({
      where: { projectId_month: { projectId: project.id, month: monthKey() } },
      select: { fetchedAt: true },
    });
    const since = row ? Date.now() - new Date(row.fetchedAt).getTime() : Infinity;
    if (since < BACKLINK_REFRESH_COOLDOWN_MS) return cooldown(reply, since, BACKLINK_REFRESH_COOLDOWN_MS);
    const out = await snapshotProject(project);
    request.log.info({ projectId: project.id, status: out.status, errorCode: out.errorCode || null, costUsd: out.costUsd ?? null }, 'Backlink snapshot manual refresh');
    return reply.send({ result: { status: out.status, errorCode: out.errorCode || null }, view: await staffBacklinkView(project) });
  });
}
