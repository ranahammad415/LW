/**
 * Local rank tracking: Google Maps positions of the client's business (docs/ledger/features/local-seo.md).
 *
 * Source (contract-180 owner decision): DataForSEO **standard queue** `POST /v3/serp/google/maps/task_post` (normal
 * priority 1) + `GET /v3/serp/google/maps/task_get/advanced/{id}` (not billed). Every check — the daily ranks, the
 * geo-grid AND the staff "Refresh now" — is posted as a task; `collectLocalRankTasks` (leader, every 10 min) collects
 * results until done or 24 h old (then `expired`). 40601 / 40602 are pending, never errors. A keyword-day is claimed
 * with a `LocalRankDaily` row in status `pending` BEFORE the task is posted (unique keywordId+date), so a keyword is
 * never paid for twice on one UTC day, whichever instance or trigger posts it. The live endpoint
 * (`checkMapsRank`, /live/advanced) is kept for tests and ad-hoc use only; nothing calls it on a schedule.
 * Maps bills per SERP of up to 100 results (local_finder per 10), so depth 20 is one billed SERP, and every Maps item
 * carries cid + place_id for an exact match. Location: `location_coordinate` "lat,lng,14z" from the stored business
 * coordinates (zoom 14 ≈ a 5–10 km neighbourhood/city view, what a nearby searcher sees), else the project's
 * `localLocationCode` (city), else GMB_DFS_LOCATION_CODE / US 2840; language = Project.localLanguageCode.
 *
 * Matching: CID (primary) → place_id → title + website domain (flagged `weak`). rank = rank_group among Maps listings;
 * inPack = rank ≤ 3 (the Maps top 3 approximates the local 3-pack; the organic-SERP pack is not fetched).
 *
 * Cost controls: LOCAL_RANK_ENABLED (default false), LOCAL_RANK_MAX_PER_RUN checks per run, one check per keyword per
 * UTC day (a done day is skipped), only approved keywords with trackLocal, stop at an account-level error, no retries.
 * The DataForSEO `cost` of every call is stored (costUsd). Geo-grid: LOCAL_GRID_ENABLED (default false) +
 * Project.localGridEnabled, weekly, N×N with N ≤ 7 (default 5), LOCAL_GRID_MAX_POINTS_PER_RUN.
 */
import { prisma } from './prisma.js';
import { dfsPostTask, dfsGetTask, hasDataForSeoCreds } from './dataforseo/client.js';
import { DFS_MAPS_PATH, locationCode as dfsLocationCode, languageCode as dfsLanguageCode } from './omniSearch/businessDataProvider.js';
import { dfsIdentifierForProject, hasGbpIdentity } from './analytics/gmbIdentifier.js';
import { projectSiteDomain } from './analytics/gbpIdentity.js';
import { sameSite } from './analytics/domainMatch.js';
import { TRACKED_KEYWORD_STATUSES } from './analytics/keywordStatus.js';
import { getBingTask, storeCollectedBing, bingRankResultFromItems } from './bing/bingRank.js';

export const MAPS_ZOOM = 14;
export const GRID_MAX_SIZE = 7;
export const GRID_MIN_SIZE = 3;
export const HISTORY_DAYS = 90;
const MS_DAY = 86_400_000;

// ── flags and caps ──
const bool = (v, def) => String(v ?? def).toLowerCase() === 'true';
function intEnv(env, name, def, min, max) {
  const n = Number.parseInt(env?.[name] ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}
export const isLocalRankEnabled = (env = process.env) => bool(env.LOCAL_RANK_ENABLED, 'false');
export const isLocalGridEnabled = (env = process.env) => bool(env.LOCAL_GRID_ENABLED, 'false');
export const localRankMaxPerRun = (env = process.env) => intEnv(env, 'LOCAL_RANK_MAX_PER_RUN', 100, 1, 5000);
export const localRankDepth = (env = process.env) => intEnv(env, 'LOCAL_RANK_DEPTH', 20, 10, 100);
export const localGridMaxPointsPerRun = (env = process.env) => intEnv(env, 'LOCAL_GRID_MAX_POINTS_PER_RUN', 250, 9, 5000);
export const localGridMaxKeywords = (env = process.env) => intEnv(env, 'LOCAL_GRID_MAX_KEYWORDS', 3, 1, 20);
/**
 * Estimated USD per Maps check, used only for the UI estimate until real costUsd rows exist. Standard queue, normal
 * priority: 0.0006 per SERP (DataForSEO public SERP API pricing: standard $0.0006, high priority $0.0012, live $0.002;
 * an estimate, not verified against this account's invoice).
 */
export const STANDARD_QUEUE_EST_COST_USD = 0.0006;
export function estCostPerCall(env = process.env) {
  const n = Number(env.LOCAL_RANK_EST_COST_USD);
  return Number.isFinite(n) && n > 0 ? n : STANDARD_QUEUE_EST_COST_USD;
}

// ── standard queue ──
export const DFS_MAPS_TASK_POST_PATH = '/v3/serp/google/maps/task_post';
export const DFS_MAPS_TASK_GET_PATH = '/v3/serp/google/maps/task_get/advanced';
/** A task not collected within this time is given up (`expired`); DataForSEO keeps results ~30 days, we do not wait. */
export const TASK_EXPIRY_MS = 24 * 60 * 60_000;
export const localRankCollectMax = (env = process.env) => intEnv(env, 'LOCAL_RANK_COLLECT_MAX_PER_TICK', 200, 1, 2000);

export function clampGridSize(n) {
  let s = Math.round(Number(n) || 5);
  s = Math.max(GRID_MIN_SIZE, Math.min(GRID_MAX_SIZE, s));
  return s % 2 === 0 ? s - 1 : s; // odd, so the business sits on the centre point
}
export function clampSpacingKm(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0.2, Math.min(10, Math.round(v * 10) / 10)) : 1.5;
}

export function utcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ── location ──
/** Maps request location for a project (or an explicit grid point). Pure. */
export function mapsLocation(project, point = null, env = process.env) {
  const lat = point?.lat ?? project?.gmbLat;
  const lng = point?.lng ?? project?.gmbLng;
  if (typeof lat === 'number' && typeof lng === 'number' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { mode: 'coordinate', params: { location_coordinate: `${lat.toFixed(7)},${lng.toFixed(7)},${MAPS_ZOOM}z` } };
  }
  return { mode: 'location_code', params: { location_code: dfsLocationCode(project, env) } };
}

// ── matching ──
const normTitle = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Match the business in Maps items. Pure. → { item, rank, rankAbsolute, matchedBy } | null */
export function matchBusiness(items, { cid, placeId, name, siteDomain }) {
  const list = (items || []).filter((i) => i && (!i.type || i.type === 'maps_search'));
  const rankOf = (it) => ({ rank: it.rank_group ?? it.rank_absolute ?? null, rankAbsolute: it.rank_absolute ?? null });
  if (cid) {
    const it = list.find((i) => i.cid != null && String(i.cid) === String(cid));
    if (it) return { item: it, ...rankOf(it), matchedBy: 'cid' };
  }
  if (placeId) {
    const it = list.find((i) => i.place_id && i.place_id === placeId);
    if (it) return { item: it, ...rankOf(it), matchedBy: 'place_id' };
  }
  const n = normTitle(name);
  if (n && siteDomain) {
    const it = list.find((i) => {
      const t = normTitle(i.title);
      return t && (t === n || t.includes(n) || n.includes(t)) && sameSite(i.url || i.domain || '', siteDomain);
    });
    if (it) return { item: it, ...rankOf(it), matchedBy: 'weak' };
  }
  return null;
}

/** Top 3 other listings for context (staff: with cid; the client view keeps names only). Pure. */
export function competitorsFrom(items, matchedItem) {
  return (items || [])
    .filter((i) => i && (!i.type || i.type === 'maps_search') && i !== matchedItem)
    .slice(0, 3)
    .map((i) => ({
      title: i.title ? String(i.title).slice(0, 200) : null,
      rating: typeof i.rating?.value === 'number' ? i.rating.value : null,
      votes: typeof i.rating?.votes_count === 'number' ? i.rating.votes_count : null,
      cid: i.cid != null ? String(i.cid) : null,
    }));
}

function matchContext(project) {
  const id = dfsIdentifierForProject(project);
  return { cid: id.cid, placeId: id.placeId || project.gmbPlaceId || null, name: project.gmbLocationName, siteDomain: projectSiteDomain(project) };
}

/** Maps items → { status: ok|not_found, rank, rankAbsolute, matchedBy, inPack, competitors }. Pure. */
export function rankResultFromItems(project, items) {
  const m = matchBusiness(items, matchContext(project));
  return {
    status: m ? 'ok' : 'not_found',
    rank: m?.rank ?? null,
    rankAbsolute: m?.rankAbsolute ?? null,
    matchedBy: m?.matchedBy ?? null,
    inPack: !!m && m.rank != null && m.rank <= 3,
    competitors: competitorsFrom(items, m?.item),
  };
}

/** Task body for one Maps check (live and task_post share it; task_post adds priority 1 = normal). Pure. */
export function mapsTaskBody(project, keyword, { point = null, env = process.env } = {}) {
  const loc = mapsLocation(project, point, env);
  const depth = localRankDepth(env);
  return { loc, depth, body: { keyword: String(keyword).slice(0, 700), language_code: dfsLanguageCode(project), depth, ...loc.params } };
}

/**
 * Post one standard-queue Maps task (one paid task). Never throws for DataForSEO errors:
 * → { status: 'posted', taskId, costUsd, depth, locationMode } | { status: 'error', errorCode, accountLevel, costUsd }.
 */
export async function postMapsTask(project, keyword, { point = null, post, env = process.env } = {}) {
  const { loc, depth, body } = mapsTaskBody(project, keyword, { point, env });
  try {
    const parsed = await dfsPostTask(DFS_MAPS_TASK_POST_PATH, { ...body, priority: 1 }, { post });
    const taskId = parsed.task?.id ? String(parsed.task.id) : null;
    if (!taskId || !/^[\w-]{8,64}$/.test(taskId)) {
      return { status: 'error', errorCode: 'NO_TASK_ID', accountLevel: false, costUsd: parsed.costUsd ?? null, depth, locationMode: loc.mode };
    }
    return { status: 'posted', taskId, costUsd: parsed.costUsd ?? null, depth, locationMode: loc.mode };
  } catch (err) {
    return {
      status: 'error',
      errorCode: String(err?.code || 'FAILED').slice(0, 40),
      accountLevel: !!err?.accountLevel,
      costUsd: err?.costUsd ?? null,
      depth,
      locationMode: loc.mode,
    };
  }
}

/**
 * One task_get (free). → { state: 'pending' } | { state: 'done', items } | { state: 'failed', errorCode, accountLevel }.
 * 40601 Task Handed / 40602 Task In Queue = pending; 40102 no results = done with no items.
 */
export async function getMapsTask(taskId, { get } = {}) {
  if (!/^[\w-]{8,64}$/.test(String(taskId || ''))) return { state: 'failed', errorCode: 'BAD_TASK_ID', accountLevel: false };
  try {
    const parsed = await dfsGetTask(`${DFS_MAPS_TASK_GET_PATH}/${taskId}`, { get });
    if (parsed.state === 'pending') return { state: 'pending' };
    if (parsed.state === 'no_results') return { state: 'done', items: [] };
    if (!parsed.result) return { state: 'pending' };
    return { state: 'done', items: parsed.result.items || [] };
  } catch (err) {
    return { state: 'failed', errorCode: String(err?.code || 'FAILED').slice(0, 40), accountLevel: !!err?.accountLevel };
  }
}

/**
 * Claim a keyword-day before paying for it: an `error` row of the day is taken over (CAS on status), else a new
 * `pending` row is created; the unique (keywordId, date) makes a second claim fail. → true when this caller owns it.
 */
export async function claimDailyRow(projectId, keywordId, date, now = new Date()) {
  const upd = await prisma.localRankDaily.updateMany({
    where: { keywordId, date, status: 'error' },
    data: { status: 'pending', errorCode: null, fetchedAt: now },
  });
  if (upd?.count) return true;
  try {
    await prisma.localRankDaily.create({ data: { projectId, keywordId, date, status: 'pending', fetchedAt: now } });
    return true;
  } catch (err) {
    if (err?.code === 'P2002') return false;
    throw err;
  }
}

/**
 * One Maps check via the LIVE endpoint (one paid call). Not used by any job since contract-180 (standard queue);
 * kept for tests and ad-hoc checks. Never throws for DataForSEO task errors: → { status: 'ok'|'not_found'|'error', … }.
 * Account-level errors come back with accountLevel: true so the caller stops.
 */
export async function checkMapsRank(project, keyword, { point = null, post, env = process.env } = {}) {
  const loc = mapsLocation(project, point, env);
  const depth = localRankDepth(env);
  try {
    const parsed = await dfsPostTask(
      DFS_MAPS_PATH,
      { keyword: String(keyword).slice(0, 700), language_code: dfsLanguageCode(project), depth, ...loc.params },
      { post }
    );
    if (parsed.state === 'pending') return { status: 'error', errorCode: 'DFS_PENDING', costUsd: parsed.costUsd, depth, locationMode: loc.mode };
    const items = parsed.state === 'ok' ? parsed.result?.items || [] : [];
    return { ...rankResultFromItems(project, items), costUsd: parsed.costUsd, depth, locationMode: loc.mode };
  } catch (err) {
    return {
      status: 'error',
      errorCode: String(err?.code || 'FAILED').slice(0, 40),
      accountLevel: !!err?.accountLevel,
      costUsd: err?.costUsd ?? null,
      depth,
      locationMode: loc.mode,
    };
  }
}

/** Upsert the day's row. An error never overwrites an ok / not_found row of the same day. */
export async function storeLocalRank(project, keywordId, r, { now = new Date() } = {}) {
  const date = utcDay(now);
  const where = { keywordId_date: { keywordId, date } };
  const data = {
    rank: r.status === 'ok' ? r.rank : null,
    rankAbsolute: r.status === 'ok' ? r.rankAbsolute : null,
    inPack: !!r.inPack,
    matchedBy: r.matchedBy || null,
    competitors: r.competitors || [],
    locationMode: r.locationMode || null,
    depth: r.depth ?? null,
    costUsd: r.costUsd ?? null,
    status: r.status,
    errorCode: r.status === 'error' ? r.errorCode || 'FAILED' : null,
    fetchedAt: now,
  };
  if (r.status === 'error') {
    const prev = await prisma.localRankDaily.findUnique({ where, select: { status: true } });
    if (prev && (prev.status === 'ok' || prev.status === 'not_found')) return { kept: true };
  }
  await prisma.localRankDaily.upsert({ where, create: { projectId: project.id, keywordId, date, ...data }, update: data });
  return { kept: false };
}

/** Project fields the local rank code reads (checked against schema.prisma by the tests). */
export const LOCAL_PROJECT_SELECT = Object.freeze({
  id: true,
  name: true,
  clientId: true,
  leadPmId: true,
  wpUrl: true,
  dataforseoDomain: true,
  targetMarket: true,
  gmbLocationId: true,
  gmbLocationName: true,
  gmbCid: true,
  gmbPlaceId: true,
  gmbFeatureId: true,
  gmbLat: true,
  gmbLng: true,
  gmbAddress: true,
  gmbPhone: true,
  gmbCategory: true,
  gmbWebsite: true,
  gmbRating: true,
  gmbReviewsCount: true,
  gmbProfileSyncedAt: true,
  gmbIdentitySource: true,
  gmbIdentityVerifiedAt: true,
  gmbSyncError: true,
  localLocationCode: true,
  localLocationName: true,
  localLanguageCode: true,
  localGridEnabled: true,
  localGridSize: true,
  localGridSpacingKm: true,
  client: { select: { websiteUrl: true, agencyName: true } },
});

/** Keywords a local check covers: approved + trackLocal. */
export function localKeywordWhere(projectId) {
  return { projectId, trackLocal: true, status: { in: [...TRACKED_KEYWORD_STATUSES] } };
}

/** Can this project be checked at all? → null | reason */
export function localRankBlocker(project) {
  if (!hasGbpIdentity(project) && !project?.gmbLocationName) return 'NO_IDENTITY';
  const ctx = matchContext(project);
  if (!ctx.cid && !ctx.placeId && !(ctx.name && ctx.siteDomain)) return 'NO_MATCH_KEY';
  return null;
}

/**
 * Post a standard-queue task for every due local keyword of one project, within `budget` tasks. A keyword already
 * checked or pending today is skipped (never paid twice per keyword-day; there is no force any more). Each keyword-day
 * is claimed with a pending LocalRankDaily row before its task is posted. Results arrive through
 * collectLocalRankTasks. → { checked (tasks posted or failed), posted, errors, costUsd, stopped }
 */
export async function runLocalRankForProject(project, { now = new Date(), budget = localRankMaxPerRun(), post, maxKeywords = 200, env = process.env } = {}) {
  const out = { projectId: project.id, checked: 0, posted: 0, errors: 0, costUsd: 0, stopped: null };
  const blocker = localRankBlocker(project);
  if (blocker) return { ...out, skipped: blocker };
  const keywords = await prisma.keywordTrack.findMany({
    where: localKeywordWhere(project.id),
    select: { id: true, keyword: true },
    orderBy: { keyword: 'asc' },
    take: maxKeywords,
  });
  if (!keywords.length) return { ...out, skipped: 'NO_KEYWORDS' };
  const date = utcDay(now);
  const rows = await prisma.localRankDaily.findMany({
    where: { projectId: project.id, date, status: { in: ['ok', 'not_found', 'pending'] } },
    select: { keywordId: true },
  });
  const done = new Set(rows.map((r) => r.keywordId));
  for (const k of keywords) {
    if (done.has(k.id)) continue;
    if (out.checked >= budget) {
      out.stopped = 'CAP';
      break;
    }
    if (!(await claimDailyRow(project.id, k.id, date, now))) continue; // another instance / trigger owns this day
    const r = await postMapsTask(project, k.keyword, { post, env });
    out.checked++;
    if (typeof r.costUsd === 'number') out.costUsd += r.costUsd;
    if (r.status === 'posted') {
      await prisma.localRankTask.create({
        data: { projectId: project.id, keywordId: k.id, kind: 'daily', date, taskId: r.taskId, locationMode: r.locationMode, depth: r.depth, status: 'pending', postedAt: now, costUsd: r.costUsd ?? null },
      });
      await prisma.localRankDaily.updateMany({
        where: { keywordId: k.id, date, status: 'pending' },
        data: { costUsd: r.costUsd ?? null, depth: r.depth, locationMode: r.locationMode },
      });
      out.posted++;
    } else {
      await prisma.localRankDaily.updateMany({
        where: { keywordId: k.id, date, status: 'pending' },
        data: { status: 'error', errorCode: r.errorCode || 'FAILED', costUsd: r.costUsd ?? null },
      });
      out.errors++;
      if (r.accountLevel) {
        out.stopped = r.errorCode;
        break;
      }
    }
  }
  out.costUsd = Number(out.costUsd.toFixed(5));
  return out;
}

/** Store a collected daily result on its pending row (never touches an ok / not_found row). */
async function storeCollectedDaily(task, r, now) {
  await prisma.localRankDaily.updateMany({
    where: { keywordId: task.keywordId, date: task.date, status: 'pending' },
    data: {
      rank: r.status === 'ok' ? r.rank : null,
      rankAbsolute: r.status === 'ok' ? r.rankAbsolute : null,
      inPack: !!r.inPack,
      matchedBy: r.matchedBy || null,
      competitors: r.competitors || [],
      status: r.status,
      errorCode: r.status === 'error' ? r.errorCode || 'FAILED' : null,
      fetchedAt: now,
    },
  });
}

/** Grid row: fill a point, and when no task of the grid is pending any more, compute avgRank / coverage / status. */
async function updateGridPoints(gridId, updates) {
  const grid = await prisma.localRankGrid.findUnique({ where: { id: gridId }, select: { id: true, points: true, status: true, errorCode: true } });
  if (!grid) return;
  const points = Array.isArray(grid.points) ? grid.points.map((p) => ({ ...p })) : [];
  for (const u of updates) {
    const p = points[u.pointIndex];
    if (!p) continue;
    delete p.pending;
    if (u.error) {
      p.rank = null;
      p.error = true;
    } else {
      p.rank = u.rank;
      delete p.error;
    }
  }
  const pending = points.some((p) => p.pending);
  await prisma.localRankGrid.update({ where: { id: gridId }, data: { points, ...(pending ? {} : gridOutcome(points, grid.errorCode)) } });
}

/** avgRank / coverage / status of a finished grid. Pure. */
export function gridOutcome(points, stoppedCode = null) {
  const found = points.filter((p) => p.rank != null);
  const measured = points.filter((p) => !p.error && !p.pending);
  const errors = points.filter((p) => p.error).length;
  return {
    avgRank: found.length ? Number((found.reduce((s, p) => s + p.rank, 0) / found.length).toFixed(2)) : null,
    coverage: measured.length ? Number((found.length / measured.length).toFixed(3)) : null,
    status: stoppedCode || errors === points.length ? 'error' : errors > 0 ? 'partial' : 'ok',
  };
}

/**
 * Collector (leader only, every 10 min; free task_get calls). Oldest pending tasks first, ≤ LOCAL_RANK_COLLECT_MAX_PER_TICK.
 * pending → polls + 1; older than 24 h → expired (daily row error DFS_EXPIRED, grid point error); done → match and
 * store; failed → daily row error / grid point error. An account-level error stops the tick and leaves the task
 * pending for the next one. Runs whatever LOCAL_RANK_ENABLED says (the tasks are already paid for).
 */
export async function collectLocalRankTasks({ now = new Date(), get, env = process.env, log = console } = {}) {
  if (!get && !hasDataForSeoCreds(env)) return { skipped: 'NO_CREDS' };
  const tasks = await prisma.localRankTask.findMany({
    where: { status: 'pending' },
    orderBy: { postedAt: 'asc' },
    take: localRankCollectMax(env),
    select: { id: true, projectId: true, keywordId: true, kind: true, date: true, gridId: true, pointIndex: true, taskId: true, postedAt: true, polls: true },
  });
  const summary = { tasks: tasks.length, done: 0, pending: 0, expired: 0, failed: 0, stopped: null };
  if (!tasks.length) return summary;
  const projects = new Map();
  const gridUpdates = new Map();
  const queueGrid = (t, u) => {
    if (!t.gridId) return;
    if (!gridUpdates.has(t.gridId)) gridUpdates.set(t.gridId, []);
    gridUpdates.get(t.gridId).push({ pointIndex: t.pointIndex, ...u });
  };
  // Kind `bing` (lib/bing/bingRank.js): a DataForSEO Bing organic task whose result goes to BingSerpRankDaily.
  const storeError = async (t, errorCode) => {
    if (t.kind === 'daily') await storeCollectedDaily(t, { status: 'error', errorCode }, now);
    else if (t.kind === 'bing') await storeCollectedBing(t, { status: 'error', errorCode }, now);
    else queueGrid(t, { error: true });
  };
  for (const t of tasks) {
    if (now.getTime() - new Date(t.postedAt).getTime() > TASK_EXPIRY_MS) {
      await prisma.localRankTask.updateMany({ where: { id: t.id, status: 'pending' }, data: { status: 'expired', collectedAt: now, errorCode: 'DFS_EXPIRED' } });
      await storeError(t, 'DFS_EXPIRED');
      summary.expired++;
      continue;
    }
    const r = t.kind === 'bing' ? await getBingTask(t.taskId, { get }) : await getMapsTask(t.taskId, { get });
    if (r.state === 'pending') {
      await prisma.localRankTask.update({ where: { id: t.id }, data: { polls: (t.polls || 0) + 1 } });
      summary.pending++;
      continue;
    }
    if (r.state === 'failed') {
      if (r.accountLevel) {
        summary.stopped = r.errorCode;
        log?.warn?.({ code: r.errorCode }, 'Local rank collector stopped on an account-level DataForSEO error');
        break;
      }
      await prisma.localRankTask.updateMany({ where: { id: t.id, status: 'pending' }, data: { status: 'failed', collectedAt: now, errorCode: r.errorCode } });
      await storeError(t, r.errorCode);
      summary.failed++;
      continue;
    }
    if (!projects.has(t.projectId)) {
      projects.set(t.projectId, await prisma.project.findUnique({ where: { id: t.projectId }, select: LOCAL_PROJECT_SELECT }));
    }
    const project = projects.get(t.projectId);
    await prisma.localRankTask.updateMany({ where: { id: t.id, status: 'pending' }, data: { status: 'done', collectedAt: now } });
    if (t.kind === 'bing') {
      await storeCollectedBing(t, project ? bingRankResultFromItems(project, r.items) : { status: 'not_found' }, now);
      summary.done++;
      continue;
    }
    const res = project ? rankResultFromItems(project, r.items) : { status: 'not_found', rank: null };
    if (t.kind === 'daily') await storeCollectedDaily(t, res, now);
    else queueGrid(t, { rank: res.status === 'ok' ? res.rank : null });
    summary.done++;
  }
  for (const [gridId, updates] of gridUpdates) await updateGridPoints(gridId, updates);
  return summary;
}

/** Daily job (leader only, LOCAL_RANK_ENABLED). Projects with at least one local keyword, least recently checked first. */
export async function runLocalRankJob({ now = new Date(), log = console, env = process.env, post } = {}) {
  if (!isLocalRankEnabled(env)) return { skipped: 'DISABLED' };
  const projects = await prisma.project.findMany({
    where: {
      status: { in: ['ACTIVE', 'SETUP'] },
      client: { isActive: true },
      trackedKeywords: { some: { trackLocal: true } },
    },
    select: LOCAL_PROJECT_SELECT,
  });
  let budget = localRankMaxPerRun(env);
  const summary = { projects: projects.length, checked: 0, posted: 0, errors: 0, costUsd: 0, stopped: null, skipped: 0 };
  for (const p of projects) {
    if (budget <= 0) {
      summary.stopped = 'CAP';
      break;
    }
    const r = await runLocalRankForProject(p, { now, budget, post, env });
    if (r.skipped) summary.skipped++;
    summary.checked += r.checked;
    summary.posted += r.posted;
    summary.errors += r.errors;
    summary.costUsd += r.costUsd;
    budget -= r.checked;
    if (r.stopped === 'CAP') summary.stopped = 'CAP';
    if (r.stopped && r.stopped !== 'CAP') {
      summary.stopped = r.stopped;
      log?.warn?.({ projectId: p.id, code: r.stopped }, 'Local rank run stopped on an account-level DataForSEO error');
      break;
    }
  }
  summary.costUsd = Number(summary.costUsd.toFixed(5));
  return summary;
}

// ── geo-grid ──
/** N×N points around a centre, `spacingKm` apart (row-major, north to south, west to east). Pure. */
export function gridPoints(center, size, spacingKm) {
  const n = clampGridSize(size);
  const s = clampSpacingKm(spacingKm);
  const half = (n - 1) / 2;
  const pts = [];
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      const dyKm = (half - row) * s;
      const dxKm = (col - half) * s;
      const lat = center.lat + dyKm / 110.574;
      const lng = center.lng + dxKm / (111.32 * Math.cos((center.lat * Math.PI) / 180));
      pts.push({ lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)), row, col });
    }
  }
  return pts;
}

/** Calls and estimated USD for a grid configuration. Pure. */
export function gridCostEstimate({ size, keywords, perCallUsd = estCostPerCall() }) {
  const n = clampGridSize(size);
  const calls = n * n * Math.max(0, keywords || 0);
  return { calls, perRunUsd: Number((calls * perCallUsd).toFixed(4)), perMonthUsd: Number((calls * perCallUsd * 4.35).toFixed(4)), perCallUsd };
}

/**
 * One grid run for one keyword: size² standard-queue tasks. The LocalRankGrid row is created first in status `pending`
 * (every point `pending: true`); collectLocalRankTasks fills the points and sets avgRank / coverage / status when the
 * last task is in. A point whose task could not be posted is an error point straight away; an account-level error
 * stops posting (the remaining points become error points).
 */
export async function runGridForKeyword(project, keyword, { now = new Date(), post, maxPoints = Infinity, env = process.env } = {}) {
  if (typeof project.gmbLat !== 'number' || typeof project.gmbLng !== 'number') return { skipped: 'NO_COORDINATES' };
  const size = clampGridSize(project.localGridSize);
  const spacingKm = clampSpacingKm(project.localGridSpacingKm);
  const pts = gridPoints({ lat: project.gmbLat, lng: project.gmbLng }, size, spacingKm);
  if (pts.length > maxPoints) return { skipped: 'CAP' };
  const points = pts.map((pt) => ({ lat: pt.lat, lng: pt.lng, row: pt.row, col: pt.col, rank: null, pending: true }));
  const grid = await prisma.localRankGrid.create({
    data: {
      projectId: project.id,
      keywordId: keyword.id,
      runAt: now,
      gridSize: size,
      spacingKm,
      centerLat: project.gmbLat,
      centerLng: project.gmbLng,
      points,
      avgRank: null,
      coverage: null,
      costUsd: 0,
      status: 'pending',
      errorCode: null,
    },
  });
  let costUsd = 0;
  let posted = 0;
  let stopped = null;
  const date = utcDay(now);
  for (let i = 0; i < pts.length; i += 1) {
    if (stopped) {
      delete points[i].pending;
      points[i].error = true;
      continue;
    }
    const r = await postMapsTask(project, keyword.keyword, { point: pts[i], post, env });
    if (typeof r.costUsd === 'number') costUsd += r.costUsd;
    if (r.status === 'posted') {
      await prisma.localRankTask.create({
        data: { projectId: project.id, keywordId: keyword.id, kind: 'grid', date, gridId: grid.id, pointIndex: i, taskId: r.taskId, locationMode: r.locationMode, depth: r.depth, status: 'pending', postedAt: now, costUsd: r.costUsd ?? null },
      });
      posted++;
    } else {
      delete points[i].pending;
      points[i].error = true;
      if (r.accountLevel) stopped = r.errorCode;
    }
  }
  // The collector may already have filled points while we were still posting: keep what it stored.
  const stored = await prisma.localRankGrid.findUnique({ where: { id: grid.id }, select: { points: true } });
  if (Array.isArray(stored?.points)) {
    stored.points.forEach((p, i) => {
      if (p && !p.pending && points[i]?.pending) points[i] = p;
    });
  }
  const anyPending = points.some((p) => p.pending);
  const data = { points, costUsd: Number(costUsd.toFixed(5)), errorCode: stopped || null, ...(anyPending ? {} : gridOutcome(points, stopped)) };
  await prisma.localRankGrid.update({ where: { id: grid.id }, data });
  return { calls: points.length, posted, costUsd: data.costUsd, status: data.status || 'pending', stopped };
}

/** Weekly grid job (leader only, LOCAL_GRID_ENABLED + Project.localGridEnabled). */
export async function runLocalGridJob({ now = new Date(), log = console, env = process.env, post } = {}) {
  if (!isLocalGridEnabled(env)) return { skipped: 'DISABLED' };
  const projects = await prisma.project.findMany({
    where: { localGridEnabled: true, gmbLat: { not: null }, gmbLng: { not: null }, status: { in: ['ACTIVE', 'SETUP'] }, client: { isActive: true } },
    select: LOCAL_PROJECT_SELECT,
  });
  let budget = localGridMaxPointsPerRun(env);
  const summary = { projects: projects.length, grids: 0, calls: 0, costUsd: 0, stopped: null };
  outer: for (const p of projects) {
    const keywords = await prisma.keywordTrack.findMany({
      where: localKeywordWhere(p.id),
      select: { id: true, keyword: true },
      orderBy: { keyword: 'asc' },
      take: localGridMaxKeywords(env),
    });
    for (const k of keywords) {
      const r = await runGridForKeyword(p, k, { now, post, maxPoints: budget });
      if (r.skipped === 'CAP') {
        summary.stopped = 'CAP';
        break outer;
      }
      if (r.skipped) continue;
      summary.grids++;
      summary.calls += r.calls;
      summary.costUsd += r.costUsd;
      budget -= r.calls;
      if (r.stopped) {
        summary.stopped = r.stopped;
        log?.warn?.({ projectId: p.id, code: r.stopped }, 'Local grid run stopped on an account-level DataForSEO error');
        break outer;
      }
    }
  }
  summary.costUsd = Number(summary.costUsd.toFixed(5));
  return summary;
}

// ── views ──
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/** Health v2 hook (not a factor yet): local Maps visibility over [from, to] (YYYY-MM-DD or Date). */
export async function localRankSummary(projectId, from, to) {
  const rows = await prisma.localRankDaily.findMany({
    where: { projectId, date: { gte: utcDay(new Date(from)), lte: utcDay(new Date(to)) }, status: { in: ['ok', 'not_found'] } },
    select: { keywordId: true, date: true, rank: true, inPack: true },
    orderBy: { date: 'asc' },
  });
  if (!rows.length) return { keywords: 0, checks: 0, found: 0, avgRank: null, inPackShare: null, days: 0 };
  const found = rows.filter((r) => r.rank != null);
  return {
    keywords: new Set(rows.map((r) => r.keywordId)).size,
    checks: rows.length,
    found: found.length,
    avgRank: found.length ? Number((found.reduce((s, r) => s + r.rank, 0) / found.length).toFixed(2)) : null,
    inPackShare: Number((rows.filter((r) => r.inPack).length / rows.length).toFixed(3)),
    days: new Set(rows.map((r) => isoDay(r.date))).size,
  };
}

/** Average observed DataForSEO cost per Maps call (last 30 days), else the configured estimate. */
async function observedCostPerCall(projectId) {
  const agg = await prisma.localRankDaily
    .aggregate({ where: { costUsd: { not: null }, fetchedAt: { gte: new Date(Date.now() - 30 * MS_DAY) } }, _avg: { costUsd: true } })
    .catch(() => null);
  const avg = agg?._avg?.costUsd != null ? Number(agg._avg.costUsd) : null;
  return avg && avg > 0 ? { perCallUsd: avg, observed: true } : { perCallUsd: estCostPerCall(), observed: false };
}

/** Staff Local SEO view. */
export async function staffLocalRankView(project, { now = new Date() } = {}) {
  const from = utcDay(new Date(now.getTime() - HISTORY_DAYS * MS_DAY));
  const [keywords, rows, grids, cost] = await Promise.all([
    prisma.keywordTrack.findMany({
      where: { projectId: project.id },
      select: { id: true, keyword: true, status: true, trackLocal: true, currentRank: true, rankStatus: true, rankCheckedAt: true },
      orderBy: { keyword: 'asc' },
      take: 300,
    }),
    prisma.localRankDaily.findMany({
      where: { projectId: project.id, date: { gte: from } },
      select: { keywordId: true, date: true, rank: true, inPack: true, matchedBy: true, competitors: true, status: true, errorCode: true, costUsd: true, fetchedAt: true },
      orderBy: { date: 'asc' },
    }),
    prisma.localRankGrid.findMany({
      where: { projectId: project.id },
      orderBy: { runAt: 'desc' },
      take: 20,
    }),
    observedCostPerCall(project.id),
  ]);
  const byKw = new Map();
  for (const r of rows) {
    if (!byKw.has(r.keywordId)) byKw.set(r.keywordId, []);
    byKw.get(r.keywordId).push(r);
  }
  const tracked = keywords.filter((k) => TRACKED_KEYWORD_STATUSES.includes(k.status));
  const localCount = tracked.filter((k) => k.trackLocal).length;
  const list = keywords.map((k) => {
    const hist = byKw.get(k.id) || [];
    const latest = [...hist].reverse().find((h) => h.status === 'ok' || h.status === 'not_found') || null;
    const lastAny = hist[hist.length - 1] || null;
    return {
      id: k.id,
      keyword: k.keyword,
      status: k.status,
      approved: TRACKED_KEYWORD_STATUSES.includes(k.status),
      trackLocal: k.trackLocal,
      organicRank: k.currentRank,
      organicStatus: k.rankStatus,
      local: latest
        ? {
            date: isoDay(latest.date),
            rank: latest.rank,
            inPack: latest.inPack,
            matchedBy: latest.matchedBy,
            competitors: Array.isArray(latest.competitors) ? latest.competitors : [],
          }
        : null,
      lastError: lastAny?.status === 'error' ? lastAny.errorCode : null,
      pending: lastAny?.status === 'pending',
      history: hist.filter((h) => h.status === 'ok' || h.status === 'not_found').map((h) => ({ date: isoDay(h.date), rank: h.rank })),
    };
  });
  const gridKeywords = Math.min(localCount, localGridMaxKeywords());
  return {
    flags: { localRankEnabled: isLocalRankEnabled(), localGridEnabled: isLocalGridEnabled() },
    mode: 'standard_queue',
    blocker: localRankBlocker(project),
    location: mapsLocation(project).mode,
    keywords: list,
    grids: grids.map((g) => ({
      id: g.id,
      keywordId: g.keywordId,
      keyword: keywords.find((k) => k.id === g.keywordId)?.keyword || null,
      runAt: g.runAt,
      gridSize: g.gridSize,
      spacingKm: g.spacingKm,
      points: Array.isArray(g.points) ? g.points : [],
      avgRank: g.avgRank,
      coverage: g.coverage,
      costUsd: g.costUsd != null ? Number(g.costUsd) : null,
      status: g.status,
    })),
    grid: {
      enabled: !!project.localGridEnabled,
      size: clampGridSize(project.localGridSize),
      spacingKm: clampSpacingKm(project.localGridSpacingKm),
      maxSize: GRID_MAX_SIZE,
      keywords: gridKeywords,
    },
    cost: {
      perCallUsd: Number(cost.perCallUsd.toFixed(5)),
      observed: cost.observed,
      dailyChecks: localCount,
      monthlyRankUsd: Number((localCount * 30 * cost.perCallUsd).toFixed(4)),
      grid: gridCostEstimate({ size: project.localGridSize, keywords: gridKeywords, perCallUsd: cost.perCallUsd }),
      spent30dUsd: Number(rows.filter((r) => new Date(r.fetchedAt).getTime() >= now.getTime() - 30 * MS_DAY).reduce((s, r) => s + (r.costUsd != null ? Number(r.costUsd) : 0), 0).toFixed(4)),
    },
  };
}

/**
 * Client "Google Maps ranking" tile: allow-list only. Keyword, current position (or not in the top N), change versus
 * ~30 days ago, a short trend, competitor NAMES (no ids). No vendor, cost, ids, match method or error codes.
 */
export async function clientMapsRankingView(project, { now = new Date() } = {}) {
  const from = utcDay(new Date(now.getTime() - HISTORY_DAYS * MS_DAY));
  const [keywords, rows] = await Promise.all([
    prisma.keywordTrack.findMany({
      where: localKeywordWhere(project.id),
      select: { id: true, keyword: true },
      orderBy: { keyword: 'asc' },
      take: 20,
    }),
    prisma.localRankDaily.findMany({
      where: { projectId: project.id, date: { gte: from }, status: { in: ['ok', 'not_found'] } },
      select: { keywordId: true, date: true, rank: true, inPack: true, depth: true, competitors: true },
      orderBy: { date: 'asc' },
    }),
  ]);
  const items = [];
  for (const k of keywords) {
    const hist = rows.filter((r) => r.keywordId === k.id);
    if (!hist.length) continue;
    const latest = hist[hist.length - 1];
    const monthAgo = hist.filter((h) => new Date(h.date).getTime() <= now.getTime() - 28 * MS_DAY).pop() || null;
    const change = latest.rank != null && monthAgo?.rank != null ? monthAgo.rank - latest.rank : null;
    const depth = latest.depth || localRankDepth();
    items.push({
      keyword: k.keyword,
      position: latest.rank,
      inTop3: !!latest.inPack,
      label: latest.rank != null ? `#${latest.rank} on Google Maps` : `Not in the top ${depth}`,
      change,
      trend: hist.map((h) => ({ date: isoDay(h.date), position: h.rank })),
      nearbyCompetitors: (Array.isArray(latest.competitors) ? latest.competitors : []).map((c) => c?.title).filter(Boolean).slice(0, 3),
      updatedAt: isoDay(latest.date),
    });
  }
  return { keywords: items };
}

// ── defaults ──
const LOCAL_INTENT_RE = /\b(near me|nearby|near by|closest|in my area|local)\b/i;

/** Heuristic local intent: "near me" style words, or the project's city / market name in the keyword. Pure. */
export function isLocalIntentKeyword(keyword, project = {}) {
  const k = String(keyword || '').toLowerCase();
  if (!k) return false;
  if (LOCAL_INTENT_RE.test(k)) return true;
  const places = [project.targetMarket, String(project.localLocationName || '').split(',')[0]]
    .map((s) => String(s || '').trim().toLowerCase())
    .filter((s) => s.length >= 3);
  return places.some((p) => k.includes(p));
}

/**
 * Default trackLocal: when a project gets a GBP identity and none of its keywords is tracked locally yet, turn it on
 * for approved local-intent keywords. Never overrides a choice someone already made (any trackLocal = true row).
 */
export async function applyDefaultTrackLocal(project) {
  if (!hasGbpIdentity(project)) return 0;
  const already = await prisma.keywordTrack.count({ where: { projectId: project.id, trackLocal: true } });
  if (already > 0) return 0;
  const keywords = await prisma.keywordTrack.findMany({
    where: { projectId: project.id, status: { in: [...TRACKED_KEYWORD_STATUSES] } },
    select: { id: true, keyword: true },
    take: 300,
  });
  const ids = keywords.filter((k) => isLocalIntentKeyword(k.keyword, project)).map((k) => k.id);
  if (!ids.length) return 0;
  const r = await prisma.keywordTrack.updateMany({ where: { id: { in: ids } }, data: { trackLocal: true } });
  return r?.count ?? ids.length;
}
