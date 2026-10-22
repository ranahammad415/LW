/**
 * Local SEO, staff side (docs/ledger/features/local-seo.md). Prefix /api/pm.
 *
 * Who: OWNER (every project) and PM (their projects: ensureProjectAccess). TEAM_MEMBER / CONTRACTOR / CLIENT: 403.
 * Every write is for people only (agent accounts and API tokens: 403 HUMAN_ONLY before any outside call), has a route
 * rate limit, and paid calls have a per-project cooldown read from the database (cluster-safe). The geo-grid refresh
 * and grid settings are OWNER-only (N×N paid calls). Background refreshes answer 202 with a run id
 * (GET /local-seo/runs/:runId).
 */
import { prisma } from '../../lib/prisma.js';
import { ensureProjectAccess } from '../../lib/ensureProjectAccess.js';
import { rejectAgentRefresh } from './siteMetrics.js';
import { hasDataForSeoCreds } from '../../lib/dataforseo/client.js';
import {
  fetchGmbInfo,
  searchBusinessCandidates,
  locationCode as dfsLocationCode,
  languageCode as dfsLanguageCode,
} from '../../lib/omniSearch/businessDataProvider.js';
import { normalizeGmbIdentifier, resolveMapsShortLink } from '../../lib/analytics/gmbIdentifier.js';
import { identityDataFromProfile, identityView, projectSiteDomain, candidateMatchesSite } from '../../lib/analytics/gbpIdentity.js';
import { searchLocations, findLocation, isCountryCode } from '../../lib/analytics/dfsLocations.js';
import { dfsProfileStep } from '../../lib/analytics/gmbSync.js';
import { startBackgroundRun, getRun, runView } from '../../lib/analytics/syncRuns.js';
import {
  LOCAL_PROJECT_SELECT,
  staffLocalRankView,
  runLocalRankForProject,
  runGridForKeyword,
  applyDefaultTrackLocal,
  isLocalRankEnabled,
  isLocalGridEnabled,
  localRankBlocker,
  clampGridSize,
  clampSpacingKm,
  localKeywordWhere,
} from '../../lib/localRank.js';

export const LOCAL_SEO_ROLES = ['OWNER', 'PM'];
export const LOCAL_RANK_REFRESH_COOLDOWN_MS = 60 * 60_000;
export const GRID_REFRESH_COOLDOWN_MS = 24 * 60 * 60_000;
export const PROFILE_REFRESH_COOLDOWN_MS = 10 * 60_000;
export const MANUAL_REFRESH_MAX_KEYWORDS = 20;

const WRITE_LIMIT = { rateLimit: { max: 10, timeWindow: '10 minutes' } };

async function projectFor(request, reply) {
  if (!LOCAL_SEO_ROLES.includes(request.user?.role)) {
    reply.status(403).send({ message: 'Access denied' });
    return null;
  }
  const project = await prisma.project.findUnique({ where: { id: String(request.params.id) }, select: LOCAL_PROJECT_SELECT });
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

function noCreds(reply) {
  return reply.status(409).send({ code: 'NOT_CONFIGURED', message: 'DataForSEO credentials are not configured.' });
}

/** Staff-facing error text for a DataForSEO failure (no credentials, no raw payload). */
function dfsFailure(reply, request, err, what) {
  request.log.warn({ code: err?.code, accountLevel: !!err?.accountLevel }, `${what} failed`);
  return reply.status(502).send({ code: err?.code || 'DFS_FAILED', message: `${what} failed (${err?.code || 'provider error'}). Try again later.` });
}

async function localSeoView(project) {
  return { identity: identityView(project), siteDomain: projectSiteDomain(project) || null, ...(await staffLocalRankView(project)) };
}

export async function pmLocalSeoRoutes(app) {
  const read = { onRequest: [app.verifyJwt] };
  const write = { onRequest: [app.verifyJwt, rejectAgentRefresh], config: WRITE_LIMIT };

  app.get('/projects/:id/local-seo', read, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    reply.header('cache-control', 'no-store');
    return reply.send(await localSeoView(project));
  });

  // Find business: a name (+ city) → Maps search (≤ 5 candidates); a Maps URL / short link / CID / place_id →
  // my_business_info (1 candidate). Nothing is saved here. Candidates whose website is the project's site are marked.
  app.post('/projects/:id/local-seo/find-business', write, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    if (!hasDataForSeoCreds()) return noCreds(reply);
    const body = request.body || {};
    const input = String(body.input ?? '').trim().slice(0, 2000);
    const name = String(body.name ?? '').trim().slice(0, 200);
    const city = String(body.city ?? '').trim().slice(0, 120);
    if (!input && !name) return reply.status(400).send({ message: 'Enter a business name, a Google Maps link, a CID or a place_id.' });

    let n = input ? normalizeGmbIdentifier(input) : { kind: 'name' };
    if (n.kind === 'short_link') {
      const resolved = await resolveMapsShortLink(n.url);
      if (!resolved.ok) return reply.status(422).send({ code: `SHORT_LINK_${resolved.code}`, message: 'That short link could not be opened. Paste the full Google Maps link instead.' });
      n = normalizeGmbIdentifier(resolved.url);
    }
    const loc = dfsLocationCode(project);
    const lang = dfsLanguageCode(project);
    let candidates = [];
    let costUsd = null;
    try {
      if (n.kind === 'cid' || n.kind === 'place_id') {
        const info = await fetchGmbInfo({ identifier: n.identifier, locationCode: loc, languageCode: lang });
        candidates = info ? [info] : [];
        costUsd = info?.costUsd ?? null;
      } else {
        const query = [name || n.displayName || n.identifier || input, city].filter(Boolean).join(' ').trim();
        const out = await searchBusinessCandidates({ query, locationCode: loc, languageCode: lang, limit: 5 });
        candidates = out.candidates;
        costUsd = out.costUsd;
      }
    } catch (err) {
      return dfsFailure(reply, request, err, 'Business search');
    }
    const site = projectSiteDomain(project);
    const list = candidates.slice(0, 5).map((c) => ({
      title: c.title,
      address: c.address,
      phone: c.phone,
      rating: c.rating,
      reviewsCount: c.reviewsCount,
      website: c.url || (c.domain ? `https://${c.domain}` : null),
      category: c.category,
      cid: c.cid,
      placeId: c.placeId,
      siteMatch: candidateMatchesSite(c, site),
    }));
    const matches = list.filter((c) => c.siteMatch);
    request.log.info({ projectId: project.id, candidates: list.length, costUsd }, 'Local SEO find business');
    return reply.send({ candidates: list, autoMatch: matches.length === 1 ? matches[0].cid || matches[0].placeId : null, siteDomain: site || null, costUsd });
  });

  // Confirm a candidate: one my_business_info call by CID (or place_id), then the identity is saved and marked verified.
  // Never touches gmbLocationId (a native binding keeps working next to the CID).
  app.post('/projects/:id/local-seo/identity', write, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    const body = request.body || {};
    const cid = body.cid != null ? String(body.cid).replace(/^cid:/i, '').trim() : '';
    const placeId = body.placeId != null ? String(body.placeId).replace(/^place_id:/i, '').trim() : '';
    if (cid && !/^\d{5,30}$/.test(cid)) return reply.status(400).send({ message: 'Invalid CID' });
    if (placeId && !/^[\w-]{10,255}$/.test(placeId)) return reply.status(400).send({ message: 'Invalid place_id' });
    if (!cid && !placeId) return reply.status(400).send({ message: 'cid or placeId is required' });
    if (!hasDataForSeoCreds()) return noCreds(reply);
    let info;
    try {
      info = await fetchGmbInfo({
        identifier: cid ? `cid:${cid}` : `place_id:${placeId}`,
        locationCode: dfsLocationCode(project),
        languageCode: dfsLanguageCode(project),
      });
    } catch (err) {
      return dfsFailure(reply, request, err, 'Business lookup');
    }
    if (!info) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Google returned no business for that id.' });
    const now = new Date();
    const data = {
      // Start from a clean identity so nothing of a previously bound business survives a field the response lacks.
      gmbCid: null,
      gmbPlaceId: null,
      gmbFeatureId: null,
      gmbLat: null,
      gmbLng: null,
      gmbAddress: null,
      gmbPhone: null,
      gmbCategory: null,
      gmbWebsite: null,
      gmbRating: null,
      gmbReviewsCount: null,
      ...identityDataFromProfile(info, { source: 'dataforseo', now, verified: true, setName: true, setIdentitySource: true }),
      gmbSyncError: null,
      // A new identity starts a fresh review cycle (full fetch on the next sync; a pending task belongs to the old id).
      gmbReviewsFullAt: null,
      gmbReviewsTaskId: null,
      gmbReviewsTaskAt: null,
      gmbReviewsTaskDepth: null,
    };
    if (!info.cid && cid) data.gmbCid = cid;
    if (!info.placeId && placeId) data.gmbPlaceId = placeId;
    const updated = await prisma.project.update({ where: { id: project.id }, data, select: LOCAL_PROJECT_SELECT });
    const defaulted = await applyDefaultTrackLocal(updated).catch(() => 0);
    request.log.info({ projectId: project.id, cid: updated.gmbCid, defaultedTrackLocal: defaulted, costUsd: info.costUsd ?? null }, 'Local SEO identity verified');
    return reply.send({ ...(await localSeoView(updated)), defaultedTrackLocal: defaulted });
  });

  // Re-read the public profile now (one my_business_info call; once per 10 minutes per project).
  app.post('/projects/:id/local-seo/profile/refresh', write, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    if (!hasDataForSeoCreds()) return noCreds(reply);
    const since = project.gmbProfileSyncedAt ? Date.now() - new Date(project.gmbProfileSyncedAt).getTime() : Infinity;
    if (since < PROFILE_REFRESH_COOLDOWN_MS) return cooldown(reply, since, PROFILE_REFRESH_COOLDOWN_MS);
    const out = await dfsProfileStep(project, { force: true });
    if (out.status === 'skipped') return reply.status(409).send({ code: 'NO_IDENTITY', message: 'Find and confirm the business first.' });
    const fresh = await prisma.project.findUnique({ where: { id: project.id }, select: LOCAL_PROJECT_SELECT });
    return reply.send({ result: { status: out.status }, ...(await localSeoView(fresh)) });
  });

  // Location picker: DataForSEO locations of one country (free endpoint, cached a day).
  app.get('/local-seo/locations', read, async (request, reply) => {
    if (!LOCAL_SEO_ROLES.includes(request.user?.role)) return reply.status(403).send({ message: 'Access denied' });
    const country = String(request.query?.country || '').toLowerCase();
    const q = String(request.query?.q || '').slice(0, 80);
    if (!isCountryCode(country)) return reply.status(400).send({ message: 'country must be a 2-letter code' });
    if (!hasDataForSeoCreds()) return noCreds(reply);
    try {
      return reply.send({ locations: await searchLocations({ country, q, limit: 20 }) });
    } catch (err) {
      return dfsFailure(reply, request, err, 'Location search');
    }
  });

  app.put('/projects/:id/local-seo/location', write, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    const body = request.body || {};
    const languageCode = body.languageCode != null ? String(body.languageCode).trim().toLowerCase() : project.localLanguageCode || 'en';
    if (!/^[a-z]{2}(-[a-z]{2,4})?$/.test(languageCode)) return reply.status(400).send({ message: 'Invalid language code' });
    const data = { localLanguageCode: languageCode };
    if (body.locationCode === null) {
      data.localLocationCode = null;
      data.localLocationName = null;
    } else if (body.locationCode !== undefined) {
      const code = Number(body.locationCode);
      const country = String(body.country || '').toLowerCase();
      if (!Number.isInteger(code) || code <= 0) return reply.status(400).send({ message: 'Invalid location code' });
      if (!isCountryCode(country)) return reply.status(400).send({ message: 'country must be a 2-letter code' });
      if (!hasDataForSeoCreds()) return noCreds(reply);
      let loc;
      try {
        loc = await findLocation(country, code);
      } catch (err) {
        return dfsFailure(reply, request, err, 'Location lookup');
      }
      if (!loc) return reply.status(404).send({ message: 'Unknown location for that country' });
      data.localLocationCode = loc.code;
      data.localLocationName = loc.name;
    }
    const updated = await prisma.project.update({ where: { id: project.id }, data, select: LOCAL_PROJECT_SELECT });
    return reply.send(await localSeoView(updated));
  });

  app.patch('/projects/:id/keywords/:keywordId/track-local', write, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    if (typeof request.body?.trackLocal !== 'boolean') return reply.status(400).send({ message: 'trackLocal must be true or false' });
    const kw = await prisma.keywordTrack.findFirst({ where: { id: String(request.params.keywordId), projectId: project.id }, select: { id: true } });
    if (!kw) return reply.status(404).send({ message: 'Keyword not found' });
    const updated = await prisma.keywordTrack.update({
      where: { id: kw.id },
      data: { trackLocal: request.body.trackLocal },
      select: { id: true, keyword: true, trackLocal: true, status: true },
    });
    return reply.send(updated);
  });

  // Maps ranks now (background, 202). LOCAL_RANK_ENABLED must be on; once an hour per project; ≤ 20 keywords. Since
  // contract-180 this posts standard-queue tasks like the daily job (no live mode): keywords already checked or pending
  // today are skipped (never paid twice per keyword-day); results appear when the collector picks them up.
  app.post('/projects/:id/local-seo/refresh', write, async (request, reply) => {
    const project = await projectFor(request, reply);
    if (!project) return;
    if (!isLocalRankEnabled()) return reply.status(409).send({ code: 'DISABLED', message: 'Maps rank tracking is turned off (LOCAL_RANK_ENABLED=false).' });
    if (!hasDataForSeoCreds()) return noCreds(reply);
    const blocker = localRankBlocker(project);
    if (blocker) return reply.status(409).send({ code: blocker, message: 'Find and confirm the business first.' });
    const count = await prisma.keywordTrack.count({ where: localKeywordWhere(project.id) });
    if (!count) return reply.status(409).send({ code: 'NO_KEYWORDS', message: 'Turn on Maps tracking for at least one approved keyword.' });
    const last = await prisma.localRankDaily.findFirst({ where: { projectId: project.id }, orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } });
    const since = last ? Date.now() - new Date(last.fetchedAt).getTime() : Infinity;
    if (since < LOCAL_RANK_REFRESH_COOLDOWN_MS) return cooldown(reply, since, LOCAL_RANK_REFRESH_COOLDOWN_MS);
    const { run, existing } = await startBackgroundRun(
      { kind: 'local_rank', projectId: project.id, requestedById: request.user.id, log: request.log },
      () => runLocalRankForProject(project, { budget: MANUAL_REFRESH_MAX_KEYWORDS, maxKeywords: MANUAL_REFRESH_MAX_KEYWORDS })
    );
    return reply.status(202).send({ run: runView(run), existing });
  });

  // Grid settings and run: OWNER only (N×N paid calls).
  app.put('/projects/:id/local-seo/grid', write, async (request, reply) => {
    if (request.user?.role !== 'OWNER') return reply.status(403).send({ message: 'Only the agency owner can change the geo-grid' });
    const project = await projectFor(request, reply);
    if (!project) return;
    const body = request.body || {};
    const data = {};
    if (body.enabled !== undefined) data.localGridEnabled = body.enabled === true;
    if (body.size !== undefined) data.localGridSize = clampGridSize(body.size);
    if (body.spacingKm !== undefined) data.localGridSpacingKm = clampSpacingKm(body.spacingKm);
    const updated = await prisma.project.update({ where: { id: project.id }, data, select: LOCAL_PROJECT_SELECT });
    return reply.send(await localSeoView(updated));
  });

  app.post('/projects/:id/local-seo/grid/refresh', write, async (request, reply) => {
    if (request.user?.role !== 'OWNER') return reply.status(403).send({ message: 'Only the agency owner can run the geo-grid' });
    const project = await projectFor(request, reply);
    if (!project) return;
    if (!isLocalGridEnabled()) return reply.status(409).send({ code: 'DISABLED', message: 'The geo-grid is turned off (LOCAL_GRID_ENABLED=false).' });
    if (!hasDataForSeoCreds()) return noCreds(reply);
    if (typeof project.gmbLat !== 'number' || typeof project.gmbLng !== 'number') {
      return reply.status(409).send({ code: 'NO_COORDINATES', message: 'Confirm the business first so its map position is known.' });
    }
    const keyword = await prisma.keywordTrack.findFirst({
      where: { ...localKeywordWhere(project.id), id: String(request.body?.keywordId || '') },
      select: { id: true, keyword: true },
    });
    if (!keyword) return reply.status(404).send({ message: 'Pick an approved keyword with Maps tracking on' });
    const last = await prisma.localRankGrid.findFirst({ where: { keywordId: keyword.id }, orderBy: { runAt: 'desc' }, select: { runAt: true } });
    const since = last ? Date.now() - new Date(last.runAt).getTime() : Infinity;
    if (since < GRID_REFRESH_COOLDOWN_MS) return cooldown(reply, since, GRID_REFRESH_COOLDOWN_MS);
    const { run, existing } = await startBackgroundRun(
      { kind: 'local_grid', projectId: project.id, requestedById: request.user.id, log: request.log },
      () => runGridForKeyword(project, keyword)
    );
    return reply.status(202).send({ run: runView(run), existing });
  });

  // Poll a background run. Project runs: same access as the project; agency-wide runs (no project): OWNER.
  app.get('/local-seo/runs/:runId', read, async (request, reply) => {
    if (!LOCAL_SEO_ROLES.includes(request.user?.role)) return reply.status(403).send({ message: 'Access denied' });
    const run = await getRun(request.params.runId);
    if (!run) return reply.status(404).send({ message: 'Run not found' });
    if (run.projectId) {
      const project = await prisma.project.findUnique({ where: { id: run.projectId }, select: { id: true, clientId: true, leadPmId: true } });
      if (!project || !(await ensureProjectAccess(project, request.user))) return reply.status(404).send({ message: 'Run not found' });
    } else if (request.user.role !== 'OWNER') {
      return reply.status(404).send({ message: 'Run not found' });
    }
    reply.header('cache-control', 'no-store');
    return reply.send(runView(run));
  });
}
