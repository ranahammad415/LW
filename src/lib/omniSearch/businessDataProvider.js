/**
 * DataForSEO Business Data provider (Google Business Profile).
 *
 * Interim source for GMB info + reviews + ratings while the native Google
 * Business Profile API quota (currently 0) is pending approval. Used by the
 * GMB sync when a project is bound via a manual identifier (gmbCid) rather than
 * a native Business Profile location.
 *
 * The `identifier` can be a Google CID (e.g. "cid:123..."), a "place_id:..."
 * string, or a plain business-name keyword.
 *
 * Note: DataForSEO exposes only PUBLIC profile data (info, rating, reviews).
 * Owner-only performance metrics (impressions, calls, directions) are not
 * available here — those require the native Business Profile API.
 */

import { postDataForSeo, getDataForSeo } from '../dataforseo/client.js';

const DEFAULT_LOCATION_CODE = 2840; // United States

function locationCode() {
  const raw = process.env.GMB_DFS_LOCATION_CODE;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : DEFAULT_LOCATION_CODE;
}

/**
 * Fetch public Business Profile info (title, address, rating, review count).
 * Uses the instant "live" endpoint.
 */
export async function fetchGmbInfo({ identifier, locationCode: loc } = {}) {
  if (!identifier) throw new Error('Missing GMB identifier');
  const payload = await postDataForSeo(
    '/v3/business_data/google/my_business_info/live',
    [
      {
        keyword: identifier,
        location_code: loc || locationCode(),
        language_code: 'en',
      },
    ],
  );
  const item = payload?.tasks?.[0]?.result?.[0]?.items?.[0] || null;
  if (!item) return null;
  return {
    title: item.title || null,
    address: item.address || null,
    rating: item.rating?.value ?? null,
    reviewsCount: item.rating?.votes_count ?? null,
    cid: item.cid || null,
    dataSource: 'dataforseo',
  };
}

/**
 * Fetch individual reviews for a business. Task-based: POST then poll GET.
 * Returns reviews normalized to the GmbReview shape.
 */
export async function fetchGmbReviews({ identifier, locationCode: loc, depth = 100 } = {}) {
  if (!identifier) throw new Error('Missing GMB identifier');

  const postPayload = await postDataForSeo(
    '/v3/business_data/google/reviews/task_post',
    [
      {
        keyword: identifier,
        location_code: loc || locationCode(),
        language_code: 'en',
        depth,
        sort_by: 'newest',
      },
    ],
  );
  const taskId = postPayload?.tasks?.[0]?.id;
  if (!taskId) throw new Error('DataForSEO reviews task_post returned no task id');

  const result = await pollReviewsTask(taskId);
  const items = result?.items || [];
  return items.map(normalizeReview).filter((r) => r.reviewId && r.starRating);
}

async function pollReviewsTask(taskId, { attempts = 12, delayMs = 5000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const payload = await getDataForSeo(
      `/v3/business_data/google/reviews/task_get/${taskId}`,
    );
    const task = payload?.tasks?.[0];
    const statusCode = task?.status_code;
    // 20000 = ok / ready; 40602 = task in queue / not ready yet
    if (statusCode === 20000 && task?.result?.[0]) {
      return task.result[0];
    }
    if (statusCode && statusCode >= 40000 && statusCode !== 40602) {
      throw new Error(`DataForSEO reviews task_get ${statusCode}: ${task?.status_message}`);
    }
    await sleep(delayMs);
  }
  throw new Error('DataForSEO reviews task timed out');
}

function normalizeReview(item) {
  const rating = item?.rating?.value ?? item?.rating ?? null;
  return {
    reviewId: item?.review_id || item?.id || null,
    reviewerName: item?.profile_name || item?.reviewer?.name || null,
    starRating: typeof rating === 'number' ? Math.round(rating) : null,
    comment: item?.review_text || item?.text || null,
    replyComment: item?.owner_answer || item?.responses?.[0]?.text || null,
    createTime: parseDate(item?.timestamp || item?.time),
    updateTime: parseDate(item?.timestamp || item?.time),
  };
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
