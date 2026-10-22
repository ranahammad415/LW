/**
 * Google Business Profile sync: native Business Profile API when a location is bound and works, else DataForSEO
 * (public profile + reviews) when the project has a CID / place_id / legacy identifier (features/local-seo.md).
 *
 * DataForSEO cost controls:
 * - my_business_info: at most once per GMB_PROFILE_REFRESH_HOURS (default 20 h) per project, or on demand (force).
 * - reviews: daily the newest GMB_REVIEWS_DAILY_DEPTH (default 20, sort_by newest); a full depth GMB_REVIEWS_FULL_DEPTH
 *   (default 100) refresh when the last full one is ≥ 7 days old (soft-removes reviews that disappeared).
 * - A posted reviews task is polled with back-off (~3 min). If it is still queued its id stays on the project and the
 *   next run collects it (task_get is free) instead of paying for a new task_post. Never retried in a loop.
 * - runGmbSync posts every project's task first, then collects them, so the wait is shared.
 */
import { prisma } from '../prisma.js';
import { fetchGmbDailyMetrics, fetchGmbReviewsWithSummary } from './gmbClient.js';
import {
  fetchGmbInfo as fetchGmbInfoDfs,
  postReviewsTask,
  pollReviewsTask,
  locationCode as dfsLocationCode,
  languageCode as dfsLanguageCode,
} from '../omniSearch/businessDataProvider.js';
import { BUSINESS_DATA_PROVIDER, hasRealBusinessDataProvider } from '../omniSearch/omniSearchConfig.js';
import { dfsIdentifierForProject } from './gmbIdentifier.js';
import { identityDataFromProfile } from './gbpIdentity.js';
import { storeReviews } from './gmbReviews.js';

const MS_H = 3600_000;
export const FULL_REFRESH_DAYS = 7;
/** A pending reviews task older than this is abandoned (DataForSEO keeps results ~30 days; we stay well inside). */
const PENDING_TASK_MAX_AGE_MS = 3 * 24 * MS_H;

/** Project fields every GMB sync path reads (checked against schema.prisma by the tests). */
export const GMB_SYNC_PROJECT_SELECT = Object.freeze({
  id: true,
  gmbLocationId: true,
  gmbAccountId: true,
  gmbCid: true,
  gmbPlaceId: true,
  gmbLocationName: true,
  gmbProfileSyncedAt: true,
  gmbReviewsFullAt: true,
  gmbReviewsTaskId: true,
  gmbReviewsTaskAt: true,
  gmbReviewsTaskDepth: true,
  localLocationCode: true,
  localLanguageCode: true,
  targetMarket: true,
  clientId: true,
});

function intEnv(name, def, min, max, env = process.env) {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}
export const reviewsDailyDepth = (env) => intEnv('GMB_REVIEWS_DAILY_DEPTH', 20, 10, 100, env);
export const reviewsFullDepth = (env) => intEnv('GMB_REVIEWS_FULL_DEPTH', 100, 20, 500, env);
export const profileRefreshHours = (env) => intEnv('GMB_PROFILE_REFRESH_HOURS', 20, 1, 24 * 30, env);

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

/** Whether the profile (my_business_info) is due. Pure. */
export function profileDue(project, { now = new Date(), force = false, env } = {}) {
  if (force) return true;
  if (!project.gmbProfileSyncedAt) return true;
  return now.getTime() - new Date(project.gmbProfileSyncedAt).getTime() >= profileRefreshHours(env) * MS_H;
}

/** Depth plan for the next reviews fetch. Pure. → { depth, full } */
export function reviewsPlan(project, { now = new Date(), forceFull = false, env } = {}) {
  const fullDue =
    forceFull || !project.gmbReviewsFullAt || now.getTime() - new Date(project.gmbReviewsFullAt).getTime() >= FULL_REFRESH_DAYS * 24 * MS_H;
  return fullDue ? { depth: reviewsFullDepth(env), full: true } : { depth: reviewsDailyDepth(env), full: false };
}

/** A pending task we can still collect (same task, not too old). Pure. */
export function pendingTask(project, now = new Date()) {
  if (!project.gmbReviewsTaskId || !project.gmbReviewsTaskAt) return null;
  if (now.getTime() - new Date(project.gmbReviewsTaskAt).getTime() > PENDING_TASK_MAX_AGE_MS) return null;
  const depth = project.gmbReviewsTaskDepth || reviewsDailyDepth();
  return { taskId: project.gmbReviewsTaskId, depth, full: depth >= reviewsFullDepth(), reused: true };
}

/** Step 1 (DataForSEO): refresh the public profile when due. Never throws. */
export async function dfsProfileStep(project, { now = new Date(), force = false, fetchInfo = fetchGmbInfoDfs } = {}) {
  const id = dfsIdentifierForProject(project);
  if (!id.identifier) return { status: 'skipped', reason: 'no_gmb_identifier' };
  if (!profileDue(project, { now, force })) return { status: 'fresh' };
  try {
    const info = await fetchInfo({ identifier: id.identifier, locationCode: dfsLocationCode(project), languageCode: dfsLanguageCode(project) });
    if (!info) {
      await prisma.project.update({ where: { id: project.id }, data: { gmbSyncError: 'Business not found for the saved identifier', gmbProfileSyncedAt: now } });
      return { status: 'not_found', costUsd: null };
    }
    // Every response is persisted, ids included. A legacy name keyword thereby becomes the CID of the business that
    // name resolved to (the one whose data was already being shown); it stays unverified until someone confirms it.
    const data = identityDataFromProfile(info, { source: 'dataforseo', now, setName: !project.gmbLocationName });
    await prisma.project.update({ where: { id: project.id }, data: { ...data, gmbSyncError: null } });
    return { status: 'ok', profile: { title: info.title, rating: info.rating, reviewsCount: info.reviewsCount, cid: info.cid }, costUsd: info.costUsd ?? null };
  } catch (err) {
    await prisma.project.update({ where: { id: project.id }, data: { gmbSyncError: `Profile: ${String(err.message || 'failed').slice(0, 280)}` } }).catch(() => null);
    return { status: 'error', error: err.message, accountLevel: !!err.accountLevel };
  }
}

/** Step 2 (DataForSEO): post a reviews task, or reuse a pending one. Never throws. → task | { status } */
export async function dfsReviewsPost(project, { now = new Date(), forceFull = false, postTask = postReviewsTask } = {}) {
  const pending = pendingTask(project, now);
  if (pending) return { status: 'posted', ...pending };
  const id = dfsIdentifierForProject(project);
  if (!id.identifier) return { status: 'skipped', reason: 'no_gmb_identifier' };
  const plan = reviewsPlan(project, { now, forceFull });
  try {
    const { taskId, costUsd } = await postTask({
      cid: id.cid,
      placeId: id.placeId,
      keyword: id.kind === 'name' ? id.identifier : null,
      locationCode: dfsLocationCode(project),
      languageCode: dfsLanguageCode(project),
      depth: plan.depth,
    });
    await prisma.project.update({
      where: { id: project.id },
      data: { gmbReviewsTaskId: taskId, gmbReviewsTaskAt: now, gmbReviewsTaskDepth: plan.depth },
    });
    return { status: 'posted', taskId, depth: plan.depth, full: plan.full, reused: false, costUsd };
  } catch (err) {
    await prisma.project.update({ where: { id: project.id }, data: { gmbSyncError: `Reviews: ${String(err.message || 'failed').slice(0, 280)}` } }).catch(() => null);
    return { status: 'error', error: err.message, accountLevel: !!err.accountLevel };
  }
}

/** Step 3 (DataForSEO): collect a posted task and store the reviews. Never throws. */
export async function dfsReviewsCollect(project, task, { now = new Date(), poll = pollReviewsTask } = {}) {
  let r;
  try {
    r = await poll(task.taskId);
  } catch (err) {
    // A failed task is dropped (a new one is posted next run); the error is recorded.
    await prisma.project.update({
      where: { id: project.id },
      data: { gmbReviewsTaskId: null, gmbReviewsTaskAt: null, gmbReviewsTaskDepth: null, gmbSyncError: `Reviews: ${String(err.message || 'failed').slice(0, 280)}` },
    }).catch(() => null);
    return { status: 'error', error: err.message };
  }
  if (r.state === 'pending') return { status: 'pending', taskId: task.taskId };
  const reviews = r.reviews || [];
  const stored = await storeReviews(project.id, reviews, {
    source: 'dataforseo',
    now,
    full: task.full,
    complete: task.full && reviews.length < task.depth,
  });
  const data = { gmbReviewsTaskId: null, gmbReviewsTaskAt: null, gmbReviewsTaskDepth: null, gmbLastSyncedAt: now };
  if (task.full) data.gmbReviewsFullAt = now;
  await prisma.project.update({ where: { id: project.id }, data });
  return { status: 'ok', reviews: reviews.length, ...stored };
}

/**
 * DataForSEO path for one project: profile + reviews (post, then poll). Does not populate GmbDailyMetric (owner-only
 * performance metrics are native-only).
 */
export async function syncGmbProjectViaDataForSeo(project, opts = {}) {
  const now = opts.now || new Date();
  const id = dfsIdentifierForProject(project);
  if (!id.identifier) {
    return { projectId: project.id, status: 'skipped', source: 'dataforseo', reason: 'no_gmb_identifier' };
  }
  const profile = await dfsProfileStep(project, { now, force: opts.forceProfile, fetchInfo: opts.fetchInfo });
  if (profile.accountLevel) {
    return { projectId: project.id, status: 'error', source: 'dataforseo', error: profile.error, accountLevel: true, metricsLimited: true };
  }
  const task = await dfsReviewsPost(project, { now, forceFull: opts.forceFull, postTask: opts.postTask });
  let reviews = { status: task.status, error: task.error };
  if (task.status === 'posted') reviews = await dfsReviewsCollect(project, task, { now, poll: opts.poll });
  return summarize(project, id.identifier, profile, task, reviews);
}

function summarize(project, identifier, profile, task, reviews) {
  const failed = reviews.status === 'error' && profile.status !== 'ok' && profile.status !== 'fresh';
  return {
    projectId: project.id,
    status: failed ? 'error' : 'ok',
    source: 'dataforseo',
    days: 0,
    reviews: reviews.reviews || 0,
    reviewsStatus: reviews.status,
    removed: reviews.removed || 0,
    fullRefresh: !!task.full,
    identifier,
    profile: profile.profile || null,
    profileStatus: profile.status,
    error: failed ? reviews.error || profile.error : undefined,
    infoError: profile.status === 'error' ? profile.error : null,
    costUsd: [profile.costUsd, task.costUsd].reduce((s, c) => (typeof c === 'number' ? s + c : s), 0),
    metricsLimited: true,
  };
}

/** Native Business Profile API path. Returns null when it produced nothing (caller may fall back to DataForSEO). */
async function syncGmbProjectNative(project, { now }) {
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);

  let days = 0;
  try {
    const series = await fetchGmbDailyMetrics(project.gmbLocationId, start, end);
    for (const row of series) {
      const date = new Date(`${row.date}T00:00:00.000Z`);
      const vals = {
        impressions: row.impressions,
        impressionsSearch: row.impressionsSearch,
        impressionsMaps: row.impressionsMaps,
        websiteClicks: row.websiteClicks,
        directions: row.directions,
        calls: row.calls,
      };
      await prisma.gmbDailyMetric.upsert({
        where: { projectId_date: { projectId: project.id, date } },
        create: { projectId: project.id, date, ...vals },
        update: vals,
      });
      days++;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[gmbSync] metrics failed for ${project.id}: ${err.message}`);
  }

  let reviews = 0;
  let summary = null;
  try {
    summary = await fetchGmbReviewsWithSummary(project.gmbAccountId || '', project.gmbLocationId);
    reviews = summary.reviews.length;
    await storeReviews(project.id, summary.reviews, { source: 'google', now, full: !!summary.complete, complete: !!summary.complete });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[gmbSync] reviews failed for ${project.id}: ${err.message}`);
  }
  if (days === 0 && reviews === 0) return null;

  const data = { gmbLastSyncedAt: now, gmbSyncError: null };
  if (summary) {
    Object.assign(
      data,
      identityDataFromProfile({ rating: summary.averageRating, reviewsCount: summary.totalReviewCount }, { source: 'native', now })
    );
  }
  await prisma.project.update({ where: { id: project.id }, data });
  return { projectId: project.id, status: 'ok', source: 'google', days, reviews, rangeEnd: fmt(end) };
}

function dfsAvailableFor(project) {
  return BUSINESS_DATA_PROVIDER !== 'google' && !!dfsIdentifierForProject(project).identifier && hasRealBusinessDataProvider();
}

export async function syncGmbProject(project, opts = {}) {
  const now = opts.now || new Date();
  // 'auto' prefers native when a location is bound, else falls back to DataForSEO when a CID / place_id / legacy
  // identifier is present. A native binding keeps its CID, so the fallback stays available.
  const dfsAvailable = dfsAvailableFor(project);

  if (BUSINESS_DATA_PROVIDER === 'dataforseo') {
    if (!dfsAvailable) {
      return { projectId: project.id, status: 'skipped', reason: dfsIdentifierForProject(project).identifier ? 'no_dataforseo_creds' : 'no_gmb_cid' };
    }
    return syncGmbProjectViaDataForSeo(project, { ...opts, now });
  }

  if (!project.gmbLocationId) {
    if (dfsAvailable) return syncGmbProjectViaDataForSeo(project, { ...opts, now });
    return { projectId: project.id, status: 'skipped', reason: 'no_gmb_binding' };
  }

  const native = await syncGmbProjectNative(project, { now });
  if (native) return native;
  // Native path produced nothing (e.g. Business Profile API quota is 0): fall back to DataForSEO.
  if (dfsAvailable) {
    // eslint-disable-next-line no-console
    console.warn(`[gmbSync] native GMB empty for ${project.id}, falling back to DataForSEO`);
    return syncGmbProjectViaDataForSeo(project, { ...opts, now });
  }
  await prisma.project.update({ where: { id: project.id }, data: { gmbLastSyncedAt: now } });
  return { projectId: project.id, status: 'ok', source: 'google', days: 0, reviews: 0 };
}

/**
 * Nightly / manual run over every bound project. DataForSEO projects: profile + task post for all first, then
 * collect, so the queue wait overlaps. An account-level DataForSEO error stops further DataForSEO calls in this run.
 */
export async function runGmbSync({ now = new Date() } = {}) {
  const projects = await prisma.project.findMany({
    where: {
      OR: [{ gmbLocationId: { not: null } }, { gmbCid: { not: null } }, { gmbPlaceId: { not: null } }],
    },
    select: GMB_SYNC_PROJECT_SELECT,
  });
  const details = [];
  const dfsQueue = [];
  let dfsStopped = null;
  for (const p of projects) {
    try {
      const native = !!p.gmbLocationId && BUSINESS_DATA_PROVIDER !== 'dataforseo';
      if (native) {
        const out = await syncGmbProjectNative(p, { now });
        if (out) {
          details.push(out);
          continue;
        }
      }
      if (!dfsAvailableFor(p)) {
        details.push({ projectId: p.id, status: 'skipped', reason: native ? 'native_empty_no_dfs' : 'no_gmb_binding_or_creds' });
        continue;
      }
      if (dfsStopped) {
        details.push({ projectId: p.id, status: 'skipped', source: 'dataforseo', reason: 'dataforseo_account_error' });
        continue;
      }
      const profile = await dfsProfileStep(p, { now });
      if (profile.accountLevel) {
        dfsStopped = profile.error;
        details.push({ projectId: p.id, status: 'error', source: 'dataforseo', error: profile.error });
        continue;
      }
      const task = await dfsReviewsPost(p, { now });
      if (task.accountLevel) dfsStopped = task.error;
      dfsQueue.push({ p, profile, task });
    } catch (err) {
      details.push({ projectId: p.id, status: 'error', error: err.message, source: 'unknown' });
    }
  }
  for (const { p, profile, task } of dfsQueue) {
    try {
      let reviews = { status: task.status, error: task.error };
      if (task.status === 'posted') reviews = await dfsReviewsCollect(p, task, { now });
      details.push(summarize(p, dfsIdentifierForProject(p).identifier, profile, task, reviews));
    } catch (err) {
      details.push({ projectId: p.id, status: 'error', error: err.message, source: 'dataforseo' });
    }
  }
  return {
    total: projects.length,
    success: details.filter((d) => d.status === 'ok').length,
    errors: details.filter((d) => d.status === 'error').length,
    skipped: details.filter((d) => d.status === 'skipped').length,
    pendingReviewTasks: details.filter((d) => d.reviewsStatus === 'pending').length,
    costUsd: Number(details.reduce((s, d) => s + (d.costUsd || 0), 0).toFixed(5)),
    details,
  };
}
