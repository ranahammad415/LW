/**
 * Local rank tracking: Google Maps positions of the client's business (docs/ledger/features/local-seo.md).
 *
 * Source: DataForSEO `POST /v3/serp/google/maps/live/advanced` (one task per call). Chosen over local_finder because
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
import { dfsPostTask } from './dataforseo/client.js';
import { DFS_MAPS_PATH, locationCode as dfsLocationCode, languageCode as dfsLanguageCode } from './omniSearch/businessDataProvider.js';
import { dfsIdentifierForProject, hasGbpIdentity } from './analytics/gmbIdentifier.js';
import { projectSiteDomain } from './analytics/gbpIdentity.js';
import { sameSite } from './analytics/domainMatch.js';
import { TRACKED_KEYWORD_STATUSES } from './analytics/keywordStatus.js';

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
/** Estimated USD per Maps call, used only for the UI estimate until real costUsd rows exist (unverified price). */
export function estCostPerCall(env = process.env) {
  const n = Number(env.LOCAL_RANK_EST_COST_USD);
  return Number.isFinite(n) && n > 0 ? n : 0.002;
}

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

/**
 * One Maps check (one paid call). Never throws for DataForSEO task errors: → { status: 'ok'|'not_found'|'error', … }.
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
    const m = matchBusiness(items, matchContext(project));
    return {
      status: m ? 'ok' : 'not_found',
      rank: m?.rank ?? null,
      rankAbsolute: m?.rankAbsolute ?? null,
      matchedBy: m?.matchedBy ?? null,
      inPack: !!m && m.rank != null && m.rank <= 3,
      competitors: competitorsFrom(items, m?.item),
      costUsd: parsed.costUsd,
      depth,
      locationMode: loc.mode,
    };
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
    if (prev && prev.status !== 'error') return { kept: true };
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
  client: { select: { websiteUrl: true } },
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
 * Check every due local keyword of one project, within `budget` calls. Skips keywords already checked today unless
 * force. → { checked, ok, notFound, errors, costUsd, stopped }
 */
export async function runLocalRankForProject(project, { now = new Date(), budget = localRankMaxPerRun(), force = false, post, maxKeywords = 200 } = {}) {
  const out = { projectId: project.id, checked: 0, ok: 0, notFound: 0, errors: 0, costUsd: 0, stopped: null };
  const blocker = localRankBlocker(project);
  if (blocker) return { ...out, skipped: blocker };
  const keywords = await prisma.keywordTrack.findMany({
    where: localKeywordWhere(project.id),
    select: { id: true, keyword: true },
    orderBy: { keyword: 'asc' },
    take: maxKeywords,
  });
  if (!keywords.length) return { ...out, skipped: 'NO_KEYWORDS' };
  let done = new Set();
  if (!force) {
    const rows = await prisma.localRankDaily.findMany({
      where: { projectId: project.id, date: utcDay(now), status: { in: ['ok', 'not_found'] } },
      select: { keywordId: true },
    });
    done = new Set(rows.map((r) => r.keywordId));
  }
  for (const k of keywords) {
    if (done.has(k.id)) continue;
    if (out.checked >= budget) {
      out.stopped = 'CAP';
      break;
    }
    const r = await checkMapsRank(project, k.keyword, { post });
    out.checked++;
    if (typeof r.costUsd === 'number') out.costUsd += r.costUsd;
    await storeLocalRank(project, k.id, r, { now });
    if (r.status === 'ok') out.ok++;
    else if (r.status === 'not_found') out.notFound++;
    else out.errors++;
    if (r.accountLevel) {
      out.stopped = r.errorCode;
      break;
    }
  }
  out.costUsd = Number(out.costUsd.toFixed(5));
  return out;
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
  const summary = { projects: projects.length, checked: 0, ok: 0, notFound: 0, errors: 0, costUsd: 0, stopped: null, skipped: 0 };
  for (const p of projects) {
    if (budget <= 0) {
      summary.stopped = 'CAP';
      break;
    }
    const r = await runLocalRankForProject(p, { now, budget, post });
    if (r.skipped) summary.skipped++;
    summary.checked += r.checked;
    summary.ok += r.ok;
    summary.notFound += r.notFound;
    summary.errors += r.errors;
    summary.costUsd += r.costUsd;
    budget -= r.checked;
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

/** One grid run for one keyword (size² paid calls). Stores a LocalRankGrid row. */
export async function runGridForKeyword(project, keyword, { now = new Date(), post, maxPoints = Infinity } = {}) {
  if (typeof project.gmbLat !== 'number' || typeof project.gmbLng !== 'number') return { skipped: 'NO_COORDINATES' };
  const size = clampGridSize(project.localGridSize);
  const spacingKm = clampSpacingKm(project.localGridSpacingKm);
  const pts = gridPoints({ lat: project.gmbLat, lng: project.gmbLng }, size, spacingKm);
  if (pts.length > maxPoints) return { skipped: 'CAP' };
  const points = [];
  let costUsd = 0;
  let errors = 0;
  let stopped = null;
  for (const pt of pts) {
    const r = await checkMapsRank(project, keyword.keyword, { point: pt, post });
    if (typeof r.costUsd === 'number') costUsd += r.costUsd;
    if (r.status === 'error') errors++;
    points.push({ lat: pt.lat, lng: pt.lng, row: pt.row, col: pt.col, rank: r.status === 'ok' ? r.rank : null, error: r.status === 'error' || undefined });
    if (r.accountLevel) {
      stopped = r.errorCode;
      break;
    }
  }
  const found = points.filter((p) => p.rank != null);
  const measured = points.filter((p) => !p.error);
  const data = {
    projectId: project.id,
    keywordId: keyword.id,
    runAt: now,
    gridSize: size,
    spacingKm,
    centerLat: project.gmbLat,
    centerLng: project.gmbLng,
    points,
    avgRank: found.length ? Number((found.reduce((s, p) => s + p.rank, 0) / found.length).toFixed(2)) : null,
    coverage: measured.length ? Number((found.length / measured.length).toFixed(3)) : null,
    costUsd: Number(costUsd.toFixed(5)),
    status: stopped || errors === points.length ? 'error' : errors > 0 || points.length < pts.length ? 'partial' : 'ok',
    errorCode: stopped || null,
  };
  await prisma.localRankGrid.create({ data });
  return { calls: points.length, costUsd: data.costUsd, status: data.status, stopped };
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
    const latest = [...hist].reverse().find((h) => h.status !== 'error') || null;
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
      history: hist.filter((h) => h.status !== 'error').map((h) => ({ date: isoDay(h.date), rank: h.rank })),
    };
  });
  const gridKeywords = Math.min(localCount, localGridMaxKeywords());
  return {
    flags: { localRankEnabled: isLocalRankEnabled(), localGridEnabled: isLocalGridEnabled() },
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
