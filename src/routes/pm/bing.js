/**
 * Bing Webmaster, staff side (docs/ledger/features/bing-webmaster.md). Prefix /api/pm.
 *
 * Who: OWNER (every project) and PM (their projects: ensureProjectAccess). TEAM_MEMBER / CONTRACTOR / CLIENT: 403.
 * Writes are for people only (agent accounts and API tokens: 403 HUMAN_ONLY before any outside call) and have a route
 * rate limit. "Sync now" also has a 15-minute per-project cooldown read from the database (cluster-safe) and runs in
 * the background (202 + GET /bing/runs/:runId).
 * Bing Places (no API): a checklist only (listing URL, claimed toggle, last manual check, NAP row of the citation
 * mirror), shown on the Local SEO tab.
 */
import { prisma } from '../../lib/prisma.js';
import { ensureProjectAccess } from '../../lib/ensureProjectAccess.js';
import { rejectAgentRefresh } from './siteMetrics.js';
import { startBackgroundRun, getRun, runView } from '../../lib/analytics/syncRuns.js';
import { staffBingView } from '../../lib/bing/bingViews.js';
import { runBingSync } from '../../lib/bing/bingSync.js';
import { getBingConnectionStatus, isBingEnabled } from '../../lib/bing/bingAuth.js';

export const BING_ROLES = ['OWNER', 'PM'];
export const BING_SYNC_COOLDOWN_MS = 15 * 60_000;
const SYNC_LIMIT = { rateLimit: { max: 6, timeWindow: '10 minutes' } };
const WRITE_LIMIT = { rateLimit: { max: 20, timeWindow: '10 minutes' } };

export const BING_STAFF_PROJECT_SELECT = Object.freeze({
  id: true,
  name: true,
  clientId: true,
  leadPmId: true,
  gscSiteUrl: true,
  wpUrl: true,
  dataforseoDomain: true,
  gmbLocationName: true,
  localLocationCode: true,
  localLanguageCode: true,
  bingSiteUrl: true,
  bingLastSyncedAt: true,
  bingSyncError: true,
  bingPlacesUrl: true,
  bingPlacesClaimed: true,
  bingPlacesCheckedAt: true,
  client: { select: { websiteUrl: true, agencyName: true } },
});

async function projectFor(request, reply) {
  if (!BING_ROLES.includes(request.user?.role)) {
    reply.status(403).send({ message: 'Access denied' });
    return null;
  }
  const project = await prisma.project.findUnique({ where: { id: String(request.params.id) }, select: BING_STAFF_PROJECT_SELECT });
  if (!project || !(await ensureProjectAccess(project, request.user))) {
    reply.status(project ? 403 : 404).send({ message: project ? 'Access denied' : 'Project not found' });
    return null;
  }
  return project;
}

function cooldown(reply, sinceMs, windowMs) {
  const sec = Math.max(1, Math.ceil((windowMs - sinceMs) / 1000));
  reply.header('retry-after', String(sec));
  return reply.status(429).send({ code: 'COOLDOWN', message: 'Bing was synced a moment ago. Try again later.', retryAfterSec: sec });
}

const BING_PLACES_NAME_RE = /bing/i;
const BING_PLACES_URL_RE = /bingplaces\.com|bing\.com\/(maps|forbusiness|local)/i;

/** Bing Places checklist + the citation-mirror NAP row of the Bing listing (EmDash sites), when the site tracks one. */
export async function bingPlacesView(project) {
  const rows = await prisma.seoCitationMirror.findMany({
    where: { projectId: project.id },
    select: { name: true, url: true, kind: true, listed: true, napStatus: true, lastChecked: true },
    take: 200,
  });
  const row = (rows || []).find((r) => BING_PLACES_URL_RE.test(r.url || '') || BING_PLACES_NAME_RE.test(r.name || '')) || null;
  return {
    url: project.bingPlacesUrl || null,
    claimed: !!project.bingPlacesClaimed,
    checkedAt: project.bingPlacesCheckedAt || null,
    dashboardUrl: 'https://www.bing.com/forbusiness',
    citation: row ? { name: row.name, listed: row.listed, napStatus: row.napStatus, lastChecked: row.lastChecked } : null,
  };
}

/** https URL ≤ 500 chars, or null. Pure. */
export function cleanListingUrl(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().slice(0, 500);
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export async function pmBingRoutes(app) {
  const read = { onRequest: [app.verifyJwt] };
  const sync = { onRequest: [app.verifyJwt, rejectAgentRefresh], config: SYNC_LIMIT };
  const write = { onRequest: [app.verifyJwt, rejectAgentRefresh], config: WRITE_LIMIT };

  app.get('/projects/:id/bing', read, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    reply.header('cache-control', 'no-store');
    return reply.send(await staffBingView(project));
  });

  // Sync this project now (background, 202). Needs the agency connection and a bound site; 15-min cooldown.
  app.post('/projects/:id/bing/sync', sync, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    if (!isBingEnabled()) return reply.status(409).send({ code: 'DISABLED', message: 'Bing sync is turned off (BING_WEBMASTER_ENABLED=false).' });
    if (!project.bingSiteUrl) return reply.status(409).send({ code: 'NOT_BOUND', message: 'Bind a Bing site to this project in Admin → Integrations first.' });
    const status = await getBingConnectionStatus();
    if (!status.connected) return reply.status(409).send({ code: 'NOT_CONNECTED', message: 'The agency Bing Webmaster account is not connected.' });
    const lastRun = await prisma.analyticsSyncRun.findFirst({ where: { kind: 'bing_sync', projectId: project.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const last = Math.max(project.bingLastSyncedAt ? new Date(project.bingLastSyncedAt).getTime() : 0, lastRun ? new Date(lastRun.createdAt).getTime() : 0);
    const since = last ? Date.now() - last : Infinity;
    if (since < BING_SYNC_COOLDOWN_MS) return cooldown(reply, since, BING_SYNC_COOLDOWN_MS);
    const { run, existing } = await startBackgroundRun(
      { kind: 'bing_sync', projectId: project.id, requestedById: request.user.id, log: request.log },
      () => runBingSync({ projectIds: [project.id], full: true, log: request.log, purge: false })
    );
    return reply.status(202).send({ run: runView(run), existing });
  });

  // Poll a Bing run. Project runs: same access as the project.
  app.get('/bing/runs/:runId', read, async (request, reply) => {
    if (!BING_ROLES.includes(request.user?.role)) return reply.status(403).send({ message: 'Access denied' });
    const run = await getRun(request.params.runId);
    if (!run || run.kind !== 'bing_sync') return reply.status(404).send({ message: 'Run not found' });
    if (run.projectId) {
      const project = await prisma.project.findUnique({ where: { id: run.projectId }, select: { id: true, clientId: true, leadPmId: true } });
      if (!project || !(await ensureProjectAccess(project, request.user))) return reply.status(404).send({ message: 'Run not found' });
    } else if (request.user.role !== 'OWNER') {
      return reply.status(404).send({ message: 'Run not found' });
    }
    reply.header('cache-control', 'no-store');
    return reply.send(runView(run));
  });

  // Bing Places checklist (Local SEO tab).
  app.get('/projects/:id/bing-places', read, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    reply.header('cache-control', 'no-store');
    return reply.send(await bingPlacesView(project));
  });

  app.put('/projects/:id/bing-places', write, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    const body = request.body || {};
    const data = {};
    if (body.url !== undefined) {
      const url = cleanListingUrl(body.url);
      if (url === undefined) return reply.status(400).send({ code: 'BAD_URL', message: 'Enter the full Bing Places listing link (https://…).' });
      data.bingPlacesUrl = url;
    }
    if (body.claimed !== undefined) {
      if (typeof body.claimed !== 'boolean') return reply.status(400).send({ message: 'claimed must be true or false' });
      data.bingPlacesClaimed = body.claimed;
    }
    if (body.checked === true) data.bingPlacesCheckedAt = new Date();
    if (!Object.keys(data).length) return reply.status(400).send({ message: 'Nothing to change' });
    const updated = await prisma.project.update({ where: { id: project.id }, data, select: BING_STAFF_PROJECT_SELECT });
    return reply.send(await bingPlacesView(updated));
  });
}
