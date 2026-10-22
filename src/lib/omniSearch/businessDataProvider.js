/**
 * DataForSEO Business Data + Maps provider (Google Business Profile, public data).
 *
 * Interim source for GBP info, reviews and ratings while the native Google Business Profile API is not approved, and a
 * permanent fallback after (docs/ledger/features/local-seo.md). Public data only: owner metrics (impressions, calls,
 * directions, website clicks) need the native API.
 *
 * Endpoints (DataForSEO v3, checked against docs.dataforseo.com 2026-10-22):
 * - POST /v3/business_data/google/my_business_info/live   one task per call; keyword may be "cid:<n>" / "place_id:<id>"
 * - POST /v3/serp/google/maps/live/advanced               Find business candidates (billed per SERP of ≤ 100 results)
 * - POST /v3/business_data/google/reviews/task_post       no live endpoint exists for Google reviews; `cid` / `place_id`
 *   GET  /v3/business_data/google/reviews/task_get/{id}    / `keyword`, depth (billed per 10 reviews), sort_by newest
 *
 * Reviews use task_post + task_get by the stored task id (not tasks_ready, which lists every ready task of the account
 * across features): standard priority (cheapest), the id is kept on the project (gmbReviewsTaskId) so a run that times
 * out collects the same paid task next time instead of posting a new one. task_get is not billed.
 * Task status: 20000 = done, 40601 "Task Handed" / 40602 "Task in Queue" = still pending, anything else = failed.
 */

import { dfsPostTask, dfsGetTask, DataForSeoError } from '../dataforseo/client.js';

const DEFAULT_LOCATION_CODE = 2840; // United States

export const DFS_INFO_PATH = '/v3/business_data/google/my_business_info/live';
export const DFS_MAPS_PATH = '/v3/serp/google/maps/live/advanced';
export const DFS_REVIEWS_POST_PATH = '/v3/business_data/google/reviews/task_post';
export const DFS_REVIEWS_GET_PATH = '/v3/business_data/google/reviews/task_get';

/** Poll back-off for a reviews task (seconds): ~3 minutes in total, then the task id is kept for the next run. */
export const REVIEWS_POLL_DELAYS_S = Object.freeze([5, 10, 15, 20, 30, 30, 30, 40]);

/** Project location_code → GMB_DFS_LOCATION_CODE env → United States. */
export function locationCode(project = null, env = process.env) {
  const own = Number(project?.localLocationCode);
  if (Number.isInteger(own) && own > 0) return own;
  const raw = env.GMB_DFS_LOCATION_CODE;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOCATION_CODE;
}

export function languageCode(project = null) {
  const l = String(project?.localLanguageCode || '').trim().toLowerCase();
  return /^[a-z]{2}(-[a-z]{2,4})?$/.test(l) ? l : 'en';
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max = 500) => (v == null || v === '' ? null : String(v).slice(0, max));

/** Normalise one my_business_info / maps item into the identity fields we persist. Pure. */
export function profileFromItem(item) {
  if (!item || typeof item !== 'object') return null;
  const cid = item.cid != null && /^\d+$/.test(String(item.cid)) ? String(item.cid) : null;
  return {
    title: str(item.title, 255),
    address: str(item.address, 500),
    phone: str(item.phone, 50),
    url: str(item.url, 500),
    domain: str(item.domain, 255),
    category: str(item.category, 255),
    rating: num(item.rating?.value),
    reviewsCount: num(item.rating?.votes_count) != null ? Math.round(item.rating.votes_count) : null,
    cid,
    placeId: str(item.place_id, 255),
    featureId: str(item.feature_id, 100),
    lat: num(item.latitude),
    lng: num(item.longitude),
    isClaimed: typeof item.is_claimed === 'boolean' ? item.is_claimed : null,
    dataSource: 'dataforseo',
  };
}

/**
 * Fetch public Business Profile info (title, address, rating, review count, ids, coordinates).
 * Uses the instant "live" endpoint. Returns the profile (+ costUsd) or null when DataForSEO found nothing.
 */
export async function fetchGmbInfo({ identifier, locationCode: loc, languageCode: lang, post } = {}) {
  if (!identifier) throw new Error('Missing GMB identifier');
  const parsed = await dfsPostTask(
    DFS_INFO_PATH,
    { keyword: identifier, location_code: loc || locationCode(), language_code: lang || 'en' },
    { post }
  );
  if (parsed.state !== 'ok') return null;
  const item = parsed.result?.items?.[0] || null;
  if (!item) return null;
  return { ...profileFromItem(item), costUsd: parsed.costUsd };
}

/**
 * Find-business candidates for a name (+ city) through a Google Maps search. Up to `limit` (≤ 5) items with
 * title, address, phone, rating, website, cid, place_id. One Maps SERP call (depth 20).
 */
export async function searchBusinessCandidates({ query, locationCode: loc, languageCode: lang, limit = 5, post } = {}) {
  const keyword = String(query || '').trim().slice(0, 200);
  if (!keyword) throw new Error('Missing business name');
  const parsed = await dfsPostTask(
    DFS_MAPS_PATH,
    { keyword, location_code: loc || locationCode(), language_code: lang || 'en', depth: 20 },
    { post }
  );
  const items = parsed.state === 'ok' ? parsed.result?.items || [] : [];
  const out = [];
  for (const it of items) {
    if (it?.type && it.type !== 'maps_search') continue;
    const p = profileFromItem(it);
    if (p && (p.cid || p.placeId)) out.push(p);
    if (out.length >= Math.min(5, limit)) break;
  }
  return { candidates: out, costUsd: parsed.costUsd };
}

/** Task body for a reviews task: cid first, then place_id, then the keyword. */
export function reviewsTaskBody({ cid, placeId, keyword, locationCode: loc, languageCode: lang, depth }) {
  const body = { location_code: loc || locationCode(), language_code: lang || 'en', depth, sort_by: 'newest' };
  if (cid) body.cid = String(cid);
  else if (placeId) body.place_id = String(placeId);
  else if (keyword) body.keyword = String(keyword).slice(0, 700);
  else throw new Error('Missing GMB identifier');
  return body;
}

/** POST a reviews task (charged). Returns { taskId, costUsd }. */
export async function postReviewsTask(args, { post } = {}) {
  const parsed = await dfsPostTask(DFS_REVIEWS_POST_PATH, reviewsTaskBody(args), { post });
  const taskId = parsed.task?.id;
  if (!taskId) throw new DataForSeoError('DataForSEO reviews task_post returned no task id', { costUsd: parsed.costUsd });
  return { taskId: String(taskId), costUsd: parsed.costUsd };
}

/** One task_get. → { state: 'ok'|'pending'|'no_results', reviews?, total? } (throws on a failed task). */
export async function getReviewsTask(taskId, { get } = {}) {
  if (!/^[\w-]{8,64}$/.test(String(taskId || ''))) throw new Error('Invalid task id');
  const parsed = await dfsGetTask(`${DFS_REVIEWS_GET_PATH}/${taskId}`, { get });
  if (parsed.state === 'pending') return { state: 'pending' };
  if (parsed.state === 'no_results') return { state: 'no_results', reviews: [], total: 0 };
  const result = parsed.result;
  if (!result) return { state: 'pending' };
  const reviews = (result.items || []).map(normalizeReview).filter((r) => r.reviewId && r.starRating);
  return {
    state: 'ok',
    reviews,
    total: num(result.reviews_count),
    rating: num(result.rating?.value),
  };
}

/**
 * Poll a reviews task with back-off until it is done or the budget runs out. 40601 / 40602 = pending. Never re-posts.
 * → { state: 'ok'|'no_results', reviews, total } | { state: 'pending' } (caller keeps the task id for the next run).
 */
export async function pollReviewsTask(taskId, { get, delaysS = REVIEWS_POLL_DELAYS_S, sleep = defaultSleep } = {}) {
  for (let i = 0; i <= delaysS.length; i += 1) {
    const r = await getReviewsTask(taskId, { get });
    if (r.state !== 'pending') return r;
    if (i < delaysS.length) await sleep(delaysS[i] * 1000);
  }
  return { state: 'pending' };
}

/**
 * Legacy one-shot helper: post + poll. Returns reviews normalised to the GmbReview shape.
 * New code uses postReviewsTask / pollReviewsTask (gmbSync keeps pending task ids).
 */
export async function fetchGmbReviews({ identifier, cid, placeId, locationCode: loc, languageCode: lang, depth = 100, post, get, sleep } = {}) {
  const fromId = String(identifier || '');
  const args = {
    cid: cid || (/^cid:/i.test(fromId) ? fromId.slice(4) : null),
    placeId: placeId || (/^place_id:/i.test(fromId) ? fromId.slice(9) : null),
    keyword: identifier,
    locationCode: loc,
    languageCode: lang,
    depth,
  };
  const { taskId } = await postReviewsTask(args, { post });
  const r = await pollReviewsTask(taskId, { get, sleep });
  if (r.state === 'pending') throw new Error('DataForSEO reviews task still pending');
  return r.reviews || [];
}

export function normalizeReview(item) {
  const rating = item?.rating?.value ?? item?.rating ?? null;
  return {
    reviewId: item?.review_id || item?.id || null,
    reviewerName: item?.profile_name || item?.reviewer?.name || null,
    starRating: typeof rating === 'number' ? Math.round(rating) : null,
    comment: item?.review_text ?? item?.original_review_text ?? item?.text ?? null,
    replyComment: item?.owner_answer || item?.responses?.[0]?.text || null,
    createTime: parseDate(item?.timestamp || item?.time),
    updateTime: parseDate(item?.timestamp || item?.time),
  };
}

function parseDate(value) {
  if (!value) return null;
  // DataForSEO: "2023-03-10 09:12:44 +00:00"
  const s = String(value).replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2}:\d{2})$/, '$1T$2$3');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
