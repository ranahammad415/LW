/**
 * Shared Google Business Profile figures for the analytics views, snapshots, AI report facts and health
 * (docs/ledger/features/local-seo.md §Rating and missing data).
 *
 * - Rating and TOTAL review count come from the stored profile (Project.gmbRating / gmbReviewsCount, DataForSEO or
 *   native), never from the stored-review sample (which is capped by the fetch depth).
 * - Stored reviews are used only for PERIOD figures: new reviews in the period, reply rate, average of those reviews.
 * - Owner metrics (impressions, calls, directions, website clicks) exist only with the native Business Profile API.
 *   Without it they are null (not 0) and `metricsLimited` is true.
 */

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** Profile rating (review-count weighted across projects) and total review count. Pure. */
export function profileTotals(projects) {
  let weighted = 0;
  let weight = 0;
  let total = 0;
  let anyTotal = false;
  let unweighted = [];
  for (const p of projects || []) {
    const rating = typeof p?.gmbRating === 'number' ? p.gmbRating : p?.gmbRating != null ? Number(p.gmbRating) : null;
    const count = typeof p?.gmbReviewsCount === 'number' ? p.gmbReviewsCount : null;
    if (count != null) {
      total += count;
      anyTotal = true;
    }
    if (rating != null && Number.isFinite(rating)) {
      if (count && count > 0) {
        weighted += rating * count;
        weight += count;
      } else {
        unweighted.push(rating);
      }
    }
  }
  const rating = weight > 0 ? weighted / weight : unweighted.length ? unweighted.reduce((s, v) => s + v, 0) / unweighted.length : null;
  return { rating: r1(rating), reviewsCount: anyTotal ? total : null };
}

function inRange(d, start, end) {
  if (!d) return false;
  const t = new Date(d).getTime();
  return t >= new Date(start).getTime() && t <= new Date(end).getTime() + 86_400_000 - 1;
}

/** New reviews, reply rate (%) and average stars of the reviews created in [start, end] (dates inclusive). Pure. */
export function periodReviewStats(reviews, start, end) {
  const list = (reviews || []).filter((r) => !r.removedAt && inRange(r.createTime, start, end));
  const replied = list.filter((r) => r.replyComment && String(r.replyComment).trim()).length;
  return {
    newReviews: list.length,
    replyRate: list.length ? Math.round((replied / list.length) * 100) : null,
    periodRating: list.length ? r1(list.reduce((s, r) => s + (Number(r.starRating) || 0), 0) / list.length) : null,
  };
}

export const OWNER_METRIC_KEYS = Object.freeze(['impressions', 'directions', 'websiteClicks', 'calls']);
export const METRICS_LIMITED_NOTE = 'Available once Google Business Profile access is connected';
